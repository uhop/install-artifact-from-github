import test from 'tape-six';
import {promises as fsp} from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import zlib from 'node:zlib';
import {promisify} from 'node:util';

import {startMockServer} from './helpers/mock-server.js';
import {runBin, makeSandbox} from './helpers/run-bin.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const PM_STUB = path.join(__dirname, 'fixtures', 'pm-stub.js');

const brotli = promisify(zlib.brotliCompress);

const VERSION = '1.0.0';
const isWindows = process.platform === 'win32';

// No platform pins here, so the verification step runs and the asset is named after the host's
// own slot; a musl twin is staged too, so the same fixture serves an Alpine runner.
const hostSlots = () => {
  const tail = `-${process.arch}-${process.versions.modules}`;
  return process.platform === 'linux' ? [`linux${tail}`, `linux-musl${tail}`] : [`${process.platform}${tail}`];
};

const stageAsset = async server => {
  const body = await brotli(Buffer.from('verified-by-the-running-manager'));
  for (const slot of hostSlots()) server.setAsset(`/owner/repo/releases/download/${VERSION}/${slot}.br`, body);
};

const baseEnv = (server, record) => ({
  npm_package_github: 'owner/repo',
  npm_package_version: VERSION,
  npm_package_scripts_verify_build: 'node verify.js',
  DOWNLOAD_HOST: server.url,
  PM_RECORD: record
});

const runInstall = (sandbox, env) => runBin('install-from-cache.js', {cwd: sandbox.dir, args: ['--artifact', 'out/artifact.bin'], env});

const readCalls = async record => (await fsp.readFile(record, 'utf8')).trim().split('\n').map(JSON.parse);

// A manager that is not a node script (pnpm's and bun's binaries, Yarn Berry's wrapper).
const writeWrapper = async (dir, name) => {
  await fsp.mkdir(dir, {recursive: true});
  const file = path.join(dir, isWindows ? `${name}.cmd` : name);
  const body = isWindows ? `@"${process.execPath}" "${PM_STUB}" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${PM_STUB}" "$@"\n`;
  await fsp.writeFile(file, body, {mode: 0o755});
  return file;
};

test('install-from-cache: verify-build runs through the node script named by npm_execpath', async t => {
  const server = await startMockServer();
  const sandbox = await makeSandbox();
  const record = path.join(sandbox.dir, 'pm.jsonl');
  try {
    await stageAsset(server);
    const r = await runInstall(sandbox, {...baseEnv(server, record), npm_execpath: PM_STUB});
    t.equal(r.code, 0, `bin exited 0 (stdout=${r.stdout} stderr=${r.stderr})`);
    t.ok(r.stdout.includes('Done.'), 'reports Done.');
    const calls = await readCalls(record);
    t.deepEqual(
      calls.map(c => c.args),
      [['run', 'verify-build']],
      'exactly one manager call: run verify-build'
    );
    t.equal(calls[0].cwd, sandbox.dir, 'the script runs in the addon directory');
  } finally {
    await server.close();
    await sandbox.cleanup();
  }
});

test('install-from-cache: a failed verify-build rebuilds through the same manager', async t => {
  const server = await startMockServer();
  const sandbox = await makeSandbox();
  const record = path.join(sandbox.dir, 'pm.jsonl');
  try {
    await stageAsset(server);
    const r = await runInstall(sandbox, {...baseEnv(server, record), npm_execpath: PM_STUB, PM_FAIL: 'verify-build'});
    t.equal(r.code, 0, `rebuild stub exited 0 (stdout=${r.stdout} stderr=${r.stderr})`);
    t.ok(r.stdout.includes('The verification has failed'), 'announced the failed verification');
    t.ok(r.stdout.includes('Building locally'), 'announced the fallback');
    const calls = await readCalls(record);
    t.deepEqual(
      calls.map(c => c.args),
      [
        ['run', 'verify-build'],
        ['run', 'rebuild']
      ],
      'verify-build, then rebuild, both through the manager'
    );
  } finally {
    await server.close();
    await sandbox.cleanup();
  }
});

test('install-from-cache: the test script is run as `run test`, never as a bare `test`', async t => {
  // `bun test` is bun's own test runner; only `run test` names the package.json script everywhere.
  const server = await startMockServer();
  const sandbox = await makeSandbox();
  const record = path.join(sandbox.dir, 'pm.jsonl');
  try {
    await stageAsset(server);
    const env = {...baseEnv(server, record), npm_execpath: PM_STUB, npm_package_scripts_test: 'node test.js'};
    delete env.npm_package_scripts_verify_build;
    const r = await runInstall(sandbox, env);
    t.equal(r.code, 0, `bin exited 0 (stdout=${r.stdout} stderr=${r.stderr})`);
    const calls = await readCalls(record);
    t.deepEqual(
      calls.map(c => c.args),
      [['run', 'test']],
      'the test script is addressed through run'
    );
  } finally {
    await server.close();
    await sandbox.cleanup();
  }
});

test('install-from-cache: a manager binary named by npm_execpath is spawned as is', async t => {
  const server = await startMockServer();
  const sandbox = await makeSandbox();
  const record = path.join(sandbox.dir, 'pm.jsonl');
  try {
    await stageAsset(server);
    const wrapper = await writeWrapper(path.join(sandbox.dir, 'pm-home'), 'pm');
    const r = await runInstall(sandbox, {...baseEnv(server, record), npm_execpath: wrapper});
    t.equal(r.code, 0, `bin exited 0 (stdout=${r.stdout} stderr=${r.stderr})`);
    t.ok(r.stdout.includes('Done.'), 'reports Done.');
    const calls = await readCalls(record);
    t.deepEqual(
      calls.map(c => c.args),
      [['run', 'verify-build']],
      'the binary received run verify-build'
    );
  } finally {
    await server.close();
    await sandbox.cleanup();
  }
});

test('install-from-cache: without npm_execpath, npm is called by name', async t => {
  const server = await startMockServer();
  const sandbox = await makeSandbox();
  const record = path.join(sandbox.dir, 'pm.jsonl');
  try {
    await stageAsset(server);
    const binDir = path.join(sandbox.dir, 'fake-path');
    await writeWrapper(binDir, 'npm');
    const r = await runInstall(sandbox, {...baseEnv(server, record), PATH: `${binDir}${path.delimiter}${process.env.PATH}`});
    t.equal(r.code, 0, `bin exited 0 (stdout=${r.stdout} stderr=${r.stderr})`);
    t.ok(r.stdout.includes('Done.'), 'reports Done.');
    const calls = await readCalls(record);
    t.deepEqual(
      calls.map(c => c.args),
      [['run', 'verify-build']],
      'the npm on PATH received run verify-build'
    );
  } finally {
    await server.close();
    await sandbox.cleanup();
  }
});

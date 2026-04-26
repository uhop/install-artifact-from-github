import test from 'tape-six';
import {promises as fsp} from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {promisify} from 'node:util';

import {startMockServer} from './helpers/mock-server.js';
import {runBin, makeSandbox} from './helpers/run-bin.js';

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

const PLATFORM = 'linux';
const ARCH = 'x64';
const ABI = '108';
const PREFIX = 'testpkg-';
const SUFFIX = '.bin';
const ASSET = `${PREFIX}${PLATFORM}-${ARCH}-${ABI}${SUFFIX}`;
const VERSION = '1.0.0';
const ASSET_PATH = `/owner/repo/releases/download/${VERSION}/${ASSET}`;

// Common env that pins platform (and thereby skips the build-verification step
// inside install-from-cache) and points the bin at our mock server.
const installEnv = host => ({
  npm_config_platform: PLATFORM,
  npm_config_platform_arch: ARCH,
  npm_config_platform_abi: ABI,
  npm_package_github: 'owner/repo',
  npm_package_version: VERSION,
  DOWNLOAD_HOST: host
});

const runInstall = async (server, sandbox, extraEnv = {}) => {
  return runBin('install-from-cache.js', {
    cwd: sandbox.dir,
    args: ['--artifact', 'out/artifact.bin', '--prefix', PREFIX, '--suffix', SUFFIX],
    env: {...installEnv(server.url), ...extraEnv}
  });
};

test('install-from-cache: brotli artifact wins when available', async t => {
  const server = await startMockServer();
  const sandbox = await makeSandbox();
  try {
    const payload = Buffer.from('hello-from-brotli');
    server.setAsset(ASSET_PATH + '.br', await brotli(payload));

    const r = await runInstall(server, sandbox);
    t.equal(r.code, 0, `bin exited 0 (stdout=${r.stdout})`);
    const written = await fsp.readFile(path.join(sandbox.dir, 'out/artifact.bin'));
    t.deepEqual(written, payload, 'artifact written matches the original payload');
    t.ok(r.stdout.includes('Done.'), 'reports Done.');
  } finally {
    await server.close();
    await sandbox.cleanup();
  }
});

test('install-from-cache: falls back to gzip when brotli is missing', async t => {
  const server = await startMockServer();
  const sandbox = await makeSandbox();
  try {
    const payload = Buffer.from('hello-from-gzip');
    server.setAsset(ASSET_PATH + '.gz', await gzip(payload));

    const r = await runInstall(server, sandbox);
    t.equal(r.code, 0, 'bin exited 0');
    const written = await fsp.readFile(path.join(sandbox.dir, 'out/artifact.bin'));
    t.deepEqual(written, payload, 'gzip-decoded payload matches');
  } finally {
    await server.close();
    await sandbox.cleanup();
  }
});

test('install-from-cache: falls back to uncompressed when br + gz are missing', async t => {
  const server = await startMockServer();
  const sandbox = await makeSandbox();
  try {
    const payload = Buffer.from('hello-uncompressed');
    server.setAsset(ASSET_PATH, payload);

    const r = await runInstall(server, sandbox);
    t.equal(r.code, 0, 'bin exited 0');
    const written = await fsp.readFile(path.join(sandbox.dir, 'out/artifact.bin'));
    t.deepEqual(written, payload, 'uncompressed payload matches');
  } finally {
    await server.close();
    await sandbox.cleanup();
  }
});

test('install-from-cache: format precedence — br beats gz beats none', async t => {
  const server = await startMockServer();
  const sandbox = await makeSandbox();
  try {
    server.setAsset(ASSET_PATH + '.br', await brotli(Buffer.from('B')));
    server.setAsset(ASSET_PATH + '.gz', await gzip(Buffer.from('G')));
    server.setAsset(ASSET_PATH, Buffer.from('U'));

    const r = await runInstall(server, sandbox);
    t.equal(r.code, 0, 'bin exited 0');
    const written = await fsp.readFile(path.join(sandbox.dir, 'out/artifact.bin'));
    t.equal(written.toString(), 'B', 'brotli copy wins');
  } finally {
    await server.close();
    await sandbox.cleanup();
  }
});

test('install-from-cache: no asset available → falls through to npm run rebuild', async t => {
  const server = await startMockServer();
  const sandbox = await makeSandbox();
  try {
    // No fixtures registered → server returns 404 for every variant.
    const r = await runInstall(server, sandbox);
    t.equal(r.code, 0, `rebuild stub exited 0 (stdout=${r.stdout})`);
    t.ok(r.stdout.includes('Building locally'), 'announced fallback');
    let exists = true;
    try {
      await fsp.access(path.join(sandbox.dir, 'out/artifact.bin'));
    } catch {
      exists = false;
    }
    t.notOk(exists, 'no artifact written when all formats 404');
  } finally {
    await server.close();
    await sandbox.cleanup();
  }
});

test('install-from-cache: --artifact missing → no download attempted, falls back to rebuild', async t => {
  const server = await startMockServer();
  const sandbox = await makeSandbox();
  try {
    server.setAsset(ASSET_PATH + '.br', await brotli(Buffer.from('should-not-be-fetched')));
    const r = await runBin('install-from-cache.js', {
      cwd: sandbox.dir,
      args: [], // no --artifact
      env: installEnv(server.url)
    });
    t.equal(r.code, 0, 'rebuild stub exited 0');
    t.ok(r.stdout.includes('No artifact path was specified'), 'logs the missing-flag reason');
    t.equal(server.recorded.length, 0, 'no upload calls (sanity)');
  } finally {
    await server.close();
    await sandbox.cleanup();
  }
});

test('install-from-cache: DEVELOPMENT_SKIP_GETTING_ASSET short-circuits the download', async t => {
  const server = await startMockServer();
  const sandbox = await makeSandbox();
  try {
    server.setAsset(ASSET_PATH + '.br', await brotli(Buffer.from('would-have-been-served')));
    const r = await runInstall(server, sandbox, {DEVELOPMENT_SKIP_GETTING_ASSET: '1'});
    t.equal(r.code, 0, 'rebuild stub exited 0');
    t.ok(r.stdout.includes('Development flag was detected'), 'logs the dev short-circuit');
    let exists = true;
    try {
      await fsp.access(path.join(sandbox.dir, 'out/artifact.bin'));
    } catch {
      exists = false;
    }
    t.notOk(exists, 'no artifact written in dev mode');
  } finally {
    await server.close();
    await sandbox.cleanup();
  }
});

test('install-from-cache: missing repo info → no download, falls back', async t => {
  const server = await startMockServer();
  const sandbox = await makeSandbox();
  try {
    const env = installEnv(server.url);
    delete env.npm_package_github;
    const r = await runBin('install-from-cache.js', {
      cwd: sandbox.dir,
      args: ['--artifact', 'out/artifact.bin', '--prefix', PREFIX, '--suffix', SUFFIX],
      env
    });
    t.equal(r.code, 0, 'rebuild stub exited 0');
    t.ok(r.stdout.includes('No github repository was identified'), 'logs the missing-repo reason');
  } finally {
    await server.close();
    await sandbox.cleanup();
  }
});

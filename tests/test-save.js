import test from 'tape-six';
import {promises as fsp} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {promisify} from 'node:util';

import {startMockServer} from './helpers/mock-server.js';
import {runBin} from './helpers/run-bin.js';

const brotliDecompress = promisify(zlib.brotliDecompress);
const gunzip = promisify(zlib.gunzip);

const TAG = '1.2.3';
const PREFIX = 'testpkg-';
const SUFFIX = '.bin';

const writeArtifact = async body => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'iafg-save-'));
  const file = path.join(dir, 'artifact.bin');
  await fsp.writeFile(file, body);
  return {dir, file, cleanup: () => fsp.rm(dir, {recursive: true, force: true})};
};

const saveEnv = host => ({
  GITHUB_API_URL: host,
  GITHUB_REPOSITORY: 'owner/repo',
  GITHUB_REF: `refs/tags/${TAG}`,
  GITHUB_TOKEN: 'fake-token-do-not-use'
});

test('save-to-github-cache: uploads brotli + gzip + uncompressed for --format br,gz,none', async t => {
  const server = await startMockServer();
  const payload = Buffer.from('hello-save-bin');
  const fixture = await writeArtifact(payload);
  try {
    const r = await runBin('save-to-github-cache.js', {
      args: ['--artifact', fixture.file, '--prefix', PREFIX, '--suffix', SUFFIX, '--format', 'br,gz,none'],
      env: saveEnv(server.url)
    });
    t.equal(r.code, 0, `bin exited 0 (stderr=${r.stderr})`);
    t.equal(server.recorded.length, 3, 'three uploads recorded');

    const byExt = Object.fromEntries(server.recorded.map(u => [path.extname(u.name), u]));
    t.ok(byExt['.br'], 'brotli upload present');
    t.ok(byExt['.gz'], 'gzip upload present');
    t.ok(byExt[''] || byExt[SUFFIX], 'uncompressed upload present');

    t.deepEqual(await brotliDecompress(byExt['.br'].body), payload, 'brotli payload round-trips');
    t.deepEqual(await gunzip(byExt['.gz'].body), payload, 'gzip payload round-trips');
    const uncompressed = byExt[SUFFIX] || byExt[''];
    t.deepEqual(uncompressed.body, payload, 'uncompressed body matches input');
  } finally {
    await server.close();
    await fixture.cleanup();
  }
});

test('save-to-github-cache: --format br only uploads the brotli variant', async t => {
  const server = await startMockServer();
  const payload = Buffer.from('only-brotli');
  const fixture = await writeArtifact(payload);
  try {
    const r = await runBin('save-to-github-cache.js', {
      args: ['--artifact', fixture.file, '--prefix', PREFIX, '--suffix', SUFFIX, '--format', 'br'],
      env: saveEnv(server.url)
    });
    t.equal(r.code, 0, 'bin exited 0');
    t.equal(server.recorded.length, 1, 'exactly one upload');
    t.ok(server.recorded[0].name.endsWith('.br'), 'it is the brotli one');
    t.deepEqual(await brotliDecompress(server.recorded[0].body), payload, 'payload round-trips');
  } finally {
    await server.close();
    await fixture.cleanup();
  }
});

test('save-to-github-cache: filename encodes platform + arch + abi', async t => {
  const server = await startMockServer();
  const payload = Buffer.from('platform-encoding-check');
  const fixture = await writeArtifact(payload);
  try {
    const r = await runBin('save-to-github-cache.js', {
      args: ['--artifact', fixture.file, '--prefix', PREFIX, '--suffix', SUFFIX, '--format', 'none'],
      env: saveEnv(server.url)
    });
    t.equal(r.code, 0, 'bin exited 0');
    t.equal(server.recorded.length, 1, 'one upload (uncompressed)');
    const name = server.recorded[0].name;
    t.ok(name.startsWith(PREFIX), 'name starts with prefix');
    t.ok(name.endsWith(SUFFIX), 'name ends with suffix');
    // Middle slot is platform-arch-abi; we don't pin to a specific one because
    // the test runs on whatever the host happens to be. Sanity-check that all
    // three slots are present (two hyphens between prefix and suffix).
    const middle = name.slice(PREFIX.length, name.length - SUFFIX.length);
    t.ok(middle.split('-').length >= 3, `platform-arch-abi triple present (${middle})`);
  } finally {
    await server.close();
    await fixture.cleanup();
  }
});

test('save-to-github-cache: --napi puts napi-v<level> in the upload filename', async t => {
  const server = await startMockServer();
  const payload = Buffer.from('napi-upload');
  const fixture = await writeArtifact(payload);
  try {
    const r = await runBin('save-to-github-cache.js', {
      args: ['--artifact', fixture.file, '--prefix', PREFIX, '--suffix', SUFFIX, '--format', 'br', '--napi', '8'],
      env: saveEnv(server.url)
    });
    t.equal(r.code, 0, `bin exited 0 (stderr=${r.stderr})`);
    t.equal(server.recorded.length, 1, 'one upload');
    const name = server.recorded[0].name;
    t.ok(name.includes('-napi-v8'), `filename contains napi-v8 slot (got ${name})`);
    t.notOk(/-\d+\.bin\.br$/.test(name), `filename does NOT contain a numeric ABI slot (got ${name})`);
  } finally {
    await server.close();
    await fixture.cleanup();
  }
});

test('save-to-github-cache: API 404 surfaces an error and exits non-zero', async t => {
  const server = await startMockServer({
    releaseHandler(_req, res) {
      res.writeHead(404);
      res.end('not found');
    }
  });
  const payload = Buffer.from('no-release-yet');
  const fixture = await writeArtifact(payload);
  try {
    const r = await runBin('save-to-github-cache.js', {
      args: ['--artifact', fixture.file, '--prefix', PREFIX, '--suffix', SUFFIX, '--format', 'br'],
      env: saveEnv(server.url)
    });
    t.notEqual(r.code, 0, `bin exited non-zero (got ${r.code})`);
    t.ok(/Status 404/.test(r.stdout + r.stderr), 'reports the 404');
    t.equal(server.recorded.length, 0, 'no uploads on lookup failure');
  } finally {
    await server.close();
    await fixture.cleanup();
  }
});

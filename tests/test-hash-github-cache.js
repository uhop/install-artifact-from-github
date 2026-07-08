import test from 'tape-six';
import {promises as fsp} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';

import {startMockServer} from './helpers/mock-server.js';
import {runBin} from './helpers/run-bin.js';

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

const VERSION = '1.0.0';
const sha = buffer => 'sha256:' + createHash('sha256').update(buffer).digest('hex');

const PAYLOAD_A = Buffer.from('linux-x64-payload');
const PAYLOAD_B = Buffer.from('darwin-arm64-payload');

const makeGenSandbox = async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'iafg-gen-'));
  const pkgJson = path.join(dir, 'package.json');
  await fsp.writeFile(pkgJson, JSON.stringify({name: 'demo', version: VERSION, github: 'owner/repo'}, null, 2) + '\n');
  return {dir, pkgJson, cleanup: () => fsp.rm(dir, {recursive: true, force: true})};
};

const readPkg = async pkgJson => JSON.parse(await fsp.readFile(pkgJson, 'utf8'));

test('hash-github-cache: --write from a directory stamps a sorted bag of decompressed hashes', async t => {
  const sandbox = await makeGenSandbox();
  const arts = path.join(sandbox.dir, 'arts');
  try {
    await fsp.mkdir(arts);
    await fsp.writeFile(path.join(arts, 'linux-x64-108.br'), await brotli(PAYLOAD_A));
    await fsp.writeFile(path.join(arts, 'darwin-arm64-108'), PAYLOAD_B); // uncompressed
    await fsp.writeFile(path.join(arts, 'README.txt'), 'not an artifact'); // ignored

    const r = await runBin('hash-github-cache.js', {args: ['--write', '--from', arts, '--package', sandbox.pkgJson]});
    t.equal(r.code, 0, `exited 0 (stderr=${r.stderr})`);

    const pkg = await readPkg(sandbox.pkgJson);
    t.deepEqual(
      pkg.artifactHashes,
      {'darwin-arm64-108': sha(PAYLOAD_B), 'linux-x64-108': sha(PAYLOAD_A)},
      'bag holds decompressed hashes for both slots (README ignored)'
    );
    t.deepEqual(Object.keys(pkg.artifactHashes), ['darwin-arm64-108', 'linux-x64-108'], 'keys are sorted');
  } finally {
    await sandbox.cleanup();
  }
});

test('hash-github-cache: --check passes when the bag matches and fails (exit 1) when it does not', async t => {
  const sandbox = await makeGenSandbox();
  const arts = path.join(sandbox.dir, 'arts');
  try {
    await fsp.mkdir(arts);
    await fsp.writeFile(path.join(arts, 'linux-x64-108.br'), await brotli(PAYLOAD_A));
    await runBin('hash-github-cache.js', {args: ['--write', '--from', arts, '--package', sandbox.pkgJson]});

    const ok = await runBin('hash-github-cache.js', {args: ['--check', '--from', arts, '--package', sandbox.pkgJson]});
    t.equal(ok.code, 0, 'matching bag → exit 0');

    const pkg = await readPkg(sandbox.pkgJson);
    pkg.artifactHashes['linux-x64-108'] = 'sha256:deadbeef';
    await fsp.writeFile(sandbox.pkgJson, JSON.stringify(pkg, null, 2) + '\n');

    const bad = await runBin('hash-github-cache.js', {args: ['--check', '--from', arts, '--package', sandbox.pkgJson]});
    t.equal(bad.code, 1, 'tampered bag → exit 1');
    t.ok(bad.stderr.includes('mismatch: linux-x64-108'), 'names the mismatching slot');
  } finally {
    await sandbox.cleanup();
  }
});

test('hash-github-cache: --check flags a slot present in the release but missing from the bag', async t => {
  const sandbox = await makeGenSandbox();
  const arts = path.join(sandbox.dir, 'arts');
  try {
    await fsp.mkdir(arts);
    await fsp.writeFile(path.join(arts, 'linux-x64-108.br'), await brotli(PAYLOAD_A));
    await fsp.writeFile(path.join(arts, 'darwin-arm64-108'), PAYLOAD_B);
    // Bag covers only one of the two artifacts.
    const pkg = await readPkg(sandbox.pkgJson);
    pkg.artifactHashes = {'linux-x64-108': sha(PAYLOAD_A)};
    await fsp.writeFile(sandbox.pkgJson, JSON.stringify(pkg, null, 2) + '\n');

    const r = await runBin('hash-github-cache.js', {args: ['--check', '--from', arts, '--package', sandbox.pkgJson]});
    t.equal(r.code, 1, 'incomplete bag → exit 1');
    t.ok(r.stderr.includes('missing: darwin-arm64-108'), 'reports the uncovered slot');
  } finally {
    await sandbox.cleanup();
  }
});

test('hash-github-cache: --from-release fetches assets and stamps the bag', async t => {
  const assets = [
    {name: 'linux-x64-108.br', body: await brotli(PAYLOAD_A)},
    {name: 'linux-x64-108.gz', body: await gzip(PAYLOAD_A)}, // same slot, lower rank → br wins
    {name: 'darwin-arm64-108', body: PAYLOAD_B}
  ];
  const server = await startMockServer({
    releaseHandler: (req, res) => {
      const base = `http://${req.headers.host}`;
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({tag_name: VERSION, assets: assets.map(a => ({name: a.name, browser_download_url: `${base}/dl/${a.name}`}))}));
    }
  });
  const sandbox = await makeGenSandbox();
  try {
    for (const a of assets) server.setAsset(`/dl/${a.name}`, a.body);

    const r = await runBin('hash-github-cache.js', {
      args: ['--write', '--from-release', '--package', sandbox.pkgJson],
      env: {GITHUB_API_URL: server.url}
    });
    t.equal(r.code, 0, `exited 0 (stderr=${r.stderr})`);

    const pkg = await readPkg(sandbox.pkgJson);
    t.deepEqual(pkg.artifactHashes, {'darwin-arm64-108': sha(PAYLOAD_B), 'linux-x64-108': sha(PAYLOAD_A)}, 'release assets hashed by slot, one entry per slot');
  } finally {
    await server.close();
    await sandbox.cleanup();
  }
});

test('hash-github-cache: requires exactly one of --write / --check', async t => {
  const sandbox = await makeGenSandbox();
  try {
    const neither = await runBin('hash-github-cache.js', {args: ['--from', sandbox.dir, '--package', sandbox.pkgJson]});
    t.equal(neither.code, 2, 'neither → exit 2');
    const both = await runBin('hash-github-cache.js', {args: ['--write', '--check', '--from', sandbox.dir, '--package', sandbox.pkgJson]});
    t.equal(both.code, 2, 'both → exit 2');
  } finally {
    await sandbox.cleanup();
  }
});

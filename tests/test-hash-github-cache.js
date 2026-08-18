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

const makeGenSandbox = async (extra = {}) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'iafg-gen-'));
  const pkgJson = path.join(dir, 'package.json');
  await fsp.writeFile(pkgJson, JSON.stringify({name: 'demo', version: VERSION, github: 'owner/repo', ...extra}, null, 2) + '\n');
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

const releaseWithAsset = assets => (req, res) => {
  const base = `http://${req.headers.host}`;
  res.writeHead(200, {'content-type': 'application/json'});
  res.end(
    JSON.stringify({
      tag_name: VERSION,
      assets: assets.map(a => ({name: a.name, url: `${base}/api/assets/${a.name}`, browser_download_url: `${base}/dl/${a.name}`}))
    })
  );
};

const RELEASE_PATH = '/repos/owner/repo/releases/tags/1.0.0';

test('hash-github-cache: a same-origin API redirect keeps the token', async t => {
  const assets = [{name: 'linux-x64-108', body: PAYLOAD_A}];
  const server = await startMockServer({
    redirects: {['/old' + RELEASE_PATH]: RELEASE_PATH},
    releaseHandler: releaseWithAsset(assets)
  });
  const sandbox = await makeGenSandbox();
  try {
    for (const a of assets) server.setAsset(`/api/assets/${a.name}`, a.body);

    const r = await runBin('hash-github-cache.js', {
      args: ['--write', '--from-release', '--package', sandbox.pkgJson],
      env: {GITHUB_API_URL: server.url + '/old', GITHUB_TOKEN: 'fake-token-do-not-use'}
    });
    t.equal(r.code, 0, `exited 0 (stderr=${r.stderr})`);

    const landed = server.requests.find(q => q.pathname === RELEASE_PATH);
    t.ok(landed, 'the API request followed the redirect');
    t.equal(landed.headers.authorization, 'Bearer fake-token-do-not-use', 'the token survived a hop inside the same origin');

    const pkg = await readPkg(sandbox.pkgJson);
    t.deepEqual(pkg.artifactHashes, {'linux-x64-108': sha(PAYLOAD_A)}, 'the release was read and hashed');
  } finally {
    await server.close();
    await sandbox.cleanup();
  }
});

test('hash-github-cache: a cross-origin API redirect drops the token', async t => {
  const assets = [{name: 'linux-x64-108', body: PAYLOAD_A}];
  const elsewhere = await startMockServer({releaseHandler: releaseWithAsset(assets)});
  const server = await startMockServer({redirects: {['/old' + RELEASE_PATH]: elsewhere.url + RELEASE_PATH}});
  const sandbox = await makeGenSandbox();
  try {
    for (const a of assets) elsewhere.setAsset(`/api/assets/${a.name}`, a.body);

    const r = await runBin('hash-github-cache.js', {
      args: ['--write', '--from-release', '--package', sandbox.pkgJson],
      env: {GITHUB_API_URL: server.url + '/old', GITHUB_TOKEN: 'fake-token-do-not-use'}
    });
    t.equal(r.code, 0, `exited 0 (stderr=${r.stderr})`);

    const sent = server.requests.find(q => q.pathname === '/old' + RELEASE_PATH);
    t.equal(sent.headers.authorization, 'Bearer fake-token-do-not-use', 'the token was sent to the original origin');

    const landed = elsewhere.requests.find(q => q.pathname === RELEASE_PATH);
    t.ok(landed, 'the API request followed the redirect to the other origin');
    t.equal(landed.headers.authorization, undefined, 'the token did not cross the origin');
    t.equal(landed.headers.accept, 'application/vnd.github.v3+json', 'non-credential headers still followed');

    const pkg = await readPkg(sandbox.pkgJson);
    t.deepEqual(pkg.artifactHashes, {'linux-x64-108': sha(PAYLOAD_A)}, 'the release was read and hashed');
  } finally {
    await server.close();
    await elsewhere.close();
    await sandbox.cleanup();
  }
});

test('hash-github-cache: with a token, assets download through the API asset URL, authenticated', async t => {
  const assets = [{name: 'linux-x64-108', body: PAYLOAD_A}];
  const server = await startMockServer({releaseHandler: releaseWithAsset(assets)});
  const sandbox = await makeGenSandbox();
  try {
    for (const a of assets) server.setAsset(`/api/assets/${a.name}`, a.body); // nothing staged at /dl/

    const r = await runBin('hash-github-cache.js', {
      args: ['--write', '--from-release', '--package', sandbox.pkgJson],
      env: {GITHUB_API_URL: server.url, GITHUB_TOKEN: 'fake-token-do-not-use'}
    });
    t.equal(r.code, 0, `exited 0 (stderr=${r.stderr})`);

    const asset = server.requests.find(q => q.pathname === '/api/assets/linux-x64-108');
    t.ok(asset, 'the asset was fetched through the API asset URL');
    t.equal(asset.headers.authorization, 'Bearer fake-token-do-not-use', 'the token went with it');
    t.equal(asset.headers.accept, 'application/octet-stream', 'asked for the binary, not the JSON description');

    const pkg = await readPkg(sandbox.pkgJson);
    t.deepEqual(pkg.artifactHashes, {'linux-x64-108': sha(PAYLOAD_A)}, 'hashed');
  } finally {
    await server.close();
    await sandbox.cleanup();
  }
});

test('hash-github-cache: an asset redirect to a CDN origin drops the token', async t => {
  const assets = [{name: 'linux-x64-108', body: PAYLOAD_A}];
  const cdn = await startMockServer();
  const server = await startMockServer({
    releaseHandler: releaseWithAsset(assets),
    redirects: {'/api/assets/linux-x64-108': cdn.url + '/signed/linux-x64-108'}
  });
  const sandbox = await makeGenSandbox();
  try {
    cdn.setAsset('/signed/linux-x64-108', PAYLOAD_A);

    const r = await runBin('hash-github-cache.js', {
      args: ['--write', '--from-release', '--package', sandbox.pkgJson],
      env: {GITHUB_API_URL: server.url, GITHUB_TOKEN: 'fake-token-do-not-use'}
    });
    t.equal(r.code, 0, `exited 0 (stderr=${r.stderr})`);

    const landed = cdn.requests.find(q => q.pathname === '/signed/linux-x64-108');
    t.ok(landed, 'the download followed the redirect to the CDN');
    t.equal(landed.headers.authorization, undefined, 'the token did not reach the CDN');

    const pkg = await readPkg(sandbox.pkgJson);
    t.deepEqual(pkg.artifactHashes, {'linux-x64-108': sha(PAYLOAD_A)}, 'hashed');
  } finally {
    await server.close();
    await cdn.close();
    await sandbox.cleanup();
  }
});

test('hash-github-cache: --from-release follows a relative Location to an asset', async t => {
  const assets = [{name: 'linux-x64-108.br', body: await brotli(PAYLOAD_A)}];
  const server = await startMockServer({
    redirects: {'/dl/linux-x64-108.br': '/cdn/linux-x64-108.br'},
    releaseHandler: (req, res) => {
      const base = `http://${req.headers.host}`;
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({tag_name: VERSION, assets: assets.map(a => ({name: a.name, browser_download_url: `${base}/dl/${a.name}`}))}));
    }
  });
  const sandbox = await makeGenSandbox();
  try {
    server.setAsset('/cdn/linux-x64-108.br', assets[0].body);

    const r = await runBin('hash-github-cache.js', {
      args: ['--write', '--from-release', '--package', sandbox.pkgJson],
      env: {GITHUB_API_URL: server.url}
    });
    t.equal(r.code, 0, `exited 0 (stderr=${r.stderr})`);

    const pkg = await readPkg(sandbox.pkgJson);
    t.deepEqual(pkg.artifactHashes, {'linux-x64-108': sha(PAYLOAD_A)}, 'the relative Location resolved against the asset URL');
  } finally {
    await server.close();
    await sandbox.cleanup();
  }
});

test('hash-github-cache: an enterprise GITHUB_API_URL keeps its /api/v3 path', async t => {
  const assets = [{name: 'linux-x64-108', body: PAYLOAD_A}];
  const server = await startMockServer({
    apiPrefix: '/api/v3',
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
      env: {GITHUB_API_URL: server.url + '/api/v3'}
    });
    t.equal(r.code, 0, `exited 0 (stderr=${r.stderr})`);

    const pkg = await readPkg(sandbox.pkgJson);
    t.deepEqual(pkg.artifactHashes, {'linux-x64-108': sha(PAYLOAD_A)}, 'the API path survived, so the release was found');
  } finally {
    await server.close();
    await sandbox.cleanup();
  }
});

test('hash-github-cache: with GITHUB_API_URL unset, an enterprise repository.url derives the /api/v3 base', async t => {
  const assets = [{name: 'linux-x64-108', body: PAYLOAD_A}];
  const server = await startMockServer({
    apiPrefix: '/api/v3',
    releaseHandler: (req, res) => {
      const base = `http://${req.headers.host}`;
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({tag_name: VERSION, assets: assets.map(a => ({name: a.name, browser_download_url: `${base}/dl/${a.name}`}))}));
    }
  });
  // No env: runBin passes only PATH and HOME, so GITHUB_API_URL is genuinely absent even under Actions.
  const sandbox = await makeGenSandbox({github: `${server.url}/owner/repo`});
  try {
    for (const a of assets) server.setAsset(`/dl/${a.name}`, a.body);

    const r = await runBin('hash-github-cache.js', {args: ['--write', '--from-release', '--package', sandbox.pkgJson]});
    t.equal(r.code, 0, `exited 0 (stderr=${r.stderr})`);

    const pkg = await readPkg(sandbox.pkgJson);
    t.deepEqual(pkg.artifactHashes, {'linux-x64-108': sha(PAYLOAD_A)}, 'the base was derived from repository.url as <host>/api/v3');
  } finally {
    await server.close();
    await sandbox.cleanup();
  }
});

// The only test in the suite that resolves a name: Enterprise Cloud with data residency serves its
// API from api.<sub>.ghe.com, and no local mock can answer to that name, so the derived host is
// asserted through the lookup failure it causes. Bounded by a timeout; both ENOTFOUND and EAI_AGAIN
// name the host, so an offline runner still discriminates the two shapes.
test('hash-github-cache: a .ghe.com repository.url derives the api. host, not /api/v3', async t => {
  const host = 'iafg-test-does-not-exist.ghe.com';
  const sandbox = await makeGenSandbox({github: `https://${host}/owner/repo`});
  try {
    const r = await runBin('hash-github-cache.js', {args: ['--write', '--from-release', '--package', sandbox.pkgJson], timeout: 20000});
    t.notEqual(r.code, 0, 'an unreachable enterprise host fails the run');
    t.ok(r.stderr.includes(`api.${host}`), `tried the dedicated api. host (stderr=${r.stderr})`);
  } finally {
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

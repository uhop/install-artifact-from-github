import test from 'tape-six';
import {promises as fsp} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';

import {startMockServer} from './helpers/mock-server.js';
import {runBin, makeSandbox} from './helpers/run-bin.js';

const brotli = promisify(zlib.brotliCompress);

const PLATFORM = 'linux';
const ARCH = 'x64';
const ABI = '108';
const SLOT = `${PLATFORM}-${ARCH}-${ABI}`;
const VERSION = '1.0.0';
const ASSET_PATH = `/owner/repo/releases/download/${VERSION}/${SLOT}`;

const sha = buffer => 'sha256:' + createHash('sha256').update(buffer).digest('hex');

// A sandbox whose package.json is read by install-from-cache (via npm_package_json), carrying the
// github/version it needs and an optional integrity bag.
const makeBagSandbox = async artifactHashes => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'iafg-verify-'));
  const pkg = {name: 'fake', version: VERSION, github: 'owner/repo', scripts: {rebuild: 'node -e ""'}};
  if (artifactHashes) pkg.artifactHashes = artifactHashes;
  const pkgJson = path.join(dir, 'package.json');
  await fsp.writeFile(pkgJson, JSON.stringify(pkg, null, 2));
  return {dir, pkgJson, cleanup: () => fsp.rm(dir, {recursive: true, force: true})};
};

// npm_config_platform* pins the slot and short-circuits the post-write build check.
// GITHUB_SERVER_URL points the *canonical* (verified) source at the mock, without tripping the
// mirror bypass the way DOWNLOAD_HOST would.
const verifyEnv = (sandbox, serverUrl, extra = {}) => ({
  npm_config_platform: PLATFORM,
  npm_config_platform_arch: ARCH,
  npm_config_platform_abi: ABI,
  npm_package_json: sandbox.pkgJson,
  GITHUB_SERVER_URL: serverUrl,
  ...extra
});

const runInstall = (sandbox, env) => runBin('install-from-cache.js', {cwd: sandbox.dir, args: ['--artifact', 'out/artifact.bin'], env});

const artifactExists = async sandbox => {
  try {
    await fsp.access(path.join(sandbox.dir, 'out/artifact.bin'));
    return true;
  } catch {
    return false;
  }
};

test('verify: matching hash on the canonical source is written', async t => {
  const server = await startMockServer();
  const payload = Buffer.from('the-real-binary');
  const sandbox = await makeBagSandbox({[SLOT]: sha(payload)});
  try {
    server.setAsset(ASSET_PATH + '.br', await brotli(payload));
    const r = await runInstall(sandbox, verifyEnv(sandbox, server.url));
    t.equal(r.code, 0, `bin exited 0 (stdout=${r.stdout})`);
    t.ok(r.stdout.includes('Done.'), 'reports Done.');
    t.deepEqual(await fsp.readFile(path.join(sandbox.dir, 'out/artifact.bin')), payload, 'verified artifact written');
  } finally {
    await server.close();
    await sandbox.cleanup();
  }
});

test('verify: a hash mismatch is rejected and falls through to a source build', async t => {
  const server = await startMockServer();
  const payload = Buffer.from('swapped-malicious-binary');
  const sandbox = await makeBagSandbox({[SLOT]: sha(Buffer.from('what-the-author-published'))});
  try {
    server.setAsset(ASSET_PATH + '.br', await brotli(payload));
    const r = await runInstall(sandbox, verifyEnv(sandbox, server.url));
    t.equal(r.code, 0, 'rebuild stub exited 0');
    t.ok(r.stdout.includes(`Integrity check failed for ${SLOT}`), 'announces the integrity failure');
    t.ok(r.stdout.includes('Building locally'), 'falls through to the source build');
    t.notOk(await artifactExists(sandbox), 'the mismatching artifact is NOT written');
  } finally {
    await server.close();
    await sandbox.cleanup();
  }
});

test('verify: a downloaded slot the bag does not cover is rejected (strict)', async t => {
  const server = await startMockServer();
  const payload = Buffer.from('unbagged-slot-binary');
  const sandbox = await makeBagSandbox({'linux-x64-999': sha(Buffer.from('some-other-slot'))});
  try {
    server.setAsset(ASSET_PATH + '.br', await brotli(payload));
    const r = await runInstall(sandbox, verifyEnv(sandbox, server.url));
    t.equal(r.code, 0, 'rebuild stub exited 0');
    t.ok(r.stdout.includes(`Integrity check failed for ${SLOT}`), 'unbagged slot is treated as a failure');
    t.notOk(await artifactExists(sandbox), 'nothing written for an unbagged slot');
  } finally {
    await server.close();
    await sandbox.cleanup();
  }
});

test('verify: a package with no bag installs unchanged (non-breaking)', async t => {
  const server = await startMockServer();
  const payload = Buffer.from('no-bag-here');
  const sandbox = await makeBagSandbox(null);
  try {
    server.setAsset(ASSET_PATH + '.br', await brotli(payload));
    const r = await runInstall(sandbox, verifyEnv(sandbox, server.url));
    t.equal(r.code, 0, 'bin exited 0');
    t.deepEqual(await fsp.readFile(path.join(sandbox.dir, 'out/artifact.bin')), payload, 'bagless install writes the artifact');
  } finally {
    await server.close();
    await sandbox.cleanup();
  }
});

test('verify: a consumer mirror bypasses verification (its bytes are the deployer trust root)', async t => {
  const server = await startMockServer();
  const payload = Buffer.from('mirror-served-bytes');
  // Bag deliberately wrong for the slot; the mirror path must NOT check it.
  const sandbox = await makeBagSandbox({[SLOT]: sha(Buffer.from('would-mismatch'))});
  try {
    server.setAsset(ASSET_PATH + '.br', await brotli(payload));
    const env = {
      npm_config_platform: PLATFORM,
      npm_config_platform_arch: ARCH,
      npm_config_platform_abi: ABI,
      npm_package_json: sandbox.pkgJson,
      DOWNLOAD_HOST: server.url // mirror override → verification skipped
    };
    const r = await runInstall(sandbox, env);
    t.equal(r.code, 0, `bin exited 0 (stdout=${r.stdout})`);
    t.notOk(r.stdout.includes('Integrity check failed'), 'no integrity check on a mirror');
    t.deepEqual(await fsp.readFile(path.join(sandbox.dir, 'out/artifact.bin')), payload, 'mirror artifact written despite the wrong bag');
  } finally {
    await server.close();
    await sandbox.cleanup();
  }
});

const forceBuildEnv = serverUrl => ({
  DOWNLOAD_HOST: serverUrl,
  npm_package_github: 'owner/repo',
  npm_package_version: VERSION,
  npm_config_platform: PLATFORM,
  npm_config_platform_arch: ARCH,
  npm_config_platform_abi: ABI
});

test('force-build: --force-build skips the download and builds from source', async t => {
  const server = await startMockServer();
  const sandbox = await makeSandbox();
  try {
    server.setAsset(ASSET_PATH + '.br', await brotli(Buffer.from('should-not-be-fetched')));
    const r = await runBin('install-from-cache.js', {
      cwd: sandbox.dir,
      args: ['--artifact', 'out/artifact.bin', '--force-build'],
      env: forceBuildEnv(server.url)
    });
    t.equal(r.code, 0, 'rebuild stub exited 0');
    t.ok(r.stdout.includes('Forced build from sources was requested'), 'logs the forced-build reason');
    t.ok(r.stdout.includes('Building locally'), 'falls through to the source build');
    let exists = true;
    try {
      await fsp.access(path.join(sandbox.dir, 'out/artifact.bin'));
    } catch {
      exists = false;
    }
    t.notOk(exists, 'no artifact fetched when forced to build');
  } finally {
    await server.close();
    await sandbox.cleanup();
  }
});

test('force-build: DOWNLOAD_FORCE_BUILD env has the same effect', async t => {
  const server = await startMockServer();
  const sandbox = await makeSandbox();
  try {
    server.setAsset(ASSET_PATH + '.br', await brotli(Buffer.from('should-not-be-fetched')));
    const r = await runBin('install-from-cache.js', {
      cwd: sandbox.dir,
      args: ['--artifact', 'out/artifact.bin'],
      env: {...forceBuildEnv(server.url), DOWNLOAD_FORCE_BUILD: '1'}
    });
    t.equal(r.code, 0, 'rebuild stub exited 0');
    t.ok(r.stdout.includes('Forced build from sources was requested'), 'env var triggers the forced build');
  } finally {
    await server.close();
    await sandbox.cleanup();
  }
});

test('force-build: --force-build-var reads a project-namespaced env var', async t => {
  const server = await startMockServer();
  const sandbox = await makeSandbox();
  try {
    server.setAsset(ASSET_PATH + '.br', await brotli(Buffer.from('should-not-be-fetched')));
    const r = await runBin('install-from-cache.js', {
      cwd: sandbox.dir,
      args: ['--artifact', 'out/artifact.bin', '--force-build-var', 'RE2_FORCE_BUILD'],
      env: {...forceBuildEnv(server.url), RE2_FORCE_BUILD: '1', DOWNLOAD_FORCE_BUILD: ''}
    });
    t.equal(r.code, 0, 'rebuild stub exited 0');
    t.ok(r.stdout.includes('Forced build from sources was requested'), 'project-specific env var triggers the forced build');
  } finally {
    await server.close();
    await sandbox.cleanup();
  }
});

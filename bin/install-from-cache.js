#!/usr/bin/env node

import {promises as fsp} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import zlib from 'node:zlib';
import {promisify} from 'node:util';
import http from 'node:http';
import https from 'node:https';
import {exec, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

/** @type {import('child_process').SpawnSyncOptions} */
const spawnOptions = {encoding: 'utf8', env: process.env};
const getPlatform = () => {
  let platform = process.env.npm_config_platform;
  if (platform) return platform;
  platform = process.platform;
  if (platform !== 'linux') return platform;
  // detecting musl using algorithm from https://github.com/lovell/detect-libc under Apache License 2.0
  let result = spawnSync('getconf', ['GNU_LIBC_VERSION'], spawnOptions);
  if (!result.status && !result.signal) return platform;
  result = spawnSync('ldd', ['--version'], spawnOptions);
  if (result.signal) return platform;
  if ((!result.status && result.stdout.toString().indexOf('musl') >= 0) || (result.status === 1 && result.stderr.toString().indexOf('musl') >= 0))
    return platform + '-musl';
  return platform;
};

const platform = getPlatform(),
  platformArch = process.env.npm_config_platform_arch || process.arch,
  platformABI = process.env.npm_config_platform_abi || process.versions.modules;

const isParamPresent = name => process.argv.indexOf('--' + name) > 0;

const getParam = (name, defaultValue = '') => {
  const index = process.argv.indexOf('--' + name);
  if (index > 0) return process.argv[index + 1] || '';
  return defaultValue;
};

const artifactPath = getParam('artifact'),
  prefix = getParam('prefix'),
  suffix = getParam('suffix'),
  mirrorHost = getParam('host'),
  mirrorEnvVar = getParam('host-var') || 'DOWNLOAD_HOST',
  skipPath = isParamPresent('skip-path'),
  skipPathVar = getParam('skip-path-var') || 'DOWNLOAD_SKIP_PATH',
  skipVer = isParamPresent('skip-ver'),
  skipVerVar = getParam('skip-ver-var') || 'DOWNLOAD_SKIP_VER',
  agentDirect = getParam('agent'),
  agentEnvVar = getParam('agent-var') || 'DOWNLOAD_AGENT',
  napiDirect = getParam('napi'),
  napiEnvVar = getParam('napi-var') || 'DOWNLOAD_NAPI',
  forceBuild = isParamPresent('force-build'),
  forceBuildVar = getParam('force-build-var') || 'DOWNLOAD_FORCE_BUILD';

const napiLevel = napiDirect || process.env[napiEnvVar] || process.env.npm_config_platform_napi || '';
const abiSlot = napiLevel ? `napi-v${napiLevel}` : platformABI;

// The slot names the artifact for this platform; it keys the integrity hash bag.
const slot = `${platform}-${platformArch}-${abiSlot}`;
// Verification applies only to the canonical source: a consumer-supplied mirror is the
// deployer's own trust root (its bytes may legitimately differ), so we never check it.
const isDefaultSource = !mirrorHost && !process.env[mirrorEnvVar];
let artifactHashes = null;

const parseUrl = [
  /^(?:https?|git|git\+ssh|git\+https?):\/\/github.com\/([^\/]+)\/([^\/\.]+)(?:\/|\.git\b|$)/i,
  /^github:([^\/]+)\/([^#]+)(?:#|$)/i,
  /^([^:\/]+)\/([^#]+)(?:#|$)/i
];

const isHttp = /^http:\/\//i,
  isHttps = /^https:\/\//i;

const getRepo = url => {
  if (!url) return null;
  for (const re of parseUrl) {
    const result = re.exec(url);
    if (result) return result;
  }
  return null;
};

const getAssetUrlPrefix = () => {
  const url = process.env.npm_package_github || (process.env.npm_package_repository_type === 'git' && process.env.npm_package_repository_url),
    result = getRepo(url);
  if (!result) return null;
  let assetUrl = mirrorHost || process.env[mirrorEnvVar] || process.env.GITHUB_SERVER_URL || 'https://github.com';
  if (!skipPath && !process.env[skipPathVar]) {
    assetUrl += `/${result[1]}/${result[2]}/releases/download`;
  }
  if (!skipVer && !process.env[skipVerVar]) {
    assetUrl += '/' + process.env.npm_package_version;
  }
  assetUrl += `/${prefix}${platform}-${platformArch}-${abiSlot}${suffix}`;
  return assetUrl;
};

const isDev = async () => {
  if (process.env.DEVELOPMENT_SKIP_GETTING_ASSET) return true;
  try {
    await fsp.access('.development');
    return true;
  } catch (e) {
    // squelch
  }
  return false;
};

const run = (cmd, suppressOutput) =>
  new Promise((resolve, reject) => {
    const p = exec(cmd);
    let closed = false;
    p.on('exit', (code, signal) => {
      if (closed) return;
      closed = true;
      (signal || code) && reject(signal || code);
      resolve(0);
    });
    p.on('error', error => !closed && ((closed = true), reject(error)));
    if (!suppressOutput || process.env.DEVELOPMENT_SHOW_VERIFICATION_RESULTS) {
      p.stdout.on('data', data => process.stdout.write(data));
      p.stderr.on('data', data => process.stderr.write(data));
    }
  });

const isVerified = async () => {
  if (process.env.npm_config_platform || process.env.npm_config_platform_arch || process.env.npm_config_platform_abi) {
    console.log(`Fetched for the custom platform "${platform}-${platformArch}-${platformABI}" -- skipping the verification.`);
    return true;
  }
  try {
    if (process.env.npm_package_scripts_verify_build) {
      await run('npm run verify-build', true);
    } else if (process.env.npm_package_scripts_test) {
      await run('npm test', true);
    } else {
      console.log('No verify-build nor test scripts were found -- no way to verify the build automatically.');
      return false;
    }
  } catch (e) {
    console.log('The verification has failed: building from sources ...');
    return false;
  }
  return true;
};

const loadAgent = async () => {
  const agentPath = agentDirect || process.env[agentEnvVar];
  if (!agentPath) return false;
  try {
    const mod = await import(pathToFileURL(path.resolve(agentPath)).href);
    return mod.default ?? false;
  } catch (e) {
    console.error(`Failed to load download agent "${agentPath}": ${e.message}`);
    return false;
  }
};
const downloadAgent = await loadAgent();

const get = url =>
  new Promise((resolve, reject) => {
    const httpLib = isHttps.test(url) ? https : isHttp.test(url) ? http : null;
    if (!httpLib) {
      // local file
      fsp.readFile(url).then(resolve, reject);
      return;
    }
    let buffer = null;
    httpLib
      .get(url, {agent: downloadAgent}, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers && res.headers.location) {
          get(res.headers.location).then(resolve, reject);
          return;
        }
        if (res.statusCode != 200) {
          reject(Error(`Status ${res.statusCode} for ${url}`));
          return;
        }
        res.on('data', data => {
          if (buffer) {
            buffer = Buffer.concat([buffer, data]);
          } else {
            buffer = data;
          }
        });
        res.on('end', () => resolve(buffer));
      })
      .on('error', e => reject(e))
      .end();
  });

const write = async (name, data) => {
  await fsp.mkdir(path.dirname(name), {recursive: true});
  await fsp.writeFile(name, data);
};

// Integrity gate for the canonical source: the decompressed bytes must match the hash the
// author pinned in the immutable, npm-published package.json. A mismatch OR a downloaded slot
// the bag doesn't cover both fail closed (rebuild). No bag / a mirror source skips the check.
const verifyArtifact = data => {
  if (!isDefaultSource || !artifactHashes) return true;
  const expected = artifactHashes[slot],
    actual = 'sha256:' + createHash('sha256').update(data).digest('hex');
  if (expected && expected === actual) return true;
  console.log(`Integrity check failed for ${slot}: building from sources ...`);
  return false;
};

const main = async () => {
  checks: {
    if (process.env.npm_package_json && /\bpackage\.json$/i.test(process.env.npm_package_json)) {
      // for NPM >= 7
      try {
        // read the package info
        const pkg = JSON.parse(await fsp.readFile(process.env.npm_package_json, 'utf8'));
        // populate necessary environment variables locally
        process.env.npm_package_github = pkg.github || '';
        process.env.npm_package_repository_type = (pkg.repository && pkg.repository.type) || '';
        process.env.npm_package_repository_url = (pkg.repository && pkg.repository.url) || '';
        process.env.npm_package_version = pkg.version || '';
        process.env.npm_package_scripts_verify_build = (pkg.scripts && pkg.scripts['verify-build']) || '';
        process.env.npm_package_scripts_test = (pkg.scripts && pkg.scripts.test) || '';
        artifactHashes = pkg.artifactHashes && typeof pkg.artifactHashes === 'object' ? pkg.artifactHashes : null;
      } catch (error) {
        console.log('Could not retrieve and parse package.json.');
        break checks;
      }
    }
    if (!artifactPath) {
      console.log('No artifact path was specified with --artifact.');
      break checks;
    }
    if (forceBuild || process.env[forceBuildVar]) {
      console.log('Forced build from sources was requested.');
      break checks;
    }
    if (await isDev()) {
      console.log('Development flag was detected.');
      break checks;
    }
    const prefix = getAssetUrlPrefix();
    if (!prefix) {
      console.log('No github repository was identified.');
      break checks;
    }
    let copied = false,
      rejected = false;
    // a failed integrity check rejects the artifact outright: the other formats decode to the
    // same bytes, so there is no point trying them -- fall through to a source build instead.
    // let's try brotli
    if (!rejected && zlib.brotliDecompress) {
      try {
        console.log(`Trying ${prefix}.br ...`);
        const artifact = await promisify(zlib.brotliDecompress)(await get(prefix + '.br'));
        if (verifyArtifact(artifact)) {
          console.log(`Writing to ${artifactPath} ...`);
          await write(artifactPath, artifact);
          copied = true;
        } else {
          rejected = true;
        }
      } catch (e) {
        // squelch
      }
    }
    // let's try gzip
    if (!copied && !rejected && zlib.gunzip) {
      try {
        console.log(`Trying ${prefix}.gz ...`);
        const artifact = await promisify(zlib.gunzip)(await get(prefix + '.gz'));
        if (verifyArtifact(artifact)) {
          console.log(`Writing to ${artifactPath} ...`);
          await write(artifactPath, artifact);
          copied = true;
        } else {
          rejected = true;
        }
      } catch (e) {
        // squelch
      }
    }
    // let's try uncompressed
    if (!copied && !rejected) {
      try {
        console.log(`Trying ${prefix} ...`);
        const artifact = await get(prefix);
        if (verifyArtifact(artifact)) {
          console.log(`Writing to ${artifactPath} ...`);
          await write(artifactPath, artifact);
          copied = true;
        } else {
          rejected = true;
        }
      } catch (e) {
        // squelch
      }
    }
    // verify the install
    if (copied && (await isVerified())) return console.log('Done.');
  }
  console.log('Building locally ...');
  await run('npm run rebuild');
};
main();

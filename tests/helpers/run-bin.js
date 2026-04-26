import {spawn} from 'node:child_process';
import {promises as fsp} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Run a bin script with a controlled env and cwd. Resolves once the process exits.
// Always isolates env (no inherited npm_*); caller passes exactly what the test needs.
export const runBin = async (binName, {args = [], env = {}, cwd}) => {
  const bin = path.join(REPO_ROOT, 'bin', binName);
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [bin, ...args], {
      cwd: cwd || REPO_ROOT,
      env: {PATH: process.env.PATH, HOME: process.env.HOME, ...env}
    });
    const out = [];
    const err = [];
    proc.stdout.on('data', d => out.push(d));
    proc.stderr.on('data', d => err.push(d));
    proc.on('error', reject);
    proc.on('exit', (code, signal) => {
      resolve({
        code,
        signal,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8')
      });
    });
  });
};

// Make a sandbox directory with a stub package.json that has a no-op rebuild
// script (so the install-from-cache "Building locally" fallback doesn't blow
// up the test runner with an `npm error Missing script: "rebuild"`).
export const makeSandbox = async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'iafg-test-'));
  await fsp.writeFile(path.join(dir, 'package.json'), JSON.stringify({name: 'fake', version: '1.0.0', scripts: {rebuild: 'node -e ""'}}, null, 2));
  return {
    dir,
    cleanup: () => fsp.rm(dir, {recursive: true, force: true})
  };
};

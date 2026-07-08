# AGENTS.md &mdash; install-artifact-from-github

> A no-dependency micro helper for developers of binary addons for Node. Three single-file bin utilities integrated with GitHub Releases: `save-to-github-cache` uploads a built binary artifact to a GitHub release (from CI); `install-from-cache` downloads it on the user's machine at install time, optionally verifies its integrity against a hash bag in the addon's `package.json`, and falls back to building from sources on any failure; `hash-github-cache` generates that hash bag at release time. Zero dependencies, ESM, Node >= 18.

For detailed usage docs see the [wiki](https://github.com/uhop/install-artifact-from-github/wiki).

## Setup

```bash
git clone --recursive https://github.com/uhop/install-artifact-from-github.git
cd install-artifact-from-github
npm install
```

The wiki is a git submodule in `wiki/`.

## Commands

- **Test:** `npm test` (runs `tape6 --flags FO` against the mock-server harness)
- **Test (sequential):** `npm run test:seq` (`tape6-seq --flags FO`)
- **JavaScript check:** `npm run js-check` (`tsc --project tsconfig.check.json` &mdash; checkJs on the bin sources)
- **Lint:** `npm run lint` (Prettier check)
- **Lint fix:** `npm run lint:fix` (Prettier write)

## Project structure

```
install-artifact-from-github/
├── package.json            # Package config; "type": "module"; exposes the three bins
├── tsconfig.check.json     # Lint config -- checkJs on the bin sources
├── bin/
│   ├── install-from-cache.js     # Consumer-side bin: download -> integrity check -> verify -> fallback rebuild
│   ├── save-to-github-cache.js   # CI-side bin: compress + upload artifact to a GitHub release
│   └── hash-github-cache.js      # Release-side bin: hash release assets into the package.json integrity bag
├── scripts/
│   ├── dump-env.js         # Dev helper: dump npm-provided env vars
│   └── example-save.sh     # Manual upload example (uses a personal token)
├── tests/                  # Automated tests (tape-six)
│   └── helpers/            # mock-server.js (GitHub API + asset host impersonation), run-bin.js
└── wiki/                   # GitHub wiki documentation (git submodule)
```

## How the bins work

- `install-from-cache` runs as the consuming addon's `install` script. It computes `${platform}-${arch}-${abiSlot}`, builds the asset URL from the consumer's `package.json` (`github` or `repository.url`, plus `version`), then tries `.br` &rarr; `.gz` &rarr; uncompressed. If the addon pins an `artifactHashes` bag and the download is from the canonical source, the decompressed bytes' SHA-256 must match before writing (integrity check); on success it also verifies via the consumer's `verify-build` (or `test`) script; on any failure it runs `npm run rebuild` (typically `node-gyp rebuild`). All failures degrade gracefully to the source build.
- `save-to-github-cache` runs in GitHub Actions on a tag build: reads `GITHUB_REPOSITORY` / `GITHUB_REF` / `GITHUB_TOKEN` (or `PERSONAL_TOKEN`), resolves the release upload URL, and uploads the artifact in the formats requested by `--format` (default `br`).
- `hash-github-cache` runs at release time (e.g. `prepublishOnly`): hashes the release's assets (`--from-release`) or a local directory (`--from`) and `--write`s / `--check`s the `{slot -> sha256}` `artifactHashes` bag in the consumer's `package.json`. It shares slot naming + decompression with `install-from-cache`, so a bag it writes always verifies.
- Configuration knobs follow the `--flag` / `--flag-var ENVVAR` / default-env-var triple convention: mirror host (`DOWNLOAD_HOST`), path/version skipping (`DOWNLOAD_SKIP_PATH`, `DOWNLOAD_SKIP_VER`), proxy agent (`DOWNLOAD_AGENT`), N-API level (`DOWNLOAD_NAPI`), forced source build (`DOWNLOAD_FORCE_BUILD` / `--force-build`). The canonical (verified) download host is `GITHUB_SERVER_URL` or `https://github.com`; a `DOWNLOAD_HOST` mirror is not integrity-checked.
- musl Linux is detected (`linux-musl`) using the detect-libc algorithm.

## Code style

- **ES modules** (`"type": "module"`), Node >= 18.
- **Prettier** for formatting &mdash; run `npm run lint:fix` before committing.
- **No narrating comments** &mdash; comments are short _why_-markers only (a non-trivial decision or constraint, an algorithm reference, or required JSDoc); never a restatement of _what_ the code does.
- Each bin stays a self-contained single file &mdash; they must be trivially auditable (the security story depends on it).

## Key conventions

- **No runtime dependencies, ever.** The bins use only the Node standard library. DevDeps for tooling are fine.
- **Every change must be fail-safe**: any failure in the download path must fall back to `npm run rebuild`. Never make a download/verification failure fatal.
- **Integrity verification is opt-in and source-scoped** (since 1.7.0): it runs only for the canonical GitHub source (`GITHUB_SERVER_URL` / `https://github.com`) and only when the addon ships an `artifactHashes` bag. A consumer mirror (`--host` / `DOWNLOAD_HOST`) is the deployer's own trust root and must never be integrity-checked. A failed check stays fail-safe (rebuild), never fatal. The bag is authored in the consumer's `package.json`, never in this package.
- **No build step, no importable API** &mdash; this package ships three bins only; there is no `src/`, no `.d.ts` sidecars, no `exports` map.
- Wiki documentation lives in the `wiki/` submodule &mdash; update it alongside behavior changes; commit in the submodule, then bump the pointer in the parent repo.
- Tests impersonate the GitHub Releases API + asset host with a local HTTP server (`tests/helpers/mock-server.js`) &mdash; no network access in tests.
- **npm 12 (July 2026)** disables dependency lifecycle scripts by default; consumers must allowlist the addon that uses this package (`npm approve-scripts <addon>`). Keep the consumer-side allowlist flow visible in the docs (README + wiki).

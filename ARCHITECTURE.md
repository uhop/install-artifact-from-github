# Architecture

`install-artifact-from-github` is a no-dependency micro helper for developers of binary addons for Node. It ships exactly two single-file bin utilities integrated with GitHub Releases: one uploads pre-built binary artifacts from CI, the other downloads them on the user's machine at install time &mdash; falling back to a source build on any failure. **Zero runtime dependencies** &mdash; devDeps only for formatting, type-checking, and the test runner.

## Project layout

```
install-artifact-from-github/
├── package.json            # "type": "module"; declares the two bins; no exports map (nothing importable)
├── tsconfig.check.json     # checkJs config for the bin sources (npm run js-check)
├── bin/
│   ├── install-from-cache.js     # Consumer-side bin (~260 lines)
│   └── save-to-github-cache.js   # CI-side bin (~180 lines)
├── scripts/
│   ├── dump-env.js         # Dev helper: dump npm-provided env vars
│   └── example-save.sh     # Manual upload example for exotic configurations
├── tests/                  # tape-six tests
│   └── helpers/
│       ├── mock-server.js  # Local HTTP server impersonating the GitHub Releases API + asset host
│       └── run-bin.js      # Spawns the bins with a controlled environment
└── wiki/                   # GitHub wiki documentation (git submodule)
```

There is deliberately no `src/`, no importable API, no build step: the package is consumed only through its two bins, invoked from a consuming addon's `package.json` scripts.

## The install flow (`install-from-cache`)

Runs as the consuming addon's `install` script:

1. **Platform detection** &mdash; `${platform}-${arch}-${abiSlot}` from `process.platform` / `process.arch` / `process.versions.modules`; musl Linux becomes `linux-musl` (detect-libc algorithm); `--napi N` swaps the ABI slot to `napi-vN`. All three are overridable via `npm_config_platform*` for cross-builds.
2. **URL construction** &mdash; host (default `https://github.com`, overridable for mirrors) + `/${owner}/${repo}/releases/download` (skippable) + `/${version}` (skippable) + `/${prefix}${platform}-${arch}-${abiSlot}${suffix}`. Owner/repo/version come from the consumer's `package.json` (`github` or `repository.url`, `version`), provided by npm via environment variables (npm < 7) or `npm_package_json` (npm >= 7).
3. **Download chain** &mdash; try `.br`, then `.gz`, then uncompressed; each failure is silent and falls through. A non-HTTP host is treated as a local filesystem path. An optional `http.Agent` module (proxy support) is dynamically imported and applied to every request.
4. **Verification** &mdash; run the consumer's `verify-build` script (or `test` as fallback). A binary that downloads but fails verification is discarded.
5. **Fallback** &mdash; anything that fails above ends in `npm run rebuild` (typically `node-gyp rebuild`). The download path is a lossless optimization: its only possible cost is a wasted download attempt.

Short-circuits: `DEVELOPMENT_SKIP_GETTING_ASSET` env var or a `.development` file forces the source build.

## The upload flow (`save-to-github-cache`)

Runs in GitHub Actions on a tag build:

1. Reads `GITHUB_REPOSITORY` / `GITHUB_REF` / `GITHUB_TOKEN` (or `PERSONAL_TOKEN` for manual/local runs) and resolves the release's `upload_url` via the GitHub REST API (`GITHUB_API_URL` overridable).
2. Compresses the artifact per `--format` (comma-separated set of `br`, `gz`, `none`; default `br`; brotli and gzip both at maximum compression) and uploads each format in parallel as release assets.
3. Exports `CREATED_ASSET_NAME` into `GITHUB_ENV` for downstream workflow steps.

## Design properties

- **Lossless shortcut.** The fallback is the textbook `node-gyp rebuild` flow; every failure mode degrades to it. No failure in this package can make an install worse than not using it.
- **Auditable by inspection.** Two small standard-library-only files. No transitive trust, no separate binary CDN: artifacts live on the same GitHub release anyone reading the consumer's source would expect, writable only by repo maintainers.
- **Convention-driven configuration.** Every knob follows the same triple: `--flag value` (hard-coded) / `--flag-var ENVVAR` (consumer-namespaced env var, recommended for libraries) / default env var (`DOWNLOAD_HOST`, `DOWNLOAD_SKIP_PATH`, `DOWNLOAD_SKIP_VER`, `DOWNLOAD_AGENT`, `DOWNLOAD_NAPI`).
- **Bring-your-own-agent proxy.** Proxy support never adds dependencies: the consumer points at a module whose default export is an `http.Agent`; a load failure warns and degrades to direct connections.

## Testing

`tests/helpers/mock-server.js` impersonates both the GitHub Releases API and the asset host on a local HTTP server, so the full download / upload / fallback matrix runs without network access. CI runs the suite on Linux (multiple Node versions) plus macOS and Windows. A separate `build.yml` "release dogfood" workflow fires on `*-test` tags and exercises `save-to-github-cache` against the real GitHub API.

## External context: npm 12 and install scripts

npm 12 (July 2026) stops running dependency lifecycle scripts by default. This package's delivery mechanism is the consumer's `install` script, so end users must allowlist the consuming addon (`npm approve-scripts <addon>`) &mdash; nothing in this package's code can change that. The consumer-facing story lives in the README and the wiki; keep it current.

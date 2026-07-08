# Field survey: how native-addon binaries are distributed and verified

**Status:** Research / reference — informs the design decision, no code.
**Date:** 2026-07-07.
**Origin:** the CWE-494 disclosure (now filed as draft advisory GHSA-88q3-gch3-5396). Before
finalizing the response in `artifact-integrity-verification.md`, we surveyed what comparable
packages actually do about downloading and verifying prebuilt native addons. This note records
the findings so the decision is grounded in prior art, not assumption.

Companion to `artifact-integrity-verification.md` (the design note); that note assumes we keep
the downloader and harden it — this survey tests that assumption against the field and measures
the alternative.

---

## 1. The one lens that organizes everything: where the checksum's trust root lives

Every integrity scheme falls into one of three classes. The class — not the algorithm — is
what determines whether it survives the attack in our own threat model (a compromised
maintainer account that swaps a release asset after publish).

| Class | Mechanism | Root of trust | Survives account/release compromise? |
| --- | --- | --- | --- |
| **(a)** In-band checksum in the *same mutable channel* as the binary | `SHASUMS256.txt` inside the GitHub Release | The release itself (maintainer-controlled) | **No** — one compromise rewrites binary *and* checksum |
| **(b)** Checksum pinned in an *immutable registry/lockfile* | npm tarball SRI (`integrity: sha512-…`), `Cargo.lock`, pip `--require-hashes` | The immutable published artifact | **Partially** — only if pinned before the compromise |
| **(c)** *External transparency log + CI identity* | Sigstore/Rekor (npm provenance, GitHub attestations, PyPI PEP 740, Homebrew bottles); Go `sum.golang.org` | A log + OIDC identity *outside* the account | **Yes** — attacker lacks the CI identity; tampering is publicly detectable |

Our gap today is class-(a)-with-nothing. **The reporter's suggested fix — publish
`SHASUMS256.txt` — is also class (a):** it is defeated by the exact "compromised maintainer
account" scenario in his own advisory. The design note's instinct (Sigstore over checksums) is
class (c), which is where npm, PyPI, Homebrew, and Go have all independently converged.

---

## 2. What comparable packages actually do

| Tool | Model | Downloads at install? | Integrity | Class |
| --- | --- | --- | --- | --- |
| `prebuild-install` (~18M/wk, **deprecated 2026-02**) | download from GitHub Releases | Yes | **none** | — |
| `@mapbox/node-pre-gyp` (~12M/wk) | download from S3 / configurable host | Yes | **none** | — |
| `node-gyp` (source path) | downloads *Node.js headers* | Yes | `SHASUMS256.txt`, headers only, TLS/host root, no GPG | (a) |
| `prebuildify` + `node-gyp-build` | bundle *all* prebuilds in the one tarball | **No** | npm SRI | (b) |
| `pkg-prebuilds` | bundle in tarball | **No** | npm SRI | (b) |
| napi-rs / esbuild / sharp / rollup | per-platform npm packages (`optionalDependencies` + `os`/`cpu`/`libc`) | **No** | npm SRI (+ optional provenance) | (b)→(c) |
| **install-artifact-from-github (us, today)** | download from GitHub Releases | Yes | **none** | — |

Three findings from this that change the decision:

**2.1 — The reporter's precedent is factually wrong.** He states `prebuild-install` "already
uses" a `SHASUMS256.txt` model. It does not: `prebuild-install/download.js` streams the HTTP
response straight to disk and extracts it on `statusCode === 200`, with no `crypto`, no hash,
no signature — the README never mentions checksum/integrity. The `SHASUMS256.txt` he is
thinking of belongs to **`node-gyp`**, which uses it only to verify downloaded *Node.js build
headers* on the compile-from-source path — a different code path that never touches a prebuilt
addon. So "just do what `prebuild-install` does" points at a verification model that does not
exist where he thinks it does. (This should be corrected, gently but explicitly, in the reply.)

**2.2 — The field retired the download; it did not add verifiers to it.** The safe tools are
safe by *not downloading*: they ship the binary inside an npm package so registry SRI (class b)
covers it, making CWE-494 *not-applicable* rather than *mitigated*. The most on-point precedent
is **sharp**, which migrated away from our exact model (node-pre-gyp downloading from GitHub) to
npm-hosted binaries in **v0.33.0 (2023-11-29)**, stating the goal almost verbatim as this
advisory: "use only package manager mechanics at install time, without custom scripts, and
without downloading binaries from hosts other than those controlled by a package manager."

**2.3 — The download generation is uniformly unverified, and it has been exploited.** The two
tools that actually download at install time verify nothing. The canonical real-world exploit
of exactly this class: **GHSA-7cgc-fjv4-52x6** — `bignum`'s node-pre-gyp S3 bucket expired, an
attacker re-registered it and served data-exfiltrating malware; the absent integrity check is
precisely why the swap went undetected. A clean articulation of the threat model (later
withdrawn but accurate) is **GHSA-gv7w-rqvm-qjhr**: "esbuild/Deno missing binary integrity
verification enables RCE via `NPM_CONFIG_REGISTRY`."

---

## 3. The attestation model (our preferred fix) is mature and adopted — but new to Node

Class (c) is not experimental:

- **npm provenance** is GA: `npm publish --provenance` produces Sigstore-signed attestations
  (source repo + commit + CI workflow), recorded in Rekor; consumers verify via
  `npm audit signatures` and the registry UI. `@sigstore/verify` (the library npm uses
  internally) is **pure JS, credential-free, version-pinnable, and offline-capable given a
  pinned trusted root** — which fits our "probe it in the consumer, stay zero-dep here" design.
- **PyPI PEP 740** went GA (2024-11-14): a first-tier ecosystem adopting exactly this model.
  Its own stated rationale is verbatim our argument: attestations "do not increase trust in the
  index itself" — the value comes entirely from the *external* Sigstore identity binding, not
  from trusting the host. `cibuildwheel` + `gh-action-pypi-publish` now attach attestations
  **by default** for CI-built native wheels.
- **Homebrew** already verifies a Sigstore attestation of a *downloaded binary* (a bottle) at
  `brew install` time (beta) — a direct precedent for exactly what the design note proposes.
- **Go** `sum.golang.org` is a transparency-log trust root at ecosystem scale that predates
  Sigstore — proof the pattern holds up under load.

**Where we would be early:** no Node native-addon *installer* does install-time attestation
verification today. Concept is proven (Homebrew) and endorsed upstream (npm, PyPI); we would be
an early mover *within the Node ecosystem*, not inventing anything.

Operational note carried over to the design: `gh attestation verify` is a poor *runtime*
dependency (version-gated to recent `gh`, needs auth, default-fetches from the API).
`@sigstore/verify` / `sigstore` (sigstore-js) is the better building block for a hands-off
install-time check.

---

## 4. Measurement: is "retire the download" actually viable for node-re2?

The industry answer (§2.2) is "ship the binary in npm." Whether that is *viable* for node-re2
depends entirely on binary size, because node-re2 statically links the RE2 library. Measured
against the real `1.25.2` GitHub Release assets (2026-07-07).

**Matrix shape:** assets are named `<platform>-<arch>-<abi>` with ABIs 127/137/147 — node-re2
ships **per-Node-major (ABI-specific)** binaries: **8 platform/arch combos × 3 ABIs = 24
binaries per release**. The matrix grows by one full platform-column every Node major (the ABI
treadmill). Release assets are brotli-compressed; a `prebuildify` bundle ships *uncompressed*
`.node` files and lets npm gzip the tarball, so the numbers below convert brotli → uncompressed
→ gzip using measured ratios (linux-x64: 6.14 MiB brotli → **27.64 MiB unpacked** → 8.59 MiB
gzip; sample-wide gzip/brotli ≈ 1.39×; unpacked/brotli ≈ 3.9× darwin, 4.5× linux, 2.7× win).

### Option 1a — bundle all prebuilds in one tarball (prebuildify / Model A)

Every user downloads and unpacks *every* platform's binary.

| Matrix | Gzipped (npm download) | Unpacked (on disk) |
| --- | --- | --- |
| Current per-ABI (24 binaries) | **~107 MiB** | **~340 MiB** |
| N-API-collapsed (8 binaries) | **~36 MiB** | **~115 MiB** |

**Verdict: not viable.** Even the best case — migrate to N-API to collapse the ABI axis —
ships ~36 MiB gzipped and unpacks ~115 MiB to every user on every install, regardless of
platform. This is disqualifying for a 2.5M-downloads/week package.

### Option 1b — per-platform npm packages (napi-rs/esbuild/sharp style / Model B)

Each user installs only the one platform package that matches `os`/`cpu`/`libc`.

| User platform | Gzipped download | vs today (brotli from GitHub) |
| --- | --- | --- |
| linux-x64 | ~8.6 MiB | ~6.1 MiB (≈ 40% larger — gzip vs brotli) |
| macOS / Windows | sub-MiB | comparable |

**Verdict: size-viable** — per-user footprint is comparable to today (~40% larger download on
Linux because npm tarballs are gzip, not brotli). Gets class-(b) integrity for free (npm SRI) +
optional class-(c) provenance. **But** it is a real restructure: node-re2 becomes a main package
publishing 8–24 satellite packages every release; it inherits the well-known npm
`optionalDependencies` resolver bug (the recurring `Cannot find module @rollup/rollup-linux-x64-gnu`
class of lockfile-omission failures across CI/Docker); requires npm ≥ 9.6.5 for musl filtering
and drops yarn v1. And it **obsoletes install-artifact-from-github for node-re2**.

### Side finding (independent of the integrity decision)

The Linux binary is **27.64 MiB unpacked vs macOS 1.45 MiB — 19×**, with a high (4.5×)
compression ratio. This strongly suggests the Linux `.node` is **unstripped** (or statically
links abseil/ICU with full symbol tables). Hypothesis, not confirmed — worth a `strip` check on
the build output. If it holds, stripping would shrink today's download *and* improve every
bundle option's math; it is a cheap win worth pursuing regardless of which option is chosen.
(N-API migration is a second orthogonal win: it collapses 24 → 8 binaries and ends the
per-Node-major treadmill, and install-artifact-from-github already supports it via `--napi`.)

---

## 5. The decision fork and recommendation

The survey splits the problem into two genuinely different strategies. Both land at class-(b)
or class-(c) integrity; they differ architecturally.

- **Option 1 — retire the download for node-re2.** Only survives as **Model B** (per-platform
  npm packages); Model A (bundle-all) is disqualified by size (§4). Model B moves the binary
  into npm (removing the trust boundary) at the cost of a substantial restructure, the npm
  optional-dep resolver fragility, dropping yarn-classic, and obsoleting this package for its
  primary consumer. It does *not* cleanly preserve the audited-mirror / air-gap `--host`
  flexibility this package was built for (though those deployers already mirror npm, so it is
  not a hard loss).

- **Option 2 — keep the downloader, harden it to class (c).** The design note's plan: optional
  Sigstore attestation via `@sigstore/verify` (probed in the consumer; this package stays
  zero-dep), node-re2 ships the `.sigstore` bundle + `sigstore` dep, verification
  optional/source-scoped so mirror + air-gap deployments keep working. Smaller, well-precedented
  change; keeps the package's reason to exist; we are early-but-not-alone in Node.

**Recommendation:** the measurement tilts toward **Option 2 for node-re2**. The clean simple
version of "retire the download" (bundle-all) is impossible at these sizes; the surviving
version (Model B) is a heavy restructure with a known reliability tax, and it does not clearly
dominate hardening the existing boundary with the strongest available trust root. Option 2 keeps
the mirror/air-gap deployments intact and is a proportionate response to the advisory. The one
remedy the survey positively rules out is the reporter's own (in-band `SHASUMS256.txt`, class a).

Orthogonal wins worth taking regardless of the option chosen: **strip the Linux binaries** (§4
side finding) and **migrate node-re2 to N-API** (24 → 8 binaries, ends the ABI treadmill).

---

## 6. Sources

- prebuild-install source + README: github.com/prebuild/prebuild-install (`download.js`, `util.js`)
- @mapbox/node-pre-gyp: github.com/mapbox/node-pre-gyp (`lib/install.js`)
- node-gyp header verification: github.com/nodejs/node-gyp (`lib/install.js`)
- pkg-prebuilds: github.com/julusian/pkg-prebuilds
- prebuildify + node-gyp-build: github.com/prebuild/prebuildify, github.com/prebuild/node-gyp-build
- napi-rs release model: napi.rs/docs/deep-dive/release; package-template: github.com/napi-rs/package-template
- esbuild optionalDependencies move: github.com/evanw/esbuild/pull/1621, issue #789
- sharp migration to npm-hosted binaries: sharp.pixelplumbing.com/changelog/v0.33.0, github.com/lovell/sharp#3750
- npm optional-dep resolver bug: github.com/npm/cli#4828, #8320; vitejs/vite#15532
- GHSA-7cgc-fjv4-52x6 (bignum/node-pre-gyp S3 takeover): github.com/advisories/GHSA-7cgc-fjv4-52x6
- GHSA-gv7w-rqvm-qjhr (withdrawn esbuild/Deno integrity RCE): github.com/advisories/GHSA-gv7w-rqvm-qjhr
- npm provenance: docs.npmjs.com/generating-provenance-statements; github.blog "Introducing npm package provenance"
- @sigstore/verify / sigstore-js: github.com/sigstore/sigstore-js
- GitHub artifact attestations: github.com/actions/attest-build-provenance; cli.github.com/manual/gh_attestation_verify
- PyPI PEP 740: peps.python.org/pep-0740; blog.pypi.org/posts/2024-11-14-pypi-now-supports-digital-attestations
- cibuildwheel + attestations: cibuildwheel.pypa.io/en/stable/deliver-to-pypi; github.com/pypa/gh-action-pypi-publish
- Homebrew build provenance: blog.sigstore.dev/homebrew-build-provenance; Homebrew/brew#17019
- Go checksum database: go.dev/blog/module-mirror-launch
- node-re2 1.25.2 release assets (measured 2026-07-07): github.com/uhop/node-re2/releases

**Measurement caveats:** unpacked/gzip figures are computed from three sampled binaries
(darwin-arm64, linux-x64, win32-x64 at ABI 137) extrapolated across the matrix by the measured
per-platform ratios, not a full 24-binary download. The Linux-unstripped hypothesis is
inferred from the size/ratio, not confirmed against the build. Third-party download counts and
tool version/deprecation states are as of the 2026-07-07 survey and will drift.

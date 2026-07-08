# Design note: artifact integrity via a client-owned hash bag

**Status:** Proposed — chosen design. Supersedes the Sigstore/attestation direction in
`artifact-integrity-verification.md` (that note's threat-model and trust-root reasoning still
stand; its *mechanism* is now an "alternative considered" — see §11).
**Date:** 2026-07-07.
**Origin:** the CWE-494 disclosure (draft advisory GHSA-88q3-gch3-5396). The field survey
(`artifact-distribution-field-survey.md`) and the design discussion that followed converged here.
**Publishing the advisory:** `advisory-GHSA-88q3-gch3-5396.md` — ready-to-paste Patches/Workarounds
text and the accept → set-patched-version → publish procedure.

This note specifies how a downloaded native addon is verified against a **hash bag embedded in
the consuming package's own `package.json`** — the one channel that is immutable (npm) and that
an attacker who compromises the GitHub account/release cannot rewrite. No signing key, no
Sigstore, no transparency-log service, no extra network, no runtime dependency.

Three goals, in the author's words: **tight, secure, good DX.**

---

## 1. What we defend (and what we don't)

**Defended — the disclosure's core:** an attacker who can influence the *default* download
(swap a GitHub Release asset after publish, a compromised CDN hop, an on-path swap on the
`github.com` path) substitutes a malicious `.node`, which is then written and `require()`-loaded
→ code execution. The hash bag rejects any binary whose bytes are not the ones the maintainer
published.

**The decisive scenario (why this and not signing):** the attacker owns the GitHub account,
rebuilds malicious code, and drops the malicious binary onto the *old* release **without
publishing a new npm version**. Because the expected hashes live in the **already-published,
immutable** `re2@X.Y.Z` tarball, the swapped binary's SHA-256 won't match, and the attacker
cannot rewrite that tarball (that would require a new npm publish — a loud, immutable, opt-in
event, further guarded by npm 2FA). → reject → build from source.

**Explicitly out of scope** (unchanged from the original threat model):
- **Custom-mirror / `--host` deployments.** The bytes there are the deployer's trust root
  (Company A serves its own audited build; Company B is air-gapped). We do **not** check them —
  see §6 source-scoping. An attacker who can set your mirror env var already owns the machine.
- **A compromise *before* the maintainer's clean publish** (garbage-in): no post-hoc check helps.
- **A new malicious npm version.** Immutable, visible, opt-in, npm-2FA-guarded — a different,
  louder attack than the silent old-release swap.
- **Build-system compromise** (malware injected into CI without a source change): SLSA
  build-integrity territory, not a consumer-side concern.

---

## 2. The mechanism in one paragraph

At release time the maintainer computes the SHA-256 of each platform's **decompressed `.node`**
and embeds a map `{ slot → sha256 }` into the package's `package.json`, then publishes. At
install time, `install-from-cache` (already running in the consumer's `install` hook) downloads
the binary from the **default `github.com`** source, decompresses it, and — before writing it to
disk — compares its SHA-256 against the bag it reads from the same immutable `package.json`.
Match → write. Mismatch, or a binary present that the bag doesn't cover → **reject → source
build**. Custom `--host`, or no bag at all → skip (unchanged behavior).

The trust root is the immutability of the npm-published `package.json`. Nothing else.

---

## 3. Where the bag lives — the client package, never here

The hash bag is **data owned by the client** (`node-re2`, or any consumer), embedded in **the
client's** `package.json`. It is emphatically **not** stored in `install-artifact-from-github`
or any third package:

- `install-artifact-from-github` is a generic, zero-dependency tool shared by many consumers. It
  cannot hold any one consumer's hashes, and it must not grow per-consumer data.
- The hashes are only trustworthy because they ride the **consumer's own immutable npm version**.
  A hash bag in a *shared* package would be pinned to *that* package's version, not the
  consumer's release — the wrong immutability boundary.

`install-from-cache` already reads the consumer's `package.json` at install time (it parses
`process.env.npm_package_json` for `github`, `version`, `scripts.verify-build`). Reading one more
field — the bag — is free and requires no new plumbing. The *tooling* to generate the bag is
shared (§8); the *bag* is the client's.

---

## 4. Bag format

A top-level object in the client `package.json`, keyed by the same **slot string**
`install-from-cache` already computes for the download URL:

```jsonc
{
  "name": "re2",
  "version": "1.25.2",
  "artifactHashes": {
    "linux-x64-137":        "sha256:9e68bb76…",
    "linux-musl-arm64-147": "sha256:c27d339e…",
    "darwin-arm64-137":     "sha256:fe4fe40a…",
    "win32-x64-127":        "sha256:aad2c369…"
    // one entry per built (platform-arch-abi) slot; N-API slots read `…-napi-v8`
  }
}
```

- **Key** = `${platform}-${arch}-${abiSlot}` — identical to what `install-from-cache` computes
  (`abiSlot` is `${modules}` or `napi-v${level}`). Prefix/suffix are *not* part of the key
  (they're transport-layer decoration); the key is the platform identity. Both sides derive it
  from one shared function so they can never disagree.
- **Value** = `sha256:` + lowercase hex of the **decompressed `.node`** (the bytes that run),
  never the `.br`/`.gz` wire bytes (compression is non-deterministic across encoders/mirrors).
  The algorithm prefix leaves room for future hashes; SRI form (`sha256-<base64>`) is an
  acceptable alternative if matching npm's own `integrity` style is preferred.

Field name (`artifactHashes`), value form, and bin name (§8) are the only bikeable choices; the
mechanism doesn't depend on them.

---

## 5. Verification — the change in `install-from-cache`

`install-from-cache.js` today: for each compression format it does `get → decompress → write →
copied=true`. The change: the fallback chain produces the **decompressed buffer only**; then a
single verify step gates the write.

```js
import {createHash} from 'node:crypto';            // built-in, keeps the package zero-dep

const isDefaultSource = !mirrorHost && !process.env[mirrorEnvVar];   // §6
const slot = `${platform}-${platformArch}-${abiSlot}`;               // shared slot fn
const bag  = pkg.artifactHashes;                                     // read from parsed package.json

// … fallback chain yields the decompressed `artifact` Buffer …

const verdict = verify(artifact);        // 'accept' | 'reject' | 'skip'
if (verdict !== 'reject') {
  await write(artifactPath, artifact);
  copied = true;
}                                        // 'reject' leaves copied=false → falls through to rebuild

function verify(bytes) {
  if (!isDefaultSource || !bag) return 'skip';          // custom host, or bagless package
  const expected = bag[slot];
  const actual = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
  if (expected && expected === actual) return 'accept';
  console.log(`Integrity check failed for ${slot}: building from sources …`);
  return 'reject';                                       // mismatch OR missing entry → reject
}
```

The three-case behavior, exhaustively:

| Situation | Verdict | Result |
|---|---|---|
| Default `github.com`, bag present, hash **matches** | accept | write the binary |
| Default `github.com`, bag present, hash **mismatches** | reject | discard → `npm run rebuild` |
| Default `github.com`, bag present, **no entry for this slot** | reject | discard → `npm run rebuild` |
| `--host` / mirror env set | skip | write (deployer's trust root) |
| No `artifactHashes` in `package.json` | skip | write (unchanged; every existing consumer) |

**Why "missing entry → reject" and not "→ proceed":** because the maintainer builds *before*
publishing (see §9), the bag is **complete** — every binary that exists in a release is hashed.
So a binary that downloads from the default source but has *no* bag entry is an anomaly the
maintainer's workflow cannot produce; the safe reading is "this shouldn't exist" → reject. This
closes the otherwise-open hole where an attacker uploads a malicious binary for a slot that had
no prebuilt at release (hence no hash). A false positive (a hashing bug that omits a real slot)
degrades safely to a source build.

Verification runs wherever the `install` hook runs. Under npm 12's script-off default the user
approves the install script exactly as they approve the download today — same gate, no new
surface (see `[[topics/npm-12-install-scripts-default-off]]`).

---

## 6. Source-scoping

Verification is gated on `isDefaultSource = !mirrorHost && !process.env[mirrorEnvVar]` — i.e., we
verify **only** when the binary comes from the built-in `https://github.com` origin that the
maintainer actually publishes and hashes. The instant a consumer sets `--host` / `--host-var` /
the mirror env var, we **skip** verification entirely.

This is not a gap — it's the point. A curated mirror legitimately serves *different* bytes (its
own audited build), whose hash isn't in our bag; checking it would wrongly reject a valid binary
and break exactly the deployment the mirror feature exists for. We never look, so we never break
it. The download already resolves `mirrorHost || process.env[mirrorEnvVar] || 'https://github.com'`,
so "is this the default origin?" is known for free at the gate.

---

## 7. Opt-out: force a source build (download nothing)

The strongest integrity choice a consumer can make is to **not download at all** — compile from
source, trusting only the immutable npm-delivered JS plus the local toolchain. Nothing is
fetched, so there is nothing to verify; the hash bag is moot.

This is already possible, but implicitly: `install-from-cache` short-circuits straight to
`npm run rebuild` when `DEVELOPMENT_SKIP_GETTING_ASSET` is set or a `.development` file exists.
We add an explicit, security-framed control beside them, following the project's
`--flag` / `--flag-var ENVVAR` / `DEFAULT_ENVVAR` cascade, so the intent reads as a security
choice rather than a "development" flag:

- `--force-build`
- `--force-build-var <ENVVAR>` — lets a library expose a namespaced var, e.g. node-re2 wiring
  `--force-build-var RE2_FORCE_BUILD`
- `DOWNLOAD_FORCE_BUILD`

Any of these (the pre-existing `DEVELOPMENT_SKIP_GETTING_ASSET` / `.development` stay, for
back-compat) extends the existing top-of-flow short-circuit: `install-from-cache` skips the
download attempt entirely and goes straight to `npm run rebuild`. Because it fires **before any
URL is built, any byte fetched, or any hash checked**, it composes cleanly with everything above
— the download path, and therefore §6 source-scoping and §5 verification, simply never run.

**Why it belongs in the security story.** It collapses the trust surface to the two things a
consumer already trusts unavoidably — **npm** (the JS + this control) and **their own compiler**
— and gives a deployer who doesn't want to trust *any* prebuilt binary (ours or a mirror's) a
one-word, self-documenting opt-out, with no `.development` file to invent or mirror flags to
reason about. It is the natural companion to the default: *verify what you download, or download
nothing and build it yourself.*

## 8. The generator utility

A new **bin in `install-artifact-from-github`** (shared tooling; the *data* it writes lands in
the client). Working name `hash-github-cache` — sibling to `install-from-cache` /
`save-to-github-cache`; bikeable.

**Job:** sniff the release's artifacts, compute each decompressed `.node`'s SHA-256 keyed by
slot, and write the `artifactHashes` bag into the client `package.json`.

**Inputs (two source modes):**
- `--from-release [<tag|version>]` *(recommended; defaults to the current `package.json`
  `version`, so hooks need no shell-variable plumbing)* — enumerate the GitHub Release assets (via the
  repo from `package.json` `github`), download each slot's asset, decompress, hash. Hashes
  **exactly the bytes users will download**, from the same place, and a single invocation sees
  every platform (no cross-matrix collection needed). Public-repo asset download needs no token.
- `--from <dir>` — hash slot-named artifacts already collected locally (for single-host builds or
  network-free CI). Same decompress-then-hash path.

**Reuses `install-from-cache`'s own logic** for the slot string and the decompression fallback,
so the generator and the verifier are guaranteed to agree on both the key and the hashed bytes.

**Modes:**
- `--write` — stamp/refresh `artifactHashes` in `package.json` (the release path).
- `--check` — recompute and **exit non-zero** if the bag is missing, stale, or wrong, writing
  nothing (the publish guard, §9).

**Faithfulness:** it decompresses and hashes the `.node`, identical to what the verifier does at
install — the two share the code, so a bag produced here always verifies there.

---

## 9. Automation & DX

The maintainer builds **before** publishing and never adds artifacts post-publish (the "build
after publish / rebuild botched artifact" capability exists but has never been used in practice).
So the release ordering is: **tag → CI builds every platform → `save-to-github-cache` uploads the
assets → hash the release → publish.** The bag is always complete at publish time.

One npm hook makes plain `npm publish` self-completing. This relies on npm packing an in-hook
`package.json` edit, which is **verified** (npm 11.17.0): a lifecycle hook that rewrites
`package.json` before packing produces a tarball containing the edit — the pack step reads files
from disk after the hooks run. `npm publish` runs `prepublishOnly` → `prepack` → *pack*, so:

```jsonc
{
  "scripts": {
    "prepublishOnly": "hash-github-cache --write"
  }
}
```

- **Why `prepublishOnly`:** it runs **only** on `npm publish` — never on `npm pack` or
  `npm install` — so the network fetch of release assets happens exactly when publishing and
  nowhere else. (`prepack` would also work timing-wise but fires on every `npm pack`.)
- **The write *is* the guard.** The bag is regenerated from the live release on every publish, so
  it cannot be stale by construction; and `hash-github-cache` **fails hard** — aborting the publish —
  if the release is missing or incomplete for the version being published. There is no
  "publish → check → fail → fix → publish again" loop; the fix happens inline or the publish dies.
- **`--check` remains** for everything else: CI verification, and **post-publish tamper
  monitoring** — `hash-github-cache --check --from-release <version>` at any later time confirms the
  live release assets still match the published bag; a failure means an asset changed after
  publish. One tool: prevention at install (consumers reject a swap), detection after publish
  (the maintainer notices it).
- **Caveats:** never mutate `name`/`version` in a hook (npm reads those at CLI start; a custom
  field like `artifactHashes` is safe — verified above). The hook leaves the stamped
  `package.json` in the working tree — commit it after the release. The tagged commit necessarily
  predates the bag (artifacts are built *from* the tag), which is fine: the npm tarball, not git,
  is the trust root. After the first release, `npm view <pkg>@<version> artifactHashes` is a
  quick sanity check that the registry metadata saw the field; regardless of that metadata view,
  the tarball — what installs actually read — is the verified carrier.

For a maintainer who prefers `package.json` never to be machine-edited mid-publish, the
two-command alternative avoids lifecycle timing entirely, with `--check` as the publish guard:

```jsonc
{
  "scripts": {
    "release":        "hash-github-cache --write && npm publish",
    "prepublishOnly": "hash-github-cache --check"
  }
}
```

**Prerequisite either way:** all release assets must exist before the bag is generated — already
true given build-before-publish. A publish attempted before the release is populated fails
loudly rather than shipping a partial bag.

---

## 10. Client adoption guide (e.g. node-re2)

For a consumer that already downloads via `install-from-cache`:

1. **Bump `install-artifact-from-github`** to the version that ships `hash-github-cache` +
   source-scoped verification. No other dependency — verification is `node:crypto`.
2. **Add the `prepublishOnly` script** from §9 — plain `npm publish` then stamps a fresh bag and
   ships it in the packed tarball.
3. **First bag:** the next `npm publish` stamps it automatically (run `hash-github-cache --write`
   beforehand to preview the diff); commit the stamped `package.json` after the release.
4. **CI:** ensure the release is fully populated (all matrix builds uploaded) before the publish
   job runs `npm publish` — the hook does the rest.
5. **Nothing changes for consumers of *your* package** — they just start getting a verified
   binary on the default source; mirror users are unaffected (§6).

Pairs naturally with the **strip step** already queued for node-re2
(`[[projects/node-re2/queue]]`): stripping shrinks the very bytes this hashes, and both live in
the same pre-publish build stage.

---

## 11. Alternatives considered, and why each loses

- **In-band `SHASUMS256.txt` in the release** (the reporter's suggestion) — class-(a): the hash
  file sits in the *same mutable release* as the binary, so the same account compromise rewrites
  both. Useless against the decisive scenario. The hash bag is the *same idea moved to the
  immutable npm channel*, which is the whole difference.
- **Sigstore keyless attestation** — the trust root (Rekor + CI OIDC) sits outside the account,
  which defeats a binary swap by someone who *can't* run your CI. But an **account-compromise
  attacker can run your CI**, minting a *genuinely valid* attestation over the malicious binary
  (append-only Rekor never rejects a second attestation for the same version). So it doesn't stop
  the decisive scenario without an extra immutable pin — at which point the pin (a hash/commit in
  npm) is doing the work and the Sigstore machinery (a `sigstore` dep + a `.sigstore` asset per
  binary + a trust root) is dead weight. Research confirmed the account-compromise hole and that
  the rich attestation fields (commit, ref, run-id, Rekor time) don't close it.
- **Maintainer-held signing key (minisign/GPG-style)** — *would* defeat the scenario if the key
  lived outside the account. But research confirmed **no signing key stored in GitHub can be
  protected** against a compromised account/token: Actions secrets are handed to any triggerable
  job with no use-time 2FA, and environment "required reviewer" gates are approvable via a plain
  REST call by a held token (self-approval on by default). So a key-based scheme needs an
  *external hardware token* — real key-custody burden — to beat what the hash bag achieves with
  no key at all.
- **Reject-duplicates via the transparency log** ("count how many binaries were attested as vX")
  — not implementable: Rekor and GitHub's attestations API are both keyed by *artifact digest*,
  not version/ref, so you cannot enumerate "all attestations claiming `refs/tags/1.25.2`"; the
  malicious binary is a different digest with its own single valid attestation (count = 1);
  Rekor v2 removed online search; and even hypothetically, "earliest-wins" is unsound (an
  attacker who attests *first* is selected). Also inherently online.
- **Ship binaries in npm (prebuildify / per-platform `optionalDependencies`)** — makes CWE-494
  not-applicable (npm SRI covers the bytes) and is the industry trend (sharp migrated this way),
  but for node-re2 the full-matrix bundle is disqualified by size and the per-platform-packages
  route is a heavy restructure with the well-known npm optional-dep resolver breakage. See the
  field survey. The hash bag keeps the download model and adds the missing integrity in ~30 lines.

**Complementary hardening (not a replacement):** enabling GitHub **immutable releases** (recent,
off by default) makes release assets tamper-proof after publication and blocks tag resurrection —
it blunts the swap-on-old-release vector at the GitHub layer. Worth turning on; the hash bag
stays primary because it is self-contained and also covers mirror/MITM/any-source cases a
GitHub-only feature can't.

---

## 12. Security properties, summarized

- **Trust root:** immutability of the client's npm-published `package.json`. No key, no
  third-party service, no transparency log.
- **Prevents:** silent post-publish swap of a `github.com` release binary (the disclosure's
  decisive scenario) — mismatch or unbagged-binary → source build.
- **Zero added attack surface:** no new network call (bag is local), no new dependency
  (`node:crypto`), no signing identity to leak.
- **Non-breaking:** custom-host and bagless installs behave exactly as today.
- **Opt-out:** `--force-build` / `DOWNLOAD_FORCE_BUILD` (§7) skips the download entirely —
  download nothing, verify nothing, trust only npm + the local toolchain.
- **Fail-safe:** every rejection path degrades to the existing lossless source build — the worst
  case is "the user compiles, as they would have without us."

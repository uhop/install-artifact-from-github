# Design note: optional artifact integrity verification

**Status:** Proposed / draft — no code yet.
**Date:** 2026-07-06.
**Origin:** a private CWE-494 disclosure (downloaded native addon written and loaded with no integrity check), and the design discussion it triggered. See `SECURITY.md`.

This note proposes how `install-from-cache` can verify the integrity/provenance of a
downloaded artifact **without breaking any existing consumer or deployment**, and without
adding a runtime dependency to this (zero-dep) package. It is deliberately *optional,
source-scoped, and trust-root-agnostic* — the reasoning for those three words is most of the
note.

---

## 1. Problem and threat model

`install-from-cache` downloads a prebuilt native addon (`*.node`) and writes it to the
artifact path; the consumer then `require()`s it, executing native code. Today nothing checks
that the bytes are the ones the author published. Anyone who can influence the download —
a swapped GitHub Release asset, a compromised mirror, an on-path attacker on a plaintext hop —
achieves code execution at install and at every later `require()`.

**What we can meaningfully defend:** the *default public path* (fetch from `github.com`),
specifically the **release-asset-swap** scenario: an attacker who compromises the repo/account
and replaces the release binary *after publish*, with no npm republish and no lockfile change.

**What we explicitly do NOT try to defend** (see §9 for why each is out of scope):
transport security in general, curated-mirror deployments, air-gapped deployments, and
source-poisoning-via-CI. Those either belong to the deployer's trust boundary or cannot be
addressed without breaking the deployments that depend on the current behavior.

---

## 2. Constraints that shape the design (the hard ones)

1. **Zero runtime dependencies** in this package. Verification crypto must live in the
   *consumer's* dependency tree, probed at runtime — never bundled here.
2. **Generic tool, unknown consumers.** Any new default must be **non-breaking**: an existing
   consumer that does nothing must install exactly as it does today.
3. **Must not break curated mirrors (Company A).** A deployment that serves its *own* audited
   builds from its *own* servers (`--host` + naming flags) has a different trust root than
   GitHub. Mandatory verification against GitHub/Sigstore would reject their legitimate,
   intentionally-different binaries.
4. **Must not break air-gapped mirrors (Company B).** A closed network that mirrors npm but
   not GitHub cannot reach Sigstore's TUF/Rekor, and often runs plaintext `http`. Mandatory
   online verification (or mandatory TLS) locks them out.
5. **Convenience-vs-trust is irreducible.** The package exists to *skip compilation*; the
   strongest posture is *compile everything*. You cannot have both as the default. The design
   exposes switches so each deployer picks a side; it does not pick for them.

The recurring lesson: **integrity is "matches trust root X," and which X is correct is a
per-deployment decision.** Hardwiring one X breaks the deployers who chose another.

---

## 3. Trust model: three deployments, three boundaries

| Deployment | Source | Integrity boundary | This design's role |
| --- | --- | --- | --- |
| **Public default** | `github.com` | GitHub's TLS; residual = release-asset swap | **auto-verify GitHub provenance** when the consumer opted in via a dep |
| **Curated mirror (A)** | own servers, own naming | network isolation + own audited build | stay out of the way; verification off unless the org supplies its own |
| **Air-gapped (B)** | internal store, no internet | network isolation | force-build, or a consumer-supplied offline verifier |

`install-from-cache` enforces none of these boundaries by fiat; it provides mechanisms each
deployment opts into.

---

## 4. Design

### 4.1 Decision flow

```
if force-build (env/flag/.development):        →  recompile            # opt-out, unchanged mechanism
download artifact (existing .br → .gz → plain chain), decompress to `bytes`

pick a verifier:
  --verifier <module> supplied                 →  custom verifier
  else source is GitHub AND a Sigstore lib resolves  →  built-in Sigstore verifier
  else                                         →  none

run verifier(bytes, ctx) → { result, detail? }:
  result === 'accept'       →  write + optional functional smoke-test + done
  result === 'reject'       →  REJECT → recompile         # definitive failure: ALWAYS fatal
  anything else / no verifier:                            # undefined, unknown string, or a throw
        require-verify set   →  REJECT → recompile
        else                 →  write + continue           # non-breaking default
```

Two invariants make this safe:

- **A definitive verification failure (digest mismatch / wrong signer / not in log) is always
  fatal**, regardless of `require-verify`. "Can't verify" and "verification failed" are
  different outcomes; conflating them is the classic dangerous bug.
- **The built-in Sigstore verifier only auto-activates on the GitHub source.** A mirror host
  never triggers it, so Company A/B are untouched by default. `require-verify` + a custom
  `--verifier` still work on any source for deployments that want them.

Verification runs on the **decompressed bytes in memory, before `write()` and before the
functional smoke-test**, so a bad artifact is never written or loaded. (Today's
`verify-build`/`test` step runs *after* load and is a functional smoke-test, not an integrity
gate — it stays, but is no longer security-relevant.) Note this also verifies **cross-builds**
(`npm_config_platform*`), which currently skip *all* checking — provenance is
platform-independent, so that path strictly improves.

### 4.2 Verifier contract (the `--verifier` hook)

Loaded exactly like `--agent` (`loadAgent`): a module whose default export is an async
function returning a single verdict object.

```js
// export default async (bytes, ctx) => { result, detail? }
// ctx = { assetName, assetUrl, host, isGithubSource,
//         repo: { owner, name }, version, platform, arch, abi, napiLevel }
//
//   result === 'accept'  → use the artifact
//   result === 'reject'  → recompile — ALWAYS, ignores require-verify (definitive failure)
//   anything else        → indeterminate → require-verify decides (default: continue)
//                          (undefined, an unknown string, or a thrown error all land here)
// `detail` is an optional human-readable string for any result (logged).
```

Only the exact string `'accept'` uses the binary, so a broken or confused verifier fails
**toward not-accepting**, never toward silent acceptance. A throw is `indeterminate`, not
special-cased — so under `require-verify` a verifier that dies on a crafted input still fails
closed, and under the default policy it continues (no worse than having no verifier). The
built-in Sigstore verifier implements this same contract internally.

### 4.3 Built-in Sigstore verifier (the GitHub path)

- Probe `@sigstore/verify` (lean) or `sigstore` (umbrella) via dynamic `import()`; if neither
  resolves → indeterminate (`detail: 'no-verifier'`).
- Obtain the attestation **bundle** for the artifact (see §6 for retrieval); if none →
  indeterminate (`detail: 'no-attestation'`).
- Verify with a **policy pinning the signer**: certificate SAN under
  `https://github.com/<owner>/<repo>/…` (owner/repo from `npm_package_github`), issuer
  `https://token.actions.githubusercontent.com`. Optionally tighten to a specific workflow
  file via `--signer-workflow`.
- Verify the artifact digest (of the decompressed bytes) against the attested subject, and the
  Rekor inclusion proof. Pass → `{ result: 'accept' }`; any check fails → `{ result: 'reject' }`.

**Why the bundle can live anywhere (incl. a mutable release asset):** verification pins the
*signer identity* (which rides the immutable npm channel in the consumer's config) and checks
Rekor's append-only log. An attacker who swaps the binary cannot produce a bundle that
simultaneously attests *their* digest, is signed by *node-re2's* workflow identity, and is in
the log — they'd need a Fulcio cert for that OIDC identity (i.e. to actually run that
workflow). So bundle location is security-irrelevant; shipping it as an asset only buys
**no-auth / offline** verification.

### 4.4 Force-build opt-out (already exists; add a clear alias)

`isDev()` already short-circuits to a source build on `DEVELOPMENT_SKIP_GETTING_ASSET` or a
`.development` file. For the security framing, add an alias that reads correctly in a hardened
config:

- `--force-build` / `--force-build-var` (default env `DOWNLOAD_FORCE_BUILD`) → same
  `break checks` → `npm run rebuild` path.

Setting it collapses trust to **npm + the local toolchain** — no download, no extra root, no
hashes needed because there is nothing downloaded to verify.

### 4.5 Config surface (all additive, all optional)

| Flag | `-var` env default | Meaning |
| --- | --- | --- |
| `--force-build` | `DOWNLOAD_FORCE_BUILD` | skip download, build from source |
| `--verifier <mod>` | `DOWNLOAD_VERIFIER` | consumer-supplied verifier module |
| `--require-verify` | `DOWNLOAD_REQUIRE_VERIFY` | "can't verify" ⇒ reject+recompile (default: continue) |
| `--signer-workflow <path>` | `DOWNLOAD_SIGNER_WORKFLOW` | tighten built-in policy to one workflow file |

Precedence for `require-verify`: an explicit env value of `0`/`false` overrides the flag
(operator escape hatch). An attacker who can set env vars can already set `--host` to their own
mirror, so this does not widen the threat model.

### 4.6 What must be pinned where (invariants)

- **Expected signer identity** → the consumer's package (immutable npm channel). If the
  verifier trusted "whatever identity the bundle carries," swapping would win.
- **The verifier dependency** → the consumer's `dependencies`, so it is present at install
  time and lockfile-integrity-pinned (an attacker can't silently drop it).
- Nothing security-relevant is pinned in the GitHub Release, which is mutable.

---

## 5. Producer side (CI)

node-re2 already emits GitHub artifact attestations — `actions/attest-build-provenance@v4`
over `build/Release/re2.node` in every matrix job (`build.yml`). Two small hardenings:

1. **Fail the job if attestation fails** (don't leave an un-attested asset on the release).
2. **Publish the bundle as a release asset** next to the binary (e.g. `<asset>.sigstore`), so
   end users verify offline with no `gh` and no token — and so air-gapped mirrors can mirror
   it. `attest-build-provenance` exposes the bundle via its `bundle-path` output; add an upload
   step. (`save-to-github-cache` may grow a `--bundle` companion upload.)

---

## 6. Attestation retrieval (open, but recommended path)

Three ways for the built-in verifier to get the bundle:

- **(recommended) shipped asset** — fetch `<assetUrl>.sigstore`; no auth, offline-capable,
  mirrorable. Requires the producer step in §5.2.
- GitHub attestation API by digest — authoritative but generally needs a token (fine in CI,
  awkward on end-user machines).
- Rekor search by digest — public, no auth, but more work.

Recommend the shipped asset for the default path; allow a custom `--verifier` to choose
otherwise.

---

## 7. Worked examples

### 7.1 node-re2 (canonical consumer)

**`package.json`** — add the verifier to real `dependencies` (needed at install time, so not
devDeps):

```jsonc
{
  "dependencies": {
    "sigstore": "^5.0.0"          // or the lean subset: @sigstore/verify + @sigstore/bundle + @sigstore/tuf
  },
  "scripts": {
    "install": "install-from-cache --artifact build/Release/re2.node --host-var RE2_DOWNLOAD_MIRROR --skip-path-var RE2_DOWNLOAD_SKIP_PATH --skip-ver-var RE2_DOWNLOAD_SKIP_VER --require-verify --require-verify-var RE2_REQUIRE_VERIFY --force-build-var RE2_FORCE_BUILD || node-gyp -j max rebuild"
  }
}
```

**What each deployment gets, no extra user action:**

- **Public user** → source is `github.com`, `sigstore` is present (it's a dep), a bundle exists
  → **provenance verified before the binary is written**. A swapped binary → digest mismatch →
  recompile. A stripped attestation → `require-verify` → recompile. The ~99% are protected
  **by default**, because the dep is always present and mismatch is always fatal.
- **Company A** (`RE2_DOWNLOAD_MIRROR=https://artifacts.corp …`) → non-GitHub source →
  built-in verifier does not auto-activate; `require-verify` has no verifier to satisfy on a
  mirror source **and A did not ask for it** → their own audited binary installs unchanged.
- **Company B** (air-gapped mirror) → same as A; or they set `RE2_FORCE_BUILD=1` on the few
  capable build boxes; or they supply an offline verifier (§7.3).
- **Anyone** who wants zero download-trust → `RE2_FORCE_BUILD=1` → compile from source.

**Per-version immutability handles old releases for free:** the `--require-verify` in the hook
ships from the *next* release onward, and *that* release is attested. Installs of older,
un-attested versions carry their *old* hook (no `--require-verify`) and keep working. No flag
day, no conditional logic.

**CI:** already attests; add the two hardenings in §5.

### 7.2 Simpler generic consumer (backward-compatible no-op)

A small addon that never opted into provenance:

```jsonc
{
  "scripts": {
    "install": "install-from-cache --artifact build/Release/foo.node || node-gyp rebuild"
  }
}
```

No `sigstore` dep, no new flags. Behavior is **identical to today**: download from GitHub,
built-in verifier unavailable → `{ indeterminate: 'no-verifier' }`, `require-verify` off →
write and continue, silently. Zero friction, zero new surface. If it later wants provenance, it
adds the dep + CI attestation (and optionally `--require-verify`) — a strictly additive upgrade.

### 7.3 More complex generic consumers

**(a) Air-gapped, verifying mirrored GitHub-provenanced binaries offline.** The org mirrors the
binaries *and* their `.sigstore` bundles, ships a pinned Sigstore trusted root, and supplies a
custom verifier plus `--require-verify`:

```jsonc
"install": "install-from-cache --artifact build/Release/re2.node --host-var RE2_DOWNLOAD_MIRROR --verifier ./verifiers/offline-sigstore.mjs --require-verify || node-gyp -j max rebuild"
```

```js
// verifiers/offline-sigstore.mjs
import { readFile } from 'node:fs/promises';
import { Verifier, toTrustMaterial } from '@sigstore/verify';
import { bundleFromJSON } from '@sigstore/bundle';

const trustedRoot = JSON.parse(await readFile(new URL('./trusted-root.json', import.meta.url)));

export default async (bytes, ctx) => {
  try {
    const bundle = bundleFromJSON(JSON.parse(await readFile(ctx.assetUrl + '.sigstore', 'utf8')));
    const verifier = new Verifier(toTrustMaterial(trustedRoot));           // no TUF/Rekor network
    verifier.verify(bundle, {
      subjectDigest: { sha256: sha256(bytes) },                            // decompressed artifact
      certificateIdentity: {
        issuer: 'https://token.actions.githubusercontent.com',
        subjectAlternativeName: `https://github.com/uhop/node-re2/`        // prefix-pinned
      }
    });
    return { verified: true };
  } catch (e) { return { verified: false, reason: e.message }; }
};
```

Here the trust root is *shipped*, not fetched; the mirror serves both binary and bundle; and a
swap still fails because the pinned identity + signature can't be forged offline either.

**(b) Own signing infrastructure (not GitHub/Sigstore at all).** An org that signs its addons
with its own key (cosign, minisign, x509, whatever) supplies a verifier implementing *their*
scheme. `install-from-cache` stays trust-root-agnostic — it only cares about the verdict:

```jsonc
"install": "install-from-cache --artifact build/Release/foo.node --host-var FOO_MIRROR --verifier ./verifiers/minisign.mjs --require-verify || node-gyp rebuild"
```

This is the general shape: **the tool routes bytes + context to a verifier and enforces the
verdict; the trust root lives entirely in the consumer's module.** GitHub/Sigstore is just the
batteries-included default for the common case.

---

## 8. Testing

- **Existing mock-server suite stays green** — it runs the "no verifier" path (no `sigstore`
  installed) → indeterminate + continue → unchanged.
- **New tests are additive**, and mostly use an **injected fake verifier**
  (`--verifier ./tests/helpers/fake-verifier.js` returning a scripted verdict) to exercise the
  decision tree: verified→use, failed→reject (assert recompile), indeterminate×{require,
  continue}. No real Fulcio/Rekor in unit tests.
- **One integration test** may verify a **checked-in real bundle fixture** with `@sigstore/verify`
  to guard the built-in path end-to-end; keep it out of the fast unit loop.
- The `force-build` alias needs a test that it short-circuits to `rebuild` like `.development`.

---

## 9. Explicitly rejected alternatives (so they aren't re-proposed)

- **Mandatory hash pinned in the package.** Breaks Company A (their audited build ≠ upstream
  bytes) and forces a per-release, per-tuple manifest + build-before-publish choreography.
  Superseded by opt-in provenance.
- **`SHASUMS256.txt` in the release.** Defeated by the *same* account compromise that swaps the
  binary — the attacker rewrites both. Provenance's trust root is outside the account; this
  isn't.
- **Mandatory hashing at all.** A hash encodes one trust root; mandating it locks out
  deployers who chose another (A and B). Verification must be opt-in and source-scoped.
- **Reject `http://` / force TLS.** The mirror population is precisely the one without
  validatable TLS (closed nets, self-signed certs that Node can't validate anyway). Forcing TLS
  breaks them and buys nothing on the public path (GitHub never downgrades; its TLS can't be
  injected). Transport security is not a lever this tool can pull.
- **Making source-build the default (safe-by-default).** Destroys the package's reason to
  exist (skip compilation). Opt-out, not opt-in, is the only viable direction.

---

## 10. Open questions

1. `sigstore` (umbrella) vs `@sigstore/verify` + `@sigstore/bundle` + `@sigstore/tuf` (lean) as
   node-re2's dep — footprint vs simplicity.
2. Should node-re2 default `--require-verify` on immediately, or ship it "warn-only" for one
   release to observe field behavior first?
3. Exact built-in policy default: prefix-pin the repo (any workflow) vs require `--signer-workflow`.
4. Attestation retrieval default (§6) — commit to the shipped `.sigstore` asset?
5. Env-var names (bikeshed): `DOWNLOAD_*` prefix confirmed; exact suffixes TBD.

---

## 11. One-paragraph summary (for the reporter)

We are not missing an integrity primitive — every node-re2 release binary already carries an
unforgeable, transparency-logged GitHub/Sigstore provenance attestation whose trust root a
compromised account cannot reach. The gap is *consumer-side verification*, which we are adding
as an **optional, source-scoped, trust-root-agnostic** check: auto-on for the public GitHub
path (default-on for node-re2 by making the verifier a dependency), a definitive mismatch
always fatal, missing-attestation enforced per-consumer via `--require-verify`, a `--verifier`
hook for air-gapped/custom roots, and a `force-build` opt-out for npm-only trust. We decline
mandatory hashing and forced TLS because both would lock out the curated-mirror and air-gapped
deployments the tool was built to serve.

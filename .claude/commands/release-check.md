---
description: Pre-release verification checklist for install-artifact-from-github
---

# Release Check

Run through this checklist before tagging a new release. This package is a
zero-dependency, CommonJS, two-binary CLI helper. The deliverables are
`bin/install-from-cache.js` and `bin/save-to-github-cache.js` — there is no
public module surface, no build step, and primary consumer is `node-re2`.

## Steps

1. **Semver decision.** Review `git log <last-tag>..HEAD` and classify the
   diff:
   - New CLI flag, new env var, new compression format, new behavior toggle → minor.
   - Bug fix or doc-only change → patch.
   - Renamed flag, removed flag, changed default behavior, changed env-var
     name → major.
     Record the chosen bump before touching anything else.
2. **`README.md`** Release-history table includes a one-line entry for the
   new version.
3. **`wiki/`** (submodule): if any user-facing flag or env var changed, the
   relevant page (`Install-from-cache.md` / `Save-to-Github-cache.md` /
   `Making-local-mirror.md`) reflects it. Commit wiki changes separately
   inside the submodule.
4. **`package.json` verification:**
   - `version` reflects the bump chosen in step 1.
   - `files` whitelist matches what should ship. Tarball contains `bin/`,
     `package.json`, `README.md`, and `LICENSE`.
   - `bin` map points at `bin/install-from-cache.js` and
     `bin/save-to-github-cache.js`.
   - `repository`, `bugs`, `homepage`, `author`, `license` are accurate.
   - `dependencies` is empty (zero-dep policy).
5. **LICENSE** copyright year includes the current year.
6. **Regenerate the lockfile:**
   ```
   npm install
   ```
7. **Full check matrix** — all must pass cleanly:
   ```
   npm run lint
   npm run js-check
   npm test
   ```
8. **Dry-run publish** to verify tarball contents:
   ```
   npm pack --dry-run
   ```
   Confirm NONE of these appear: `tests/`, `wiki/`, `.github/`, `.claude/`,
   `tsconfig*.json`, `scripts/`.
9. **Stop and report** — surface:
   - Chosen version bump and the diff summary since the last tag.
   - Test / lint / pack-dry-run results.
   - Any unresolved issue flagged during the walkthrough.
     Do **not** commit, tag, or publish without explicit user confirmation.

# Security Policy

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues, pull requests, or discussions.**

Report privately through GitHub's **[Private Vulnerability Reporting](https://github.com/uhop/install-artifact-from-github/security/advisories/new)**
(the "Report a vulnerability" button under the repository's **Security** tab). This opens a
confidential advisory visible only to the maintainers and you.

If GitHub reporting is unavailable to you, email the maintainer at
**eugene.lazutkin@gmail.com** with `SECURITY` in the subject line. Please do not disclose
details publicly until a fix is released.

When reporting, please include:

- the affected version(s) and platform,
- a description of the issue and its impact,
- steps to reproduce or a proof of concept (a link to a private/secret gist is fine),
- any suggested remediation.

## Scope

This package downloads prebuilt native addon binaries from GitHub Releases on behalf of a
consuming package (for example, [node-re2](https://github.com/uhop/node-re2)). Reports about
the download, verification, or integrity of those artifacts are in scope for this repository
even when they surface through a consuming package's install script.

## Supported versions

Fixes are released against the latest published version. Please upgrade to the latest
`install-artifact-from-github` release before reporting, and pin the fixed version once one is
available.

## Disclosure process

- We aim to acknowledge a report within a few business days.
- We work to a coordinated-disclosure timeline (up to 90 days by default) and will keep you
  updated on progress toward a fix.
- With your permission, we credit reporters in the release notes and advisory. We are happy to
  coordinate a CVE through GitHub's CNA once a fix is validated.

Thank you for helping keep the ecosystem safe.

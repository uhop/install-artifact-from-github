# install-artifact-from-github [![NPM version][npm-img]][npm-url]

[npm-img]: https://img.shields.io/npm/v/install-artifact-from-github.svg
[npm-url]: https://npmjs.org/package/install-artifact-from-github

This is a no-dependency micro helper for developers of binary addons for Node. It is literally two small one-file utilities integrated with [GitHub releases](https://docs.github.com/en/free-pro-team@latest/github/administering-a-repository/about-releases). The project solves two problems:

- [save-to-github-cache](./Saving) saves a binary artifact to a Github release according to the platform, architecture, and Node ABI.
  - Designed to be used with [GitHub actions](https://github.com/features/actions).
- [install-from-cache](./Installing) retrieves a previously saved artifact, tests if it works properly, and rebuilds a project from sources in the case of failure.

In general, it can save your users from a long recompilation and, in some cases, even save them from installing build tools.
By using GitHub facilities ([Releases](https://docs.github.com/en/github/administering-a-repository/about-releases)
and [Actions](https://github.com/features/actions)) the whole process of publishing and subsequent installations are secure,
transparent, painless, inexpensive, or even free for public repositories.

## How to install

Installation:

```
npm install --save install-artifact-from-github
```

## How to use

In your `package.json` (pseudo-code with comments):

```js
{
  // your custom package.json stuff
  // ...
  "scripts": {
    // your scripts go here
    // ...

    // saves an artifact
    "save-to-github": "save-to-github-cache --artifact build/Release/ABC.node",

    // installs using pre-created artifacts
    "install": "install-from-cache --artifact build/Release/ABC.node",

    // used by "install" to test the artifact
    "verify-build": "node scripts/verify-build.js"

    // used by "install" to rebuild from sources
    "rebuild": "node-gyp rebuild"
  }
}
```

Examples of GitHub actions can be found in the documentation.

## Documentation

The full documentation is available in the [wiki](https://github.com/uhop/install-artifact-from-github/wiki).

## Release history

- 1.6.0 _added N-API support: `--napi` / `--napi-var` / `DOWNLOAD_NAPI` swap the URL slot from `${abi}` to `napi-v${level}`, collapsing the per-Node-major build matrix._
- 1.5.0 _added optional proxy support via `--agent` / `--agent-var` / `DOWNLOAD_AGENT`; converted to ESM; added an automated test suite; minimum Node bumped to 18._
- 1.4.0 _added support for uncompresed artifacts and selective compression format._
- 1.3.5 _propagated the previous timeout fix to the saving utility._
- 1.3.4 _minor fixes + a timeout fix: use a new default agent for GET. Thx, [Laura Hausmann](https://github.com/zotanmew)._
- 1.3.3 _minor refactor, added support for a personal token._
- 1.3.2 _added support for the 204 response and error logging._
- 1.3.1 _added a way to specify a custom build, thx [Grisha Pushkov](https://github.com/reepush) + a test._
- 1.3.0 _enhanced support for custom mirrors._
- 1.2.0 _support for NPM >= 7._
- 1.1.3 _technical release: updated docs._
- 1.1.2 _technical release: updated docs._
- 1.1.1 _numerous bugfixes to please Github REST API._
- 1.1.0 _moved `save-to-github` here from a separate project, reduced 3rd-party dependencies._
- 1.0.2 _fixed a `yarn`-specific bug._
- 1.0.1 _fixed a bug in the environment variable parameter._
- 1.0.0 _initial release (extracted from [node-re2](https://github.com/uhop/node-re2))._

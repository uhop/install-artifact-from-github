# install-artifact-from-github [![NPM version][npm-img]][npm-url]

[npm-img]: https://img.shields.io/npm/v/install-artifact-from-github.svg
[npm-url]: https://npmjs.org/package/install-artifact-from-github

This is a no-dependency micro helper for developers of binary addons for Node.
It is a companion project for [save-artifact-to-github](https://www.npmjs.com/package/save-artifact-to-github).
These two projects are integrated with [GitHub](https://github.com/) facilities and solve two problems:

* `save-artifact-to-github` saves a binary artifact according to the platform, architecture, and Node ABI.
* `install-artifact-from-github` retrieves such artifact, tests if it works properly, and rebuilds a project from sources in the case of failure.

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

    // creates an artifact (from save-artifact-to-github)
    "save-to-github": "save-to-github --artifact build/Release/ABC.node",

    // installs using pre-created artifacts
    "install": "install-from-cache --artifact build/Release/ABC.node",

    // used by "install" to test the artifact
    "verify-build": "node scripts/verify-build.js"

    // used by "install" to rebuild from sources
    "rebuild": "node-gyp rebuild"
  }
}
```

When a project, which uses `install-artifact-from-github`, is being installed, it does the following actions:

* Acquiring an artifact from the cache (an appropriate GitHub release).
  1. If the environment variable `DEVELOPMENT_SKIP_GETTING_ASSET` set to a non-empty value &rArr; it builds from sources.
  2. If the file `.development` is present in the project folder &rArr; it builds from sources.
  3. It tries to download an appropriate artifact compressed by `brotli`, if it is available. If it succeeds &rArr; it checks if it works.
  4. It tries to download an appropriate artifact compressed by `gzip`. If it succeeds &rArr; it checks if it works.
  5. If all downloads have failed &rArr; it builds from sources.
* In order to check that the downloaded artifact works:
  * It runs `npm run verify-build`. You may provide the script `verify-build` to do the checking.
    * If it returns with 0 exit code, we are done. Otherwise &rArr; it builds from sources.
  * If there is no `verify-build`, it tries `npm test`.
    * If it returns with 0 exit code, we are done. Otherwise &rArr; it builds from sources.
  * If both scripts are missing &rArr; it builds from sources.
* If it was determined to build the artifact from sources, it runs `npm run rebuild`, which should be provided.

### Environment variables

* `DEVELOPMENT_SKIP_GETTING_ASSET` &mdash; if it is set to a non-empty value, it forces the build from sources.
  It is useful for development and testing.
* `DEVELOPMENT_SHOW_VERIFICATION_RESULTS` &mdash; if it is non-empty, it shows the verification output.
  Otherwise, the output is suppressed so not to scary unsuspecting users with possible errors.
  It is useful for development and testing.
* `DOWNLOAD_HOST` &mdash; if set, its value is used instead of `https://github.com`.

This script is meant to be run using `npm run`. It relies on
[npm environment variables](https://docs.npmjs.com/misc/config#environment-variables) to learn about the project.

### Command-line parameters

* `--artifact path` &mdash; points where to place the downloaded artifact. It is a required parameter.
* `--prefix prefix` &mdash; provides a prefix for the generated artifact name. Default: `''`.
* `--suffix suffix` &mdash; provides a suffix for the generated artifact name. Default: `''`.
* `--host host` &mdash; provides a prefix for the download host. It should not end with `/`.
  Example: `--host https://sample.com/repo`.
  * If specified and non-empty, its value sets the host.
* `--host-var ENVVAR` &mdash; provides a name of an environment variable, which value will specify the download host.
  Example: `--host-var RE2_DOWNLOAD_MIRROR`.
  * Used only if `--host` is not specified.
  * If it is not specified, `DOWNLOAD_HOST` name is assumed.
  * If the specified environment variable is empty, `https://github.com` will be used.

Ultimately, the downloadable file name has the following format:

```js
`${host}/${user}/${repo}/releases/download/${tag}/${prefix}${platform}-${arch}-${abi}${suffix}.${compression}`
```

Where:

* `platform` is [process.platform](https://nodejs.org/api/process.html#process_process_platform).
  * Because Linux has different implementations of the C standard library, a special case is made for
    [musl](https://musl.libc.org/) used by such popular distributions like [Alpine](https://alpinelinux.org/).
    Such platforms have a code `linux-musl`.
* `arch` is [process.arch](https://nodejs.org/api/process.html#process_process_arch).
* `abi` is [process.versions.modules](https://nodejs.org/api/process.html#process_process_versions).
* `compression` can be `br` or `gz`.

Example with default values: `https://github.com/uhop/node-re2/releases/download/1.15.2/linux-x64-83.br`.

## Documentation

The additional documentation is available in the [wiki](https://github.com/uhop/install-artifact-from-github/wiki).

### Example

The realistic complex example can be found in [uhop/node-re2](https://github.com/uhop/node-re2):

* [package.json](https://github.com/uhop/node-re2/blob/master/package.json) sets it up.
* [builds.yaml](https://github.com/uhop/node-re2/blob/master/.github/workflows/build.yml) implements a complex workflow.

## Release history

- 1.0.2 *fixed a `yarn`-specific bug.*
- 1.0.1 *fixed a bug in the environment variable parameter.*
- 1.0.0 *initial release (extracted from [node-re2](https://github.com/uhop/node-re2)).*

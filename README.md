# install-artifact-from-github [![NPM version][npm-img]][npm-url]

[npm-img]: https://img.shields.io/npm/v/install-artifact-from-github.svg
[npm-url]: https://npmjs.org/package/install-artifact-from-github

This is a no-dependency micro helper for developers of binary addons for Node.
It is companion project is `save-artifact-to-github`.
These two projects are integrated with [GitHub](https://github.com/) facilities and solve two problems:

* `save-artifact-to-github` saves a binary artifact according to platform, architecture, and Node ABI.
* `install-artifact-from-github` retrieves such artifact, tests if it works properly, and rebuilds a project from sources in the case of failure.

In general it can save your users from a long recompilation and, in some cases, even save them from installing build tools.
By using GitHub facilities ([Releases](https://docs.github.com/en/github/administering-a-repository/about-releases)
and [Actions](https://github.com/features/actions)) the whole process of publishing and subsequent installations is secure,
transparent, inexpensive or even free for public repositories.

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

    // creates an artifact (from )
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

Now we have to enable GitHub actions on the project.

## Release history

- 1.0.0 *initial release (extracted from [node-re2](https://github.com/uhop/node-re2)).*

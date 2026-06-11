# Contributing to install-artifact-from-github

Thank you for your interest in contributing!

## Licensing

This project is distributed under the BSD-3-Clause license. External contributions are accepted only under licenses compatible with it &mdash; by submitting a contribution you agree that it can be distributed under the project's license.

## Getting started

This project uses a git submodule for the wiki. Clone and set up:

```bash
git clone --recursive https://github.com/uhop/install-artifact-from-github.git
cd install-artifact-from-github
npm install
```

See the [wiki](https://github.com/uhop/install-artifact-from-github/wiki) for documentation.

## Development workflow

1. Make your changes.
2. Format: `npm run lint:fix`
3. Test: `npm test`
4. Type-check: `npm run js-check`

## Code style

- ES modules (`import`/`export`), no CommonJS in source.
- Formatted with Prettier &mdash; run `npm run lint:fix` before committing.
- No dependencies &mdash; both utilities are intentionally zero-dependency, single-file bins.
- Update wiki documentation alongside code changes.

## AI agents

If you are an AI coding agent, see [AGENTS.md](./AGENTS.md) for detailed project conventions, commands, and architecture.

#!/bin/bash

# This is an example script to run save-to-github-cache.js locally, not in the context of Github Actions.
# Copy and modify for your specific project.

# IMPORTANT! Do not save the script with secrets in it in a publicly-available repository!

# Set the repository:
export GITHUB_REPOSITORY=uhop/install-artifact-from-github

# Set the release as a tag:
export GITHUB_REF=refs/tags/1.2.3-test

# Use a personal token: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/creating-a-personal-access-token
# Set it to read/write code of the repository, all we need is to write an artifact into existing release.
export PERSONAL_TOKEN=github_...

# Run save.
npm run save-to-github

---
name: release
description: Cut a new release of localactions — bump version, commit, tag, push, create GitHub release, and publish to npm.
argument-hint: [version]
allowed-tools: Read, Edit, Bash(bun *), Bash(git *), Bash(gh *), Bash(npm *), Bash(ls *), Glob
---

# Release localactions

Cut a new release of localactions. The user will provide the version number as `$ARGUMENTS` (e.g. "0.2.0"). If no version is provided, ask for one.

## Step 1: Bump version

Update the `version` field in `package.json` to the new version.

## Step 2: Commit and tag

```bash
git add package.json
git commit -m "Release v<version>"
git tag "v<version>"
```

## Step 3: Push

Push the commit and the tag:

```bash
git push && git push --tags
```

## Step 4: Create GitHub release

Create a GitHub release from the tag. Generate release notes from commits since the last tag:

```bash
gh release create "v<version>" --generate-notes
```

## Step 5: Publish to npm

Publish the package to npm:

```bash
npm publish
```

## Step 6: Verify

- Confirm the GitHub release exists: `gh release view "v<version>"`
- Confirm the npm package is published: `npm view localactions version`

Report the GitHub release URL and npm package URL to the user when done.

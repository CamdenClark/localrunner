---
title: "Alternatives"
weight: 10
---

# Alternatives

localrunner isn't the only way to test your GitHub Actions workflows. Here are some other approaches and how they compare.

## act

[act](https://github.com/nektos/act) is a popular tool for running GitHub Actions locally. It uses Docker containers to simulate the GitHub Actions environment.

**Pros:**
- Large community and widespread adoption
- Supports many GitHub Actions features

**Cons:**
- Uses its own custom runtime instead of the official GitHub Actions runner, so behavior can diverge from what actually happens on GitHub
- Some actions don't work or behave differently than on GitHub

localrunner takes a different approach: it launches the **official GitHub Actions runner binary** against a mock server implementing GitHub's internal runner protocol. This means the execution behavior matches GitHub much more closely.

## Just pushing and seeing what happens

The most common approach — commit, push, wait for GitHub Actions to run, check the results, and iterate.

**Pros:**
- No extra tools to install
- Tests against the real GitHub Actions infrastructure
- Zero setup

**Cons:**
- Slow feedback loop — each iteration requires a commit, push, and waiting for a runner to pick up the job
- Pollutes git history with "fix CI" commits
- Costs GitHub Actions minutes
- Requires network access
- Hard to debug failures — you only get logs after the fact

localrunner gives you a fast, local feedback loop so you can iterate on your workflows without pushing to GitHub every time.

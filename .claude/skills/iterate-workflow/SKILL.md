---
name: iterate-workflow
description: Test localrunner against a new workflow type by creating a temp workflow, running it, debugging failures, and committing fixes to a PR. Use when testing support for a new GitHub Actions feature, workflow pattern, or action.
argument-hint: [workflow-description]
allowed-tools: Read, Grep, Glob, Bash(bun *), Bash(git *), Bash(gh *), Bash(docker *), Bash(cat *), Bash(ls *), Bash(mkdir *), Edit, Write, Agent
---

# Iterate on Workflow Support

You are testing and fixing localrunner's support for a specific GitHub Actions workflow pattern. Follow this loop until the workflow runs successfully or you've identified the root cause and committed a fix.

The user will describe the workflow type or feature to test (e.g. "service containers", "reusable workflows", "composite actions", "artifact upload/download"). Use `$ARGUMENTS` as the description of what to test.

## Step 1: Create a temporary test workflow

Create a `.github/workflows/_test.yml` file in this repository that exercises the feature described by the user. Design the workflow to be:
- **Minimal** — only include steps needed to test the specific feature
- **Self-contained** — avoid dependencies on external secrets or services when possible
- **Fast** — prefer lightweight actions and short-running commands
- **Targeted** — exercise one feature at a time so failures are easy to diagnose

Use real-world patterns from GitHub Actions documentation. The workflow should trigger on `push`.

## Step 2: Run the workflow with localrunner

Run the workflow using:

```
bun cli.ts -W .github/workflows/_test.yml --verbose push
```

Use `--verbose` so you get full debug output for diagnosing issues.

Read the output carefully. Identify whether the run:
- **Succeeded** — the workflow completed without errors
- **Failed in localrunner** — the mock server or runner setup hit an error (this is what we want to fix)
- **Failed in the workflow itself** — the workflow steps failed due to workflow logic, not localrunner bugs

## Step 3: Diagnose and fix

If localrunner failed, investigate the root cause:

1. Read the verbose output to identify which server endpoint or step failed
2. Search the relevant source files (`server/`, `expressions.ts`, `workflow.ts`, `orchestrator.ts`, etc.)
3. Identify the gap — missing endpoint, incorrect response format, unsupported expression, etc.
4. Implement the fix in the localrunner source code
5. Run the unit tests with `bun test` to make sure you haven't broken anything

## Step 4: Re-run and iterate

After each fix, re-run the workflow:

```
bun cli.ts -W .github/workflows/_test.yml --verbose push
```

Repeat Steps 3-4 until the workflow succeeds or you've made as much progress as possible.

## Step 5: Clean up and commit

Once you've made fixes:

1. **Delete the temp workflow**: `rm .github/workflows/_test.yml`
2. **Run unit tests**: `bun test` to verify nothing is broken
3. **Commit only the localrunner source changes** (not the test workflow) with a descriptive message about what workflow feature is now supported
4. **Push and create/update a PR** using `gh pr create` or `gh pr edit`

## Important notes

- The temp workflow file `_test.yml` is just a test harness — never commit it
- If a fix requires changes to multiple files, commit them together as one logical change
- If you hit an issue that's too complex to fix in one pass, document what you found and what the next steps would be
- Always run `bun test` before committing to catch regressions

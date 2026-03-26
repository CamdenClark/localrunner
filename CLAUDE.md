# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**localrunner** is a local GitHub Actions workflow executor. It parses workflow YAML files, spins up a mock GitHub Actions server implementing GitHub's internal runner protocol, and launches the official GitHub Actions runner (in Docker or locally) to execute workflows without pushing to GitHub.

## Commands

- `bun test` — run unit tests (default profile)
- `bun test --config=acceptance` — run acceptance tests
- `bun test <file>` — run a single test file (e.g. `bun test expressions.test.ts`)
- `bun cli.ts push` — run workflows matching a `push` event
- `bun cli.ts pull_request` — run workflows matching a `pull_request` event
- `bun cli.ts -l push` — list matching workflows without running
- `bun cli.ts -W .github/workflows/test.yml push` — run a specific workflow
- `bun cli.ts -j <job-name> push` — run a specific job
- `bun cli.ts --raw push` — raw output mode (for agents)
- `bun cli.ts --verbose push` — verbose debug output

## Use Bun, Not Node.js

- `bun <file>` not `node` or `ts-node`
- `bun test` not `jest` or `vitest`
- `bun install` not `npm install`
- `bunx` not `npx`
- `Bun.serve()` not `express`; `Bun.file()` not `node:fs`; `Bun.$` not `execa`
- Bun auto-loads `.env` — no dotenv needed

## Architecture

### Entry Point & CLI (`cli.ts`)
Parses args (`-W`, `-j`, `-s`, `--var`, `--port`, `--raw`, `--verbose`) and orchestrates the run: discovers workflows, resolves context/secrets/variables, starts the server, and launches the runner.

### Workflow Parsing (`workflow.ts`)
Zod schemas validate workflow YAML. `matchesEvent()` filters workflows by event type, branch/tag patterns, and path filters.

### Mock GitHub Actions Server (`server/`)
A `Bun.serve()` HTTP server implementing the GitHub Actions runner protocol:
- **`auth.ts`** — OAuth token and connection data endpoints
- **`job.ts`** — Job acquire/renew/complete lifecycle
- **`actions.ts`** — Resolves action references (owner/repo@ref) to commit SHAs via GitHub API
- **`cache.ts`** — `actions/cache` API backed by local filesystem (`~/.localrunner/cache/`), 7-day TTL
- **`logs.ts`** — Log upload, timeline updates, WebSocket live feed on `/feed`
- **`results.ts`** — Results API (Twirp RPC protocol), blob uploads
- **`steps.ts`** — Builds step definitions (script steps vs action steps)

### Expression Evaluation (`expressions.ts`)
Evaluates `${{ expr }}` using a flat lookup table for `github.*`, `runner.*`, `env.*`, `secrets.*`, `variables.*` contexts. Flattens event payloads into dot-notation paths.

### Context & Secrets (`context.ts`, `secrets.ts`, `variables.ts`)
- Context: repo owner/name from git remote, SHA/branch from git, token from `gh` CLI
- Secrets: `.secrets` file → CLI `-s` args → env vars → GITHUB_TOKEN
- Variables: `gh variable list` → `.vars` file → CLI `--var` args

### Orchestrator (`orchestrator.ts`)
Builds JIT runner config (base64-encoded), launches the runner binary via Docker (`docker run`) or locally, writes event payload to temp file.

### Output (`output.ts`)
Three modes: **pretty** (colored, human-friendly, default), **raw** (minimal markers for agent parsing), **verbose** (full debug with timestamps).

## Testing

There are two test profiles configured in `bunfig.toml`:

- **`bun test`** — runs **unit tests** only (`*.test.ts` in project root). This is the default profile and what you should run after making code changes.
- **`bun test --config=acceptance`** — runs **acceptance tests** (`acceptance/`). These clone real repos and run localrunner end-to-end. Only run these when specifically asked or when testing end-to-end behavior.

Unit tests live alongside source files in the project root. Acceptance tests live in `acceptance/` and support sharding via `SHARD_INDEX`/`SHARD_TOTAL` env vars.

# CLAUDE.md — Dispatch CLI

## Project Overview
Dispatch is an AI-powered CLI tool for solving GitHub issues in batch. It creates branches, implements fixes, and opens PRs using Claude Code.

## Build and Test Commands
- **Build**: `npm run build`
- **Lint**: `npm run lint` (runs `tsc --noEmit`)
- **Test**: `npm test` (runs all tests in `dist/test/`)
- **Run (Dev)**: `node dist/bin/dispatch.js [command]`

## Code Style & Conventions
- **Language**: TypeScript (strict mode)
- **Module System**: ESM (use `.js` extensions in imports)
- **Formatting**: 2-space indentation
- **Error Handling**: Use `log.error` from `src/utils/logger.ts`
- **Logging**: Use the `log` utility (info, success, warn, error)
- **Testing**: Use Node.js native test runner (`node:test`) and `node:assert/strict`
- **Git Operations**: Use utilities in `src/utils/git.ts` and `src/utils/worktree.ts`
- **Dependency Management**: npm

## Architecture Guide
- `bin/`: CLI entry point
- `src/commands/`: CLI subcommands (run, create, init, status, schedule)
- `src/engine/`: AI adapters
- `src/github/`: GitHub API client (issues, PRs)
- `src/orchestrator/`: Pipeline, issue selection and readiness, per-issue solve flow (`solve-issue.ts`), verification, and evidence-based scoring
- `src/provenance/`: Session records, transcripts, redaction, commit trailers, and session refs (`refs/dispatch/sessions/*`)
- `src/reporter/`: Run summaries and the morning review queue
- `src/utils/`: Shared utilities (config, git, env scrubbing, logger, etc.)

## Safety Rules
- Never pass `GITHUB_TOKEN` or other credentials to agents or verify commands — use `scrubEnv` / `claudeEnv` from `src/utils/env.ts` and `src/engine/claude.ts`
- Redact transcripts and command output with `redactSecrets` before saving them
- Issue text and comments from untrusted authors must not reach a prompt (see `src/orchestrator/selection.ts`)

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
- `src/orchestrator/`: Pipeline, classification, and scoring logic
- `src/reporter/`: Run summaries and reports
- `src/utils/`: Shared utilities (config, git, logger, etc.)

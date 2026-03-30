# CLAUDE.md — Dispatch CLI

## Project Overview
Dispatch is an AI-powered CLI tool for solving GitHub issues in batch. It creates branches, implements fixes, and opens PRs using multi-provider AI (Claude, Gemini, OpenAI, GitHub Models). v2 adds smart per-phase model routing, a 3-tier memory system, cost tracking, and checkpoint/resume.

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
- **Logging**: Use the `log` utility (info, success, warn, error, debug)
- **Testing**: Use Node.js native test runner (`node:test`) and `node:assert/strict`
- **Git Operations**: Use utilities in `src/utils/git.ts` and `src/utils/worktree.ts`
- **Dependency Management**: npm
- **Commit Messages**: Do NOT include Co-Authored-By lines

## Architecture Guide
- `bin/`: CLI entry point (`dispatch.ts`)
- `src/commands/`: CLI subcommands (run, create, init, status, schedule, stats, providers, learn)
- `src/engine/`: AI engine adapters (claude, gemini, github-models, openai) + agentic loop + tool executor
- `src/router/`: ModelRouter — per-phase model selection, model registry, cost tracking, provider detection
- `src/memory/`: 3-tier memory system — codebase context cache (Tier 1), cross-issue insights (Tier 2), lessons from PR reviews (Tier 3 local)
- `src/github/`: GitHub API client (issues, PRs, comments, labels)
- `src/orchestrator/`: Pipeline (batched), classifier (heuristic + AI), scorer (heuristic adjustment)
- `src/reporter/`: Run summaries with cost breakdowns
- `src/telemetry/`: Anonymous analytics (local stats + optional PostHog)
- `src/utils/`: Shared utilities (config, git, logger, worktree, semaphore)

## Key v2 Concepts
- **ModelRouter**: Selects optimal model per pipeline phase (cheap for classify/score, strong for solve). Strategies: auto, provider-locked, pinned.
- **Memory Tier 1**: Codebase context cache at `.dispatch/memory/context.json` — project structure, patterns, dependencies. Regenerated when stale.
- **Memory Tier 2**: Cross-issue insights — discoveries from issue N feed into issue N+1. Batched pipeline (not all-parallel).
- **Memory Tier 3 (local)**: Lessons from PR reviews at `.dispatch/memory/lessons.json` — populated by `dispatch learn`. 30-day decay.
- **Cost Tracking**: Every run reports cost breakdown by phase and provider in the summary.
- **Checkpoint/Resume**: Progress saved to `.dispatch/checkpoint.json` after each issue. Use `--resume` to continue.

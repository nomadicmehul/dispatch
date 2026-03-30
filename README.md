# ⚡ Dispatch

[![npm version](https://img.shields.io/npm/v/dispatch-ai.svg)](https://www.npmjs.com/package/dispatch-ai)
[![npm downloads](https://img.shields.io/npm/dm/dispatch-ai.svg)](https://www.npmjs.com/package/dispatch-ai)
[![License](https://img.shields.io/badge/License-Apache%202.0%20WITH%20Commons--Clause-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org)
[![Beta](https://img.shields.io/badge/status-🧪_beta-blueviolet)](https://github.com/nomadicmehul/dispatch)

> **🧪 Beta** — Dispatch is under active development. APIs and behavior may change between releases.

**Dispatch your GitHub issues. Receive pull requests.**

Dispatch is an AI-powered CLI tool that solves GitHub issues in batch — creating branches, implementing fixes, and opening pull requests while you sleep. v2 adds smart model routing, a memory system that learns across issues and runs, cost tracking, and support for 4 AI providers.

Run it at night. Review PRs in the morning.

## Quick Start

```bash
# Install (beta)
npm install -g dispatch-ai@beta

# Initialize config in your repo
cd your-repo
dispatch init

# Set your GitHub token
export GITHUB_TOKEN=ghp_...

# Solve all open issues
dispatch run

# Preview what would happen (no changes)
dispatch run --dry-run

# Set up nightly automated runs via GitHub Actions
dispatch schedule
```

## Commands

### `dispatch run`

Fetches open issues, classifies them, solves each one with AI, and opens pull requests.

```bash
dispatch run                          # solve all open issues (auto-detect provider)
dispatch run --dry-run                # preview without making changes
dispatch run --label bug --label p0   # only solve bugs and P0 issues
dispatch run --max-issues 5           # limit to 5 issues
dispatch run --draft                  # create all PRs as drafts
dispatch run --provider gemini        # use a specific AI provider
dispatch run --strategy cost-optimized  # optimize for lowest cost
dispatch run --no-memory              # disable memory system
dispatch run --resume                 # resume from last checkpoint
dispatch run --base-branch develop    # target a different base branch
```

**What happens:**
1. Fetches open issues from your GitHub repo
2. Classifies each issue (bug fix, feature, investigation, audit, docs, refactor)
3. Prioritizes by labels (P0 → P1 → P2) and reactions
4. Loads memory context (codebase cache, past insights, PR lessons)
5. For each batch of issues:
   - Creates a branch (`dispatch/issue-42-fix-login-bug`)
   - Invokes AI (routed per phase: cheap for classify/score, strong for solve)
   - Self-assesses confidence (1-10)
   - Runs tests to verify changes
   - Commits, pushes, and opens a PR
   - Saves insights for the next batch
6. Low-confidence or test-failing solutions become draft PRs
7. Generates a summary report with cost breakdown

### `dispatch create`

Create well-structured GitHub issues from a text description or interactive interview.

```bash
# From a description
dispatch create "figure out why the /api/users endpoint is 3x slower than last month"

# Interactive mode — guided interview
dispatch create --interactive

# Generate without posting
dispatch create "add rate limiting to public endpoints" --no-post
```

### `dispatch status`

View results from the last run, including cost breakdown, memory state, and provider config.

```bash
dispatch status            # pretty-printed morning report
dispatch status --json     # raw JSON output
dispatch status --memory   # show memory system details
```

### `dispatch providers`

Show detected AI providers and model routing configuration.

```bash
dispatch providers         # show providers, routing, and registered models
```

### `dispatch learn`

Scan Dispatch-created PRs for review feedback and extract lessons. Lessons are stored locally and fed into future solves.

```bash
dispatch learn             # scan PRs and extract lessons
dispatch learn --show      # show current lessons without scanning
dispatch learn --max-prs 20  # limit scan to 20 PRs
```

### `dispatch schedule`

Generate a GitHub Actions workflow for automated nightly runs.

```bash
dispatch schedule                          # default: runs daily at 2 AM UTC
dispatch schedule --time midnight          # run at midnight UTC
dispatch schedule --time 3am              # run at 3 AM UTC
dispatch schedule --cron "0 6 * * 1"      # custom cron: every Monday at 6 AM UTC
dispatch schedule --max-issues 5 --draft  # limit issues and create draft PRs
dispatch schedule --label bug             # only process issues labeled "bug"
dispatch schedule --auth claude-code      # enterprise: uses Anthropic's GitHub Action (no API key)
dispatch schedule --auth github-models    # zero setup: uses GITHUB_TOKEN for AI (no extra secrets)
dispatch schedule --auth github-models --model anthropic/claude-sonnet-4  # GitHub Models with specific model
dispatch schedule --auth gemini           # uses GEMINI_API_KEY secret (default: gemini-2.5-pro)
dispatch schedule --auth gemini --model gemini-3-pro-preview  # Gemini 3 series model
dispatch schedule --stdout                # print workflow YAML without writing file
```

**What happens:**
1. Generates a `.github/workflows/dispatch-nightly.yml` file
2. The workflow installs Dispatch (and Claude Code CLI if using `api-key` auth) on a GitHub Actions runner
3. Runs `dispatch run` on your configured schedule
4. Supports manual triggering from the GitHub Actions UI (`workflow_dispatch`)
5. Uploads `.dispatch/` logs as artifacts (retained 30 days)

**Required setup after running:**
- **`api-key`** (default): Add `ANTHROPIC_API_KEY` as a [repository secret](https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions), then commit and push
- **`claude-code`** (enterprise): Just commit and push — OIDC auth is automatic
- **`github-models`** (zero setup): Just commit and push — `GITHUB_TOKEN` is auto-provided by GitHub Actions
- **`gemini`**: Add `GEMINI_API_KEY` as a [repository secret](https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions), then commit and push

> **Easiest option**: `dispatch schedule --auth github-models` requires zero secrets — just commit the workflow file and it works. Uses GPT-4o by default, or pass `--model` to choose another model.

| Option | Description | Default |
|--------|-------------|---------|
| `--time <time>` | Time to run in UTC (`2am`, `03:00`, `midnight`, `noon`) | `2am` |
| `--cron <expr>` | Custom cron expression (overrides `--time`) | — |
| `--max-issues <n>` | Max issues per run | `10` |
| `--draft` | Create PRs as drafts | `false` |
| `--label <labels...>` | Only process issues with these labels | — |
| `--model <model>` | Model for `github-models` or `gemini` auth | `openai/gpt-4o` / `gemini-2.5-pro` |
| `--auth <method>` | Auth method: `api-key` (personal), `claude-code` (enterprise), `github-models` (zero setup), `gemini` (Google AI) | `api-key` |
| `--stdout` | Print YAML to stdout instead of writing file | `false` |

### `dispatch stats`

View historical statistics across all runs.

```bash
dispatch stats              # formatted dashboard
dispatch stats --json       # raw JSON output
dispatch stats --recent 20  # show last 20 runs
```

### `dispatch init`

Initialize configuration for your repository.

```bash
dispatch init       # interactive setup
dispatch init --yes # use defaults
```

## Configuration

Dispatch reads `.dispatchrc.json` from your repo root:

```json
{
  "engine": "claude",
  "model": "sonnet",
  "labels": [],
  "exclude": ["wontfix", "blocked", "duplicate"],
  "maxIssues": 10,
  "maxTurnsPerIssue": 10,
  "branchPrefix": "dispatch/",
  "createDraftPRs": false,
  "autoLabel": true,
  "baseBranch": "main",
  "draftThreshold": 5,
  "stateDir": ".dispatch",
  "timeoutPerIssue": 600000,
  "concurrency": 3,
  "provider": "auto",
  "routingStrategy": "auto",
  "enableCodebaseContext": true,
  "enableCrossIssue": true
}
```

| Option | Description | Default |
|--------|-------------|---------|
| `engine` | AI backend (`claude`, `github-models`, `gemini`) — legacy, prefer `provider` | `claude` |
| `model` | Model name — legacy, prefer `routingStrategy` | `sonnet` |
| `provider` | AI provider (`auto`, `anthropic`, `gemini`, `github-models`, `openai`) | `auto` |
| `routingStrategy` | Model routing (`auto`, `provider-locked`, `pinned`) | `auto` |
| `labels` | Only process issues with these labels (empty = all) | `[]` |
| `exclude` | Skip issues with these labels | `["wontfix", "blocked", "duplicate"]` |
| `maxIssues` | Max issues per run | `10` |
| `maxTurnsPerIssue` | Max AI turns per issue | `10` |
| `branchPrefix` | Branch name prefix | `dispatch/` |
| `createDraftPRs` | Always create draft PRs | `false` |
| `autoLabel` | Auto-label issues with classification | `true` |
| `baseBranch` | Base branch for PRs | `main` |
| `draftThreshold` | Confidence below this → draft PR | `5` |
| `stateDir` | Directory for dispatch state/logs | `.dispatch` |
| `timeoutPerIssue` | Timeout per issue in milliseconds | `600000` (10 min) |
| `concurrency` | Number of issues to process in parallel | `3` |
| `enableCodebaseContext` | Cache and reuse codebase analysis (Tier 1 memory) | `true` |
| `enableCrossIssue` | Share insights across issues in a run (Tier 2 memory) | `true` |
| `telemetry` | Enable anonymous usage analytics | `true` |

## Issue Types

Dispatch automatically classifies issues and adapts its approach:

| Type | What it does | Example |
|------|-------------|---------|
| **code-fix** | Finds and fixes the bug, adds tests | "Login button returns 500 error" |
| **feature** | Implements the feature following project patterns | "Add dark mode toggle" |
| **investigation** | Researches and commits a findings report | "Figure out why API is slow" |
| **documentation** | Writes or updates docs | "Document the auth flow" |
| **audit** | Reviews codebase and commits audit report | "Audit for accessibility issues" |
| **refactor** | Restructures code without behavior changes | "Extract auth logic into service" |

## Confidence Scoring

After solving each issue, the AI self-assesses its confidence (1-10):

- **5-10**: Regular PR — review recommended
- **1-4**: Draft PR with "needs-review" label — significant uncertainty, manual review essential

## Authentication Methods

Dispatch supports two ways to authenticate Claude in GitHub Actions:

| | Personal Account | Enterprise/Team Account |
|---|---|---|
| **Flag** | `--auth api-key` (default) | `--auth claude-code` |
| **How** | You create an API key at console.anthropic.com | Anthropic's GitHub Action uses OIDC |
| **Secrets** | `ANTHROPIC_API_KEY` | None (automatic) |
| **Setup** | ~2 minutes | Ask your Anthropic admin to enable OIDC |

### `api-key` — Personal accounts (default)

Create an API key from your Anthropic account and add it as a GitHub secret.

```bash
dispatch schedule                    # generates workflow with ANTHROPIC_API_KEY secret
```

**Setup:**
1. Create an API key at [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys)
2. Add it as a [repository secret](https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions) named `ANTHROPIC_API_KEY`
3. Commit and push the workflow file

### `claude-code` — Enterprise/team accounts

Uses Anthropic's official [`claude-code-action`](https://github.com/anthropics/claude-code-action) GitHub Action. Authenticates via **OIDC** (OpenID Connect) — your org's Anthropic plan is used directly. No API key needed.

```bash
dispatch schedule --auth claude-code  # generates workflow using Anthropic's official action
```

**Setup:**
1. Your Anthropic admin enables OIDC trust between GitHub and your org's Anthropic account
2. Commit and push the workflow file
3. That's it — the action handles auth automatically

**Why this exists:** Enterprise Claude Code users authenticate locally via interactive OAuth (browser login). That works great for development, but CI environments can't open a browser. The `claude-code-action` solves this by using GitHub's OIDC token provider to authenticate with Anthropic — same org plan, no separate API key required.

## Engines

### Claude Code (default)

Uses [Claude Code](https://claude.com/claude-code) CLI as the AI backend. Requires a separate Anthropic API key or Max subscription.

```json
{
  "engine": "claude",
  "model": "sonnet"
}
```

### GitHub Models

Uses the [GitHub Models](https://github.com/marketplace/models) inference API — access GPT-4o, Claude Sonnet, Gemini, Llama, and more through your existing `GITHUB_TOKEN`. No additional API keys needed.

```json
{
  "engine": "github-models",
  "model": "openai/gpt-4o"
}
```

**Available models include:**
- `openai/gpt-4o` — GPT-4o (recommended for best tool-calling support)
- `anthropic/claude-sonnet-4` — Claude Sonnet 4
- `google/gemini-2.5-pro` — Gemini 2.5 Pro
- `meta/llama-4-scout` — Llama 4 Scout

**Setup:**
1. Your `GITHUB_TOKEN` needs `models:read` scope (for fine-grained PATs) or classic tokens work by default
2. Set `engine` to `"github-models"` in `.dispatchrc.json` (or `dispatch init`)
3. That's it — `dispatch run` will use the GitHub Models API

**Free tier:** GitHub Models includes a free tier (rate-limited). See [GitHub Models pricing](https://docs.github.com/en/github-models) for details.

**How it works:** Unlike Claude Code (which delegates to the `claude` CLI), the GitHub Models engine runs its own agentic loop: it calls the model API, executes tool calls (file read/write, grep, bash) locally in the worktree, and repeats until the issue is solved.

### Gemini

Uses Google's [Gemini API](https://ai.google.dev/) via its OpenAI-compatible endpoint. Requires a `GEMINI_API_KEY` from [Google AI Studio](https://aistudio.google.com/apikey).

```json
{
  "engine": "gemini",
  "model": "gemini-2.5-pro"
}
```

**Available models include:**
- `gemini-2.5-pro` — Most capable, best for complex issues (recommended)
- `gemini-2.5-flash` — Faster and cheaper, good for simpler issues
- `gemini-3-flash-preview` — Next-gen fast model (preview)
- `gemini-3-pro-preview` — Next-gen capable model (preview)
- `gemini-3.1-pro-preview` — Latest preview model

**Setup:**
1. Get an API key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
2. Set it: `export GEMINI_API_KEY=your-key-here` (or `GOOGLE_API_KEY`)
3. Set `engine` to `"gemini"` in `.dispatchrc.json` (or `dispatch init`)
4. Run `dispatch run`

**How it works:** Like the GitHub Models engine, the Gemini engine runs its own agentic loop: it calls the Gemini API (via Google's OpenAI-compatible endpoint), executes tool calls locally in the worktree, and repeats until the issue is solved. No additional CLI tools need to be installed.

### OpenAI (Direct API)

Uses the [OpenAI API](https://platform.openai.com/) directly. Requires an `OPENAI_API_KEY`.

```json
{
  "provider": "openai"
}
```

**Available models:**
- `gpt-4.1` — Most capable (recommended for solving)
- `gpt-4.1-mini` — Faster and cheaper (good for classify/score)
- `o3-mini` — Reasoning model

**Setup:**
1. Get an API key at [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
2. Set it: `export OPENAI_API_KEY=sk-...`
3. Run `dispatch run --provider openai`

## Model Routing (v2)

Instead of using one model for everything, Dispatch v2 picks the **optimal model for each phase** of the pipeline. Classification doesn't need the same model as code generation.

```bash
dispatch run                           # auto: haiku for classify, sonnet for solve
dispatch run --provider gemini         # provider-locked: flash for classify, pro for solve
dispatch run --engine claude           # legacy: sonnet for everything (backward compatible)
```

**Routing strategies:**
| Strategy | Flag | Behavior |
|----------|------|----------|
| `auto` (default) | — | Picks cheapest model for classify/score, strongest for solve, across all detected providers |
| `provider-locked` | `--provider gemini` | Uses only models from one provider, still routing cheap/strong per phase |
| `pinned` | `--engine claude` | Uses one model for all phases (v1 behavior) |

**Cost savings:** Smart routing typically saves ~40% vs using the strongest model for everything.

Run `dispatch providers` to see your current routing configuration and available models.

## Memory System (v2)

Dispatch v2 includes a 3-tier memory system that makes the AI smarter over time.

### Tier 1 — Codebase Context Cache

On first run, Dispatch analyzes your repo (file tree, package.json, patterns, conventions) and caches it at `.dispatch/memory/context.json`. This context is injected into every solve prompt, eliminating redundant codebase exploration.

### Tier 2 — Cross-Issue Learning

When issue #1 discovers project patterns, that knowledge feeds into issue #5. The pipeline processes issues in batches — insights from batch N are injected into batch N+1.

### Tier 3 — PR Review Lessons (Local)

After runs, `dispatch learn` scans your Dispatch-created PRs for review feedback and extracts lessons. These lessons are stored locally with a 30-day decay and injected into future solves at low priority.

```bash
dispatch learn                # scan PRs for feedback
dispatch learn --show         # view current lessons
```

**Disable memory:**
```bash
dispatch run --no-memory      # skip all memory injection
```

## Checkpoint & Resume (v2)

If a run crashes at issue 7/10, you don't have to start over:

```bash
dispatch run --resume         # skips already-processed issues
```

Progress is saved to `.dispatch/checkpoint.json` after each issue. The checkpoint is cleared on successful completion.

## Telemetry

Dispatch collects **anonymous usage analytics** to help improve the tool. No personally identifiable information (PII) is collected.

**What's collected:**
- Issue counts (checked, solved, failed)
- Engine and model used
- Solve times and confidence scores
- Failure categories (e.g., "timeout", "rate-limit")

**What's NOT collected:**
- Repository names, issue titles, or code
- API keys or tokens
- Usernames or email addresses

**Opt out** at any time:

```bash
# CLI flag
dispatch run --no-telemetry

# Environment variable
export DISPATCH_NO_TELEMETRY=1

# Config file (.dispatchrc.json)
{ "telemetry": false }
```

**Local stats** are always saved to `.dispatch/stats.json` regardless of telemetry settings. View them with `dispatch stats`.

## Prerequisites

- [Node.js](https://nodejs.org) >= 20
- [Claude Code](https://claude.com/claude-code) installed and authenticated (for `claude` engine)
- [Gemini API Key](https://aistudio.google.com/apikey) (for `gemini` engine)
- [GitHub token](https://github.com/settings/tokens) with repo access (or `gh auth login`)

## Architecture

```
dispatch CLI
├── Commands (run, create, status, stats, init, schedule, providers, learn)
├── ModelRouter (per-phase model selection, cost tracking)
├── Memory System (codebase context, cross-issue insights, PR lessons)
├── GitHub Client (octokit — issues, PRs, comments, labels)
├── Engine Layer (pluggable AI adapters)
│   ├── Claude Adapter (claude CLI --print)
│   ├── GitHub Models Adapter (openai SDK + local tool execution)
│   ├── Gemini Adapter (openai SDK + Google's OpenAI-compatible endpoint)
│   └── OpenAI Adapter (openai SDK + direct API)
├── Orchestrator (batched pipeline, classifier, scorer, checkpoint)
├── Reporter (morning summary, cost breakdown, run history)
├── Telemetry (anonymous analytics, local stats)
└── Utils (config, git, logger, worktree, semaphore)
```

The engine adapter pattern makes adding new AI backends trivial — implement the `AIEngine` interface and you're done.

## Roadmap

### Completed (v2 Community)
- [x] Claude Code engine (default AI backend)
- [x] Gemini engine adapter
- [x] OpenAI engine adapter (direct API)
- [x] GitHub Models engine (use GPT-4.1/Claude via GITHUB_TOKEN — zero setup)
- [x] Smart model routing (ModelRouter — per-phase model selection)
- [x] Codebase context caching (Tier 1 memory)
- [x] Cross-issue learning within runs (Tier 2 memory)
- [x] Learn from PR review feedback (`dispatch learn` — Tier 3 local memory)
- [x] Batched parallel issue solving with insight sharing
- [x] Post-solve test verification
- [x] Cost tracking and per-run cost breakdown
- [x] Checkpoint/resume for crashed runs
- [x] Provider detection and diagnostics (`dispatch providers`)
- [x] GitHub Action for scheduled runs
- [x] Telemetry and analytics (`dispatch stats`)

### Planned (Pro/Enterprise)
- [ ] Web dashboard (dispatch.dev) — run history, PR dashboard, analytics
- [ ] Cross-run persistent memory (Tier 3 cloud sync)
- [ ] GitLab and Bitbucket integration
- [ ] Managed AI proxy (no API keys needed)
- [ ] Slack/Discord/Teams notifications
- [ ] Visual workflow builder
- [ ] Team management and shared memory
- [ ] Issue decomposition (break large issues into sub-tasks)

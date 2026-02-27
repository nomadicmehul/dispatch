# ⚡ Dispatch

[![npm version](https://img.shields.io/npm/v/dispatch-ai.svg)](https://www.npmjs.com/package/dispatch-ai)
[![npm downloads](https://img.shields.io/npm/dm/dispatch-ai.svg)](https://www.npmjs.com/package/dispatch-ai)
[![License](https://img.shields.io/badge/License-Apache%202.0%20WITH%20Commons--Clause-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org)
[![Beta](https://img.shields.io/badge/status-🧪_beta-blueviolet)](https://github.com/nomadicmehul/dispatch)

> **🧪 Beta** — Dispatch is under active development. APIs and behavior may change between releases.

**Dispatch your GitHub issues. Receive pull requests.**

Dispatch is an AI-powered CLI tool that solves GitHub issues in batch — creating branches, implementing fixes, and opening pull requests while you sleep.

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
dispatch run                          # solve all open issues
dispatch run --dry-run                # preview without making changes
dispatch run --label bug --label p0   # only solve bugs and P0 issues
dispatch run --max-issues 5           # limit to 5 issues
dispatch run --draft                  # create all PRs as drafts
dispatch run --model opus             # use a specific model
dispatch run --base-branch develop    # target a different base branch
```

**What happens:**
1. Fetches open issues from your GitHub repo
2. Classifies each issue (bug fix, feature, investigation, audit, docs, refactor)
3. Prioritizes by labels (P0 → P1 → P2) and reactions
4. For each issue:
   - Creates a branch (`dispatch/issue-42-fix-login-bug`)
   - Invokes Claude Code to solve it
   - Self-assesses confidence (1-10)
   - Commits, pushes, and opens a PR
5. Low-confidence solutions become draft PRs
6. Generates a morning summary report

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

View results from the last run.

```bash
dispatch status          # pretty-printed morning report
dispatch status --json   # raw JSON output
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
  "concurrency": 3
}
```

| Option | Description | Default |
|--------|-------------|---------|
| `engine` | AI backend (`claude`, `github-models`, `gemini`) | `claude` |
| `model` | Model name (`sonnet`/`opus`/`haiku` for Claude; `openai/gpt-4o` etc. for GitHub Models; `gemini-2.5-pro` etc. for Gemini) | `sonnet` |
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

## Prerequisites

- [Node.js](https://nodejs.org) >= 20
- [Claude Code](https://claude.com/claude-code) installed and authenticated (for `claude` engine)
- [Gemini API Key](https://aistudio.google.com/apikey) (for `gemini` engine)
- [GitHub token](https://github.com/settings/tokens) with repo access (or `gh auth login`)

## Architecture

```
dispatch CLI
├── Commands (run, create, status, init, schedule)
├── GitHub Client (octokit — issues, PRs, labels)
├── Engine Layer (pluggable AI adapters)
│   └── Claude Adapter (claude CLI --print)
│   └── GitHub Models Adapter (openai SDK + local tool execution)
│   └── Gemini Adapter (openai SDK + Google's OpenAI-compatible endpoint)
├── Orchestrator (pipeline, classifier, scorer)
├── Reporter (morning summary, run history)
└── Utils (config, git, logger)
```

The engine adapter pattern makes adding new AI backends trivial — implement the `AIEngine` interface and you're done.

## Roadmap

- [x] Gemini engine adapter
- [ ] OpenAI adapter
- [x] GitHub Models engine (use Claude/GPT-4o via GITHUB_TOKEN — zero setup)
- [ ] Slack/Discord/Teams notifications on run completion
- [x] GitHub Action for scheduled runs
- [ ] Issue decomposition (break large issues into sub-tasks)
- [ ] Learn from PR review feedback
- [ ] Parallel issue solving
- [ ] Web dashboard for run history

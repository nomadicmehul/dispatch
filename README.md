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
dispatch run --no-telemetry           # disable telemetry for this run
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

### `dispatch stats`

View cumulative statistics across all runs.

```bash
dispatch stats              # formatted dashboard
dispatch stats --json       # raw JSON output
dispatch stats --recent 5   # show last 5 runs
```

**Displays:**
- Lifetime totals (issues checked, processed, solved, failed, PRs created)
- Success rate and average solve time
- Classification breakdown (bar chart)
- Confidence distribution (1-10 histogram)
- Engine usage breakdown
- Failure categories
- Recent runs table

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
  "telemetry": true,
  "posthogHost": "https://app.posthog.com",
  "posthogApiKey": ""
}
```

| Option | Description | Default |
|--------|-------------|---------|
| `engine` | AI backend (`claude`, future: `gemini`) | `claude` |
| `model` | Model name (`sonnet`, `opus`, `haiku`) | `sonnet` |
| `labels` | Only process issues with these labels (empty = all) | `[]` |
| `exclude` | Skip issues with these labels | `["wontfix", "blocked", "duplicate"]` |
| `maxIssues` | Max issues per run | `10` |
| `maxTurnsPerIssue` | Max AI turns per issue | `10` |
| `branchPrefix` | Branch name prefix | `dispatch/` |
| `createDraftPRs` | Always create draft PRs | `false` |
| `autoLabel` | Auto-label issues with classification | `true` |
| `baseBranch` | Base branch for PRs | `main` |
| `draftThreshold` | Confidence below this → draft PR | `5` |
| `telemetry` | Enable anonymous usage analytics | `true` |
| `posthogHost` | PostHog host URL (for self-hosted instances) | `https://app.posthog.com` |
| `posthogApiKey` | PostHog project API key (write-only) | `""` |

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

- **8-10**: Regular PR — high confidence, ship it
- **5-7**: Regular PR with "needs-review" notes
- **1-4**: Draft PR — significant uncertainty, manual review essential

## Telemetry & Privacy

Dispatch collects anonymous usage analytics to help improve the tool. Telemetry is **enabled by default** and can be disabled at any time.

**What's collected (anonymized):**
- Aggregate counts: issues checked, processed, solved, failed, PRs created
- Classification distribution and confidence scores
- Solve times and generic failure categories (e.g. "timeout", "rate-limit")
- Config settings: engine, model, concurrency, thresholds
- Repo `owner/repo` (public GitHub info)

**Never collected:**
- Issue titles, body, comments, or code content
- File paths, diffs, or error stack traces
- GitHub usernames, emails, or tokens

**Local stats** (`.dispatch/stats.json`) are always saved regardless of telemetry settings — they're private to your machine and power `dispatch stats`.

**Opt-out methods:**
- Config: `"telemetry": false` in `.dispatchrc.json`
- CLI flag: `dispatch run --no-telemetry`
- Environment variable: `DISPATCH_NO_TELEMETRY=1`

**Self-hosted analytics:** Set `posthogHost` and `posthogApiKey` in your config to point to your own PostHog instance. Remote telemetry is skipped entirely if no API key is configured.

## Prerequisites

- [Node.js](https://nodejs.org) >= 20
- [Claude Code](https://claude.com/claude-code) installed and authenticated
- [GitHub token](https://github.com/settings/tokens) with repo access (or `gh auth login`)

## Architecture

```
dispatch CLI
├── Commands (run, create, status, stats, init)
├── GitHub Client (octokit — issues, PRs, labels)
├── Engine Layer (pluggable AI adapters)
│   └── Claude Adapter (claude CLI --print)
│   └── [Future] Gemini Adapter
├── Orchestrator (pipeline, classifier, planner, scorer)
├── Telemetry (collector, local store, remote transport)
├── Reporter (morning summary, run history)
└── Utils (config, git, logger)
```

The engine adapter pattern makes adding new AI backends trivial — implement the `AIEngine` interface and you're done.

## Roadmap

- [ ] Gemini CLI adapter
- [ ] OpenAI adapter
- [ ] Slack/Discord/Teams notifications on run completion
- [ ] GitHub Action for scheduled runs
- [ ] Issue decomposition (break large issues into sub-tasks)
- [ ] Learn from PR review feedback
- [ ] Parallel issue solving
- [ ] Web dashboard for run history

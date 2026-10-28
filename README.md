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
dispatch run --verify-command "make check"   # how to test changes (default: auto-detect)
dispatch run --max-cost 5             # stop starting new issues after $5 of spend
dispatch run --provenance ref         # also push session records to refs/dispatch/sessions/*
```

**What happens:**
1. Fetches open issues from your GitHub repo
2. **Selects** what to work on, and says why it skipped the rest:
   - skips issues that already have a Dispatch branch, so nightly runs don't redo work
   - skips issues from people outside the project unless a maintainer adds the `dispatch:ready` label ([Trust & safety](#trust--safety))
   - skips issues too vague to solve, using a readiness score ([Readiness](#readiness))
3. Classifies each issue (bug fix, feature, investigation, audit, docs, refactor) and prioritizes by labels (P0 → P1 → P2) and reactions
4. Builds a short **repo brief** from the base branch (languages, scripts, layout, verify command) that every agent session receives, so agents don't each re-explore the repo
5. For each issue, in its own git worktree:
   - Creates a branch (`dispatch/issue-42-fix-login-bug`)
   - Invokes Claude Code to solve it, recording the session
   - **Verifies** the change by running your tests; on failure, hands the output back to the agent for a repair
   - **Scores** the result from evidence (tests run, test changes, diff size), not just the agent's own opinion
   - Commits with provenance trailers, pushes, and opens a PR in a review lane
6. Generates a morning review queue: ready to merge, needs eyes, drafts

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

View the last run as a review queue: PRs grouped into **Ready to merge**, **Needs eyes**, and **Drafts**, with confidence, test result, diff size, and cost per PR, followed by failures and skipped issues with reasons.

```bash
dispatch status          # morning review queue
dispatch status --json   # raw JSON output
```

### `dispatch explain`

See how a PR was made: the evidence behind its score, what it cost, and a step-by-step timeline of what the agent read, edited, and ran.

```bash
dispatch explain 42                # by issue number
dispatch explain '#57'             # by PR number
dispatch explain 3f9a1c2b          # by session ID (or prefix)
dispatch explain 42 --transcript   # full agent transcript
dispatch explain 42 --json         # raw session record
```

### `dispatch resume`

Pick up where the agent left off. Checks out the PR branch in a separate worktree and reopens the agent's Claude Code session with its full history, so you can steer a low-confidence attempt instead of starting over.

```bash
dispatch resume 42
```

Sessions recorded on a CI runner work too: with `provenance: "ref"`, Dispatch fetches them from `refs/dispatch/sessions/*`.

### `dispatch schedule`

Generate a GitHub Actions workflow for automated nightly runs.

```bash
dispatch schedule                          # default: runs daily at 2 AM UTC
dispatch schedule --time midnight          # run at midnight UTC
dispatch schedule --time 3am              # run at 3 AM UTC
dispatch schedule --cron "0 6 * * 1"      # custom cron: every Monday at 6 AM UTC
dispatch schedule --max-issues 5 --draft  # limit issues and create draft PRs
dispatch schedule --label bug             # only process issues labeled "bug"
dispatch schedule --auth claude-code      # Claude Pro/Max subscription token instead of an API key
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
- **`claude-code`** (subscription): Run `claude setup-token`, add the token as a `CLAUDE_CODE_OAUTH_TOKEN` secret, then commit and push
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
| `--auth <method>` | Auth method: `api-key` (Anthropic API key), `claude-code` (Claude subscription token), `github-models` (zero setup), `gemini` (Google AI) | `api-key` |
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
  "trustedAuthors": ["OWNER", "MEMBER", "COLLABORATOR"],
  "readyLabel": "dispatch:ready",
  "minReadiness": 3,
  "verifyCommand": "",
  "setupCommand": "",
  "onVerifyFail": "draft",
  "repairAttempts": 1,
  "maxDiffLines": 400,
  "maxCostPerIssue": 0,
  "maxCostPerRun": 0,
  "provenance": "local",
  "repoBrief": true
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
| `trustedAuthors` | GitHub author associations whose issues and comments Dispatch acts on (`"*"` = everyone) | `["OWNER", "MEMBER", "COLLABORATOR"]` |
| `readyLabel` | Label a maintainer adds to opt any issue in | `dispatch:ready` |
| `minReadiness` | Minimum readiness score (0-10) to dispatch an issue | `3` |
| `verifyCommand` | Command that tests a change. Empty = auto-detect (`npm test`, `go test ./...`, `cargo test`, `pytest`, `make test`); `"none"` = skip | `""` |
| `setupCommand` | Command run in each worktree before solving (e.g. `npm ci`). Empty = link the checkout's `node_modules` | `""` |
| `onVerifyFail` | When tests still fail after repairs: `"draft"` opens a draft PR, `"skip"` opens none | `"draft"` |
| `repairAttempts` | Times the agent may fix its change after failing verification | `1` |
| `maxDiffLines` | Changes larger than this are flagged and opened as drafts | `400` |
| `maxCostPerIssue` | Spend cap per issue in USD, enforced by Claude Code (`0` = none) | `0` |
| `maxCostPerRun` | Spend cap per run in USD; no new issues start once reached (`0` = none) | `0` |
| `provenance` | Session records: `"local"` (`.dispatch/sessions`), `"ref"` (also pushed to `refs/dispatch/sessions/*`), `"off"` | `"local"` |
| `repoBrief` | Give every agent session a shared brief of the repo (built from the base branch, committed files only, ~4k chars max). Disable per run with `--no-repo-brief` | `true` |
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

## Trust & Safety

Dispatch hands issue text to an agent that can edit code and run your tests, so it decides carefully whose text that is:

- **Trusted authors only.** Issues are dispatched only when the author is an owner, member, or collaborator (`trustedAuthors`). Anyone else's issue is skipped until a maintainer adds the `dispatch:ready` label. Comments from untrusted authors are left out of the prompt.
- **No GitHub token for the agent.** Claude Code runs with only the credentials it needs (your Anthropic key or subscription token). `GITHUB_TOKEN` and other secrets are removed from its environment, and from the environment your tests run in.
- **A narrow allowlist.** The agent can read, search, and edit files, and run your verify command. No other shell commands, and no web tools.
- **Secrets held back.** Files like `.env`, `*.pem`, and `id_rsa` are never committed; the PR lists anything that was held back. Templates such as `.env.example` are committed as normal.
- **Redacted records.** Session transcripts are scrubbed of token formats and of the values of secret environment variables before they are saved.

## Readiness

Before dispatching an issue, Dispatch scores how well it describes the work (0-10): a descriptive title, a real description, the files or code involved, expected vs. actual behaviour or acceptance criteria, logs, and checklists. Issues below `minReadiness` are skipped, and `dispatch run --dry-run` shows what each one is missing, so you can fix the issue instead of reviewing a guessed PR. The `dispatch:ready` label always counts as ready.

## Verification, Evidence & Review Lanes

A PR's score comes from evidence Dispatch checked itself, not just the agent's opinion of its own work:

1. **Verify.** After solving, Dispatch runs your `verifyCommand` in the worktree. If it fails, the output goes back to the agent, which gets `repairAttempts` tries to fix its change.
2. **Score.** The agent's self-assessment is adjusted by what actually happened: tests passed (+1) or failed (capped at 3), tests added or changed (+1), untested code changes (−1), diffs over `maxDiffLines` (−2), more than 10 files (−1), three or more open uncertainties (−1).
3. **Lane.** Each PR lands in one lane of the morning review queue:

| Lane | When | PR |
|---|---|---|
| ✅ **Ready to merge** | Confidence ≥ 8, verification passed, no open uncertainties | Regular PR |
| 👀 **Needs eyes** | Everything in between | Regular PR, `needs-review` label |
| 📝 **Draft** | Confidence below `draftThreshold`, verification failed, or diff over `maxDiffLines` | Draft PR, `needs-review` label |

Every PR body lists its evidence (✅/⚠️) and links its session.

## Session Provenance

Every issue Dispatch works on gets a session record: which agent and model, cost and turns, readiness, verification and repairs, the evidence behind the score, and the full agent transcript. Each commit carries trailers linking back to it:

```
fix: handle empty input in parser

Dispatch-Session: 3f9a1c2b-…
Dispatch-Issue: #42
Dispatch-Agent: claude/sonnet
Dispatch-Confidence: 9/10
Dispatch-Verify: passed (npm test)
```

Records live in `.dispatch/sessions/<id>/`. With `"provenance": "ref"`, they are also pushed to `refs/dispatch/sessions/<id>` in your repository, outside any branch, so a session recorded on a nightly CI runner can be explained (`dispatch explain`) and resumed (`dispatch resume`) from any clone. Transcripts can include code and file contents, so use `"ref"` on public repositories only if that is acceptable.

## Authentication Methods

Dispatch supports two ways to authenticate Claude Code in GitHub Actions:

| | API key | Claude subscription |
|---|---|---|
| **Flag** | `--auth api-key` (default) | `--auth claude-code` |
| **How** | You create an API key at console.anthropic.com | You generate a token with `claude setup-token` (Pro or Max plan) |
| **Secrets** | `ANTHROPIC_API_KEY` | `CLAUDE_CODE_OAUTH_TOKEN` |
| **Setup** | ~2 minutes | ~2 minutes |

**Run your CI on Dispatch's PRs:** PRs opened with the default `GITHUB_TOKEN` don't trigger other workflows, so your CI won't run on them. Add a `DISPATCH_GITHUB_TOKEN` secret (a fine-grained token with contents, pull requests, and issues write access) and the generated workflow uses it instead.

### `api-key` — Personal accounts (default)

Create an API key from your Anthropic account and add it as a GitHub secret.

```bash
dispatch schedule                    # generates workflow with ANTHROPIC_API_KEY secret
```

**Setup:**
1. Create an API key at [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys)
2. Add it as a [repository secret](https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions) named `ANTHROPIC_API_KEY`
3. Commit and push the workflow file

### `claude-code` — Claude subscription

Uses your Claude Pro or Max subscription instead of an API key. Claude Code reads a long-lived token from `CLAUDE_CODE_OAUTH_TOKEN`.

```bash
dispatch schedule --auth claude-code  # generates workflow using CLAUDE_CODE_OAUTH_TOKEN
```

**Setup:**
1. Run `claude setup-token` on your machine and copy the token
2. Add it as a repository secret named `CLAUDE_CODE_OAUTH_TOKEN`
3. Commit and push the workflow file

## Engines

### Claude Code (default)

Uses the [Claude Code](https://claude.com/claude-code) CLI (v2.1 or later) as the AI backend, with an Anthropic API key or a Claude subscription.

```json
{
  "engine": "claude",
  "model": "sonnet"
}
```

Claude Code is the most complete engine: it supports spend caps (`--max-budget-usd`), full session transcripts, repair after failed verification (by resuming the same session), and `dispatch resume`. The trust gate, readiness, verification, and evidence scoring apply to every engine; the GitHub Models and Gemini engines get the rest next.

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
- [Claude Code](https://claude.com/claude-code) v2.1+ installed and authenticated (for `claude` engine): `npm install -g @anthropic-ai/claude-code`
- [Gemini API Key](https://aistudio.google.com/apikey) (for `gemini` engine)
- [GitHub token](https://github.com/settings/tokens) with repo access (or `gh auth login`)

## Architecture

```
dispatch CLI
├── Commands (run, create, status, explain, resume, stats, init, schedule)
├── GitHub Client (octokit — issues, PRs, labels)
├── Engine Layer (pluggable AI adapters)
│   └── Claude Adapter (claude CLI --print, stream-json sessions)
│   └── GitHub Models Adapter (openai SDK + local tool execution)
│   └── Gemini Adapter (openai SDK + Google's OpenAI-compatible endpoint)
├── Orchestrator
│   ├── selection + readiness (what to work on, and why not)
│   ├── solve-issue (worktree → agent → verify/repair → PR)
│   ├── verify (test command detection, sandboxed runs)
│   └── scorer (evidence-based confidence, review lanes)
├── Provenance (session records, transcripts, commit trailers, session refs)
├── Reporter (morning review queue, run history)
├── Telemetry (anonymous analytics, local stats)
└── Utils (config, git, env scrubbing, logger)
```

The engine adapter pattern makes adding new AI backends trivial — implement the `AIEngine` interface and you're done.

## Roadmap

- [x] Claude Code engine (default AI backend)
- [x] Gemini engine adapter
- [x] GitHub Models engine (use Claude/GPT-4o via GITHUB_TOKEN — zero setup)
- [x] GitHub Action for scheduled runs
- [x] Telemetry and analytics (`dispatch stats`)
- [x] Parallel issue solving
- [x] Trust gate, readiness scoring, and idempotent nightly runs
- [x] Verification gate with agent repair, evidence-based scoring, review lanes
- [x] Session provenance (`dispatch explain`, `dispatch resume`, commit trailers, session refs)
- [ ] Gemini and GitHub Models: sandbox hardening, transcripts, cost tracking, repair
- [ ] Codex engine
- [ ] Learn from PR outcomes (which issue types and engines actually get merged)
- [ ] Multi-repo work items (one issue → linked PRs across repositories)
- [ ] Slack/Discord/Teams notifications on run completion
- [ ] Issue decomposition (break large issues into sub-tasks)
- [ ] Web dashboard for run history

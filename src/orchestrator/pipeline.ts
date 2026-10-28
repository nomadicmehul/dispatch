import chalk from "chalk";
import ora from "ora";
import type { AIEngine, Issue } from "../engine/types.js";
import type { GitHubClient } from "../github/client.js";
import type { DispatchConfig } from "../utils/config.js";
import { candidateLimit, fetchCandidateIssues, hydrateComments } from "../github/issues.js";
import { listRemoteBranches } from "../utils/git.js";
import { log, initFileLogging } from "../utils/logger.js";
import { saveSummary, formatMorningSummary, type RunSummary, type IssueSummary } from "../reporter/summary.js";
import { heuristicClassify } from "../orchestrator/classifier.js";
import { selectIssues, parseDispatchedIssueNumbers, type Selection, type SkippedIssue } from "./selection.js";
import { resolveVerifyCommand } from "./verify.js";
import { buildRunBrief } from "./repo-brief.js";
import { solveIssue } from "./solve-issue.js";
import { Semaphore } from "../utils/semaphore.js";
import { cleanupAllWorktrees } from "../utils/worktree.js";
import { TelemetryCollector } from "../telemetry/collector.js";
import { getAnonymousId, sendTelemetryEvent } from "../telemetry/remote.js";
import { updateStats } from "../telemetry/store.js";

export interface PipelineOptions {
  config: DispatchConfig;
  engine: AIEngine;
  github: GitHubClient;
  cwd: string;
  dryRun?: boolean;
}

function emptySummary(startTime: number, issues: IssueSummary[] = []): RunSummary {
  return {
    startedAt: new Date(startTime).toISOString(),
    duration: Date.now() - startTime,
    issues,
    totalAttempted: 0,
    totalSolved: 0,
    totalFailed: 0,
    prsCreated: [],
  };
}

function skippedSummary(skip: SkippedIssue): IssueSummary {
  return {
    number: skip.issue.number,
    title: skip.issue.title,
    classification: skip.issue.classification || "unknown",
    status: "skipped",
    skipReason: skip.reason,
    skipDetail: skip.detail,
  };
}

/** Issue numbers that already have a Dispatch branch on origin (open PR, closed PR, or interrupted run) */
async function findDispatchedIssues(branchPrefix: string, cwd: string): Promise<Set<number>> {
  try {
    const branches = await listRemoteBranches(`${branchPrefix}issue-*`, cwd);
    return parseDispatchedIssueNumbers(branches, branchPrefix);
  } catch (err) {
    log.warn(`Could not list remote branches, so issues with existing Dispatch PRs may be retried: ${err instanceof Error ? err.message : err}`);
    return new Set();
  }
}

/** Classify issues — heuristic first, AI only for "unknown", with bounded concurrency */
async function classifyIssues(issues: Issue[], engine: AIEngine, options: { useAI: boolean; concurrency: number }) {
  const spinner = ora("Classifying issues...").start();
  for (const issue of issues) {
    issue.classification = heuristicClassify(issue);
  }

  const unknowns = issues.filter((i) => i.classification === "unknown");
  if (options.useAI && unknowns.length > 0) {
    spinner.text = `Classifying ${unknowns.length} ambiguous issue(s) with AI...`;
    const semaphore = new Semaphore(options.concurrency);
    await Promise.all(
      unknowns.map(async (issue) => {
        await semaphore.acquire();
        try {
          issue.classification = await engine.classifyIssue(issue);
        } catch (err) {
          log.warn(`[#${issue.number}] AI classification failed, using "unknown": ${err instanceof Error ? err.message : err}`);
        } finally {
          semaphore.release();
        }
      })
    );
  }
  spinner.stop();
}

/** Print what will be dispatched and why the rest was skipped */
function printPlan(selection: Selection) {
  if (selection.selected.length > 0) {
    log.info(`Dispatching ${selection.selected.length} issue(s):\n`);
    for (const issue of selection.selected) {
      const readiness = selection.readiness.get(issue.number);
      log.issue(issue.number, issue.title, "pending");
      console.log(chalk.gray(
        `    Type: ${issue.classification} | Readiness: ${readiness?.score ?? "?"}/10 | Priority: ${issue.labels.join(", ") || "none"}`
      ));
    }
    console.log();
  }

  if (selection.skipped.length > 0) {
    const byReason = new Map<string, SkippedIssue[]>();
    for (const skip of selection.skipped) {
      byReason.set(skip.reason, [...(byReason.get(skip.reason) ?? []), skip]);
    }
    log.info(`Skipping ${selection.skipped.length} issue(s):`);
    for (const [reason, skips] of byReason) {
      console.log(chalk.gray(`    ${reason} (${skips.length})`));
      for (const skip of skips.slice(0, 5)) {
        console.log(chalk.gray(`      #${skip.issue.number} ${skip.issue.title} — ${skip.detail}`));
      }
      if (skips.length > 5) console.log(chalk.gray(`      … and ${skips.length - 5} more`));
    }
    console.log();
  }
}

export async function runPipeline(options: PipelineOptions): Promise<RunSummary> {
  const { config, engine, github, cwd, dryRun = false } = options;
  const startTime = Date.now();
  const telemetry = new TelemetryCollector();

  // Initialize file-based logging
  await initFileLogging(config.stateDir, cwd);

  log.header("Dispatch — Solving Issues");

  if (dryRun) {
    log.warn("DRY RUN — no branches, commits, or PRs will be created\n");
  }

  // 1. Fetch candidates — more than maxIssues, so filtering doesn't starve the run
  const candidates = await fetchCandidateIssues(github, {
    labels: config.labels,
    excludeLabels: config.exclude,
    limit: candidateLimit(config.maxIssues),
  });

  telemetry.recordIssuesChecked(candidates.length);

  if (candidates.length === 0) {
    log.info("No issues to process. All done! 🎉");
    return emptySummary(startTime);
  }

  // 2. Select: skip issues already dispatched, from untrusted authors, or too vague to solve
  const selection = selectIssues(candidates, {
    trustedAuthors: config.trustedAuthors,
    readyLabel: config.readyLabel,
    minReadiness: config.minReadiness,
    maxIssues: config.maxIssues,
    dispatched: await findDispatchedIssues(config.branchPrefix, cwd),
  });

  // 3. Classify the selected issues
  await classifyIssues(selection.selected, engine, { useAI: !dryRun, concurrency: config.concurrency });

  printPlan(selection);

  const skipped = selection.skipped.map(skippedSummary);

  if (dryRun) {
    log.info("Dry run complete — would process the issues above.");
    return emptySummary(startTime, [
      ...selection.selected.map((i) => ({
        number: i.number,
        title: i.title,
        classification: i.classification || "unknown",
        status: "skipped" as const,
        skipReason: "dry-run" as const,
        readiness: selection.readiness.get(i.number)?.score,
      })),
      ...skipped,
    ]);
  }

  if (selection.selected.length === 0) {
    log.info("Nothing to dispatch this run.");
    const summary = emptySummary(startTime, skipped);
    await saveSummary(summary, cwd, config.stateDir);
    return summary;
  }

  // 4. Fetch trusted comments for the selected issues
  await hydrateComments(github, selection.selected, config.trustedAuthors);

  const verifyCommand = await resolveVerifyCommand(config.verifyCommand, cwd);
  if (verifyCommand) {
    log.info(`Verify command: ${chalk.cyan(verifyCommand)}`);
  } else {
    log.warn(`No verify command found — PRs won't be tested. Set "verifyCommand" in .dispatchrc.json.`);
  }

  const brief = config.repoBrief ? await buildRunBrief(cwd, config.baseBranch, verifyCommand) : undefined;
  if (brief) {
    log.info(`Repo brief: ${brief.brief.length} chars from ${brief.ref}, shared by every session`);
  }

  if ((config.maxCostPerRun > 0 || config.maxCostPerIssue > 0) && engine.name !== "claude") {
    log.warn(`Spend caps need an engine that reports cost; "${engine.name}" doesn't, so caps won't apply.`);
  }

  // 5. Solve in parallel, within the run's spend cap
  const issueSummaries: IssueSummary[] = [];
  const prsCreated: Array<{ number: number; url: string; issueNumber: number }> = [];
  const semaphore = new Semaphore(config.concurrency);
  let spent = 0;

  // Clean up any leftover worktrees from a previous crashed run
  await cleanupAllWorktrees(cwd, config.stateDir);

  await Promise.all(selection.selected.map(async (issue) => {
    await semaphore.acquire();
    try {
      const remaining = config.maxCostPerRun > 0 ? config.maxCostPerRun - spent : undefined;
      if (remaining !== undefined && remaining <= 0) {
        issueSummaries.push(skippedSummary({
          issue,
          reason: "budget-exhausted",
          detail: `run spend cap of $${config.maxCostPerRun.toFixed(2)} reached`,
        }));
        return;
      }

      const caps = [config.maxCostPerIssue > 0 ? config.maxCostPerIssue : undefined, remaining]
        .filter((n): n is number => n !== undefined);

      const outcome = await solveIssue(issue, {
        config,
        engine,
        github,
        cwd,
        verifyCommand,
        repoBrief: brief,
        readiness: selection.readiness.get(issue.number),
        maxCostUsd: caps.length > 0 ? Math.min(...caps) : undefined,
      });

      spent += outcome.costUsd;
      telemetry.recordIssue(outcome.telemetry);
      issueSummaries.push(outcome.summary);
      if (outcome.pr) prsCreated.push({ ...outcome.pr, issueNumber: issue.number });
    } finally {
      semaphore.release();
    }
  }));

  // 6. Generate summary
  const summary: RunSummary = {
    startedAt: new Date(startTime).toISOString(),
    duration: Date.now() - startTime,
    issues: [...issueSummaries, ...skipped],
    totalAttempted: issueSummaries.filter((i) => i.status !== "skipped").length,
    totalSolved: issueSummaries.filter((i) => i.status === "solved").length,
    totalFailed: issueSummaries.filter((i) => i.status === "failed").length,
    prsCreated,
    totalCostUsd: spent > 0 ? spent : undefined,
  };

  await saveSummary(summary, cwd, config.stateDir);
  log.header("Run Complete");
  console.log(formatMorningSummary(summary));

  // Telemetry: save local stats and optionally send remote event
  try {
    const anonymousId = await getAnonymousId(cwd, config.stateDir);
    const event = telemetry.buildEvent({
      anonymousId,
      startedAt: summary.startedAt,
      durationMs: summary.duration,
      repoOwner: github.owner,
      repoName: github.repo,
      engine: config.engine,
      model: config.model,
      concurrency: config.concurrency,
      maxIssues: config.maxIssues,
      maxTurnsPerIssue: config.maxTurnsPerIssue,
      draftThreshold: config.draftThreshold,
      createDraftPRs: config.createDraftPRs,
      prsCreated: summary.prsCreated.length,
    });

    // Always save local stats
    await updateStats(event, cwd, config.stateDir);

    // Remote send only if telemetry is enabled
    if (config.telemetry) {
      sendTelemetryEvent(event, config.posthogHost, config.posthogApiKey);
    }
  } catch (err) {
    log.debug(`Telemetry finalization failed (non-fatal): ${err}`);
  }

  return summary;
}

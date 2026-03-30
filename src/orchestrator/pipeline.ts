import chalk from "chalk";
import ora from "ora";
import type { AIEngine, Issue, SolveResult } from "../engine/types.js";
import type { GitHubClient } from "../github/client.js";
import type { DispatchConfig } from "../utils/config.js";
import type { ModelRouter } from "../router/router.js";
import { fetchAndHydrateIssues, prioritizeIssues, slugifyTitle } from "../github/issues.js";
import { createPRForIssue } from "../github/pulls.js";
import {
  commitAndPush,
  getDiffSummary,
} from "../utils/git.js";
import { log, initFileLogging, getLogDir } from "../utils/logger.js";
import { saveSummary, type RunSummary, type IssueSummary } from "../reporter/summary.js";
import { heuristicClassify } from "../orchestrator/classifier.js";
import { adjustConfidence } from "../orchestrator/scorer.js";
import { Semaphore } from "../utils/semaphore.js";
import { createWorktree, removeWorktree, getWorktreePath, cleanupAllWorktrees } from "../utils/worktree.js";
import { TelemetryCollector } from "../telemetry/collector.js";
import { MemoryManager } from "../memory/manager.js";
import { getAnonymousId, sendTelemetryEvent } from "../telemetry/remote.js";
import { updateStats } from "../telemetry/store.js";

export interface PipelineOptions {
  config: DispatchConfig;
  engine: AIEngine;
  github: GitHubClient;
  cwd: string;
  dryRun?: boolean;
  /** Optional ModelRouter for cost tracking and per-phase routing */
  router?: ModelRouter;
  /** Optional: skip issues already processed (for resume) */
  skipIssues?: number[];
}

export async function runPipeline(options: PipelineOptions): Promise<RunSummary> {
  const { config, engine, github, cwd, dryRun = false, router, skipIssues = [] } = options;
  const startTime = Date.now();
  const telemetry = new TelemetryCollector();

  // Initialize memory system
  const memory = new MemoryManager({
    stateDir: config.stateDir,
    enableCodebaseContext: config.enableCodebaseContext,
    enableCrossIssue: config.enableCrossIssue,
  });
  await memory.initialize(cwd);

  // Initialize file-based logging
  await initFileLogging(config.stateDir, cwd);

  log.header("Dispatch — Solving Issues");

  if (dryRun) {
    log.warn("DRY RUN — no branches, commits, or PRs will be created\n");
  }

  // 1. Fetch and prioritize issues
  const allIssues = await fetchAndHydrateIssues(github, {
    labels: config.labels,
    excludeLabels: config.exclude,
    maxIssues: config.maxIssues,
  });

  telemetry.recordIssuesChecked(allIssues.length);

  if (allIssues.length === 0) {
    log.info("No issues to process. All done! 🎉");
    return {
      startedAt: new Date(startTime).toISOString(),
      duration: Date.now() - startTime,
      issues: [],
      totalAttempted: 0,
      totalSolved: 0,
      totalFailed: 0,
      prsCreated: [],
    };
  }

  // 2. Classify issues — heuristic first, AI only for "unknown"
  {
    const spinner = ora("Classifying issues...").start();
    for (const issue of allIssues) {
      issue.classification = heuristicClassify(issue);
    }

    if (!dryRun) {
      // Only invoke AI for issues the heuristic couldn't classify
      const unknowns = allIssues.filter((i) => i.classification === "unknown");
      if (unknowns.length > 0) {
        spinner.text = `Classifying ${unknowns.length} ambiguous issue(s) with AI...`;
        await Promise.all(
          unknowns.map(async (issue) => {
            try {
              issue.classification = await engine.classifyIssue(issue);
            } catch (err) {
              log.warn(`[#${issue.number}] AI classification failed, using "unknown": ${err instanceof Error ? err.message : err}`);
            }
          })
        );
      }
    }
    spinner.stop();
  }

  // 3. Prioritize
  let issues = prioritizeIssues(allIssues);

  // Filter out already-processed issues (for --resume)
  if (skipIssues.length > 0) {
    const before = issues.length;
    issues = issues.filter((i) => !skipIssues.includes(i.number));
    if (before !== issues.length) {
      log.info(`Resuming: skipping ${before - issues.length} already-processed issues`);
    }
  }

  log.info(`Processing ${issues.length} issues:\n`);
  for (const issue of issues) {
    log.issue(issue.number, issue.title, "pending");
    console.log(chalk.gray(`    Type: ${issue.classification} | Priority: ${issue.labels.join(", ") || "none"}`));
  }
  console.log();

  if (dryRun) {
    log.info("Dry run complete — would process the issues above.");
    return {
      startedAt: new Date(startTime).toISOString(),
      duration: Date.now() - startTime,
      issues: issues.map((i) => ({
        number: i.number,
        title: i.title,
        classification: i.classification || "unknown",
        status: "skipped" as const,
      })),
      totalAttempted: 0,
      totalSolved: 0,
      totalFailed: 0,
      prsCreated: [],
    };
  }

  // 4. Process issues in parallel with concurrency control
  const issueSummaries: IssueSummary[] = [];
  const prsCreated: Array<{ number: number; url: string; issueNumber: number }> = [];
  const semaphore = new Semaphore(config.concurrency);

  // Clean up any leftover worktrees from a previous crashed run
  await cleanupAllWorktrees(cwd, config.stateDir);

  const processIssue = async (issue: Issue) => {
    await semaphore.acquire();

    const branchName = `${config.branchPrefix}issue-${issue.number}-${slugifyTitle(issue.title)}`;
    const worktreePath = getWorktreePath(cwd, config.stateDir, issue.number);
    let issueStatus: "solved" | "failed" | "no-changes" = "failed";
    const issueStartTime = Date.now();

    try {
      log.info(`[#${issue.number}] ${issue.title} (${issue.classification || "unknown"})`);
      log.info(`[#${issue.number}] Creating worktree: ${chalk.cyan(branchName)}`);
      await createWorktree(worktreePath, branchName, config.baseBranch, cwd);

      // Solve the issue
      const isInvestigation = ["investigation", "audit", "documentation"].includes(
        issue.classification || ""
      );

      const solveStart = Date.now();
      telemetry.startSolve(issue.number);
      log.info(`[#${issue.number}] Solving...`);

      const progressInterval = setInterval(() => {
        const secs = Math.round((Date.now() - solveStart) / 1000);
        log.info(`[#${issue.number}] Still solving... (${secs}s)`);
      }, 30_000);

      let result: SolveResult;
      try {
        const logDir = getLogDir();
        const issueLogFile = logDir ? `${logDir}/issue-${issue.number}.log` : undefined;

        const context = {
          owner: github.owner,
          repo: github.repo,
          baseBranch: config.baseBranch,
          cwd: worktreePath,
          timeout: config.timeoutPerIssue,
          issueLogFile,
          codebaseContext: memory.getCodebaseContextPrompt(),
          crossIssueInsights: memory.getInsightsPrompt(),
        };

        if (isInvestigation) {
          result = await engine.investigate(issue, context);
        } else {
          result = await engine.solve(issue, context);
        }

        const elapsed = Math.round((Date.now() - solveStart) / 1000);
        log.success(`[#${issue.number}] Solved in ${elapsed}s (confidence: ${result.confidence}/10)`);
      } catch (solveErr) {
        log.error(`[#${issue.number}] Solving failed`);
        throw solveErr;
      } finally {
        clearInterval(progressInterval);
      }

      // Adjust confidence with heuristics
      result = adjustConfidence(result);

      // Post-solve test verification
      try {
        const { execFile: execFileSync } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execAsync = promisify(execFileSync);
        await execAsync(
          "npm", ["test"],
          { cwd: worktreePath, timeout: 60_000, maxBuffer: 5 * 1024 * 1024 },
        );
        log.debug(`[#${issue.number}] Tests passed`);
      } catch {
        log.warn(`[#${issue.number}] Tests failed after solve — lowering confidence`);
        result = {
          ...result,
          confidence: Math.max(1, result.confidence - 2),
          uncertainties: [...result.uncertainties, "Tests failed after changes were made"],
        };
      }

      // Commit and push (operates within the worktree directory)
      const { hasChanges } = await commitAndPush(branchName, result.commitMessage, worktreePath);

      if (!hasChanges) {
        log.warn(`[#${issue.number}] No changes produced`);
        issueStatus = "no-changes";

        telemetry.recordIssue({
          issueNumber: issue.number,
          classification: issue.classification || "unknown",
          confidence: result.confidence,
          solveTimeMs: Date.now() - solveStart,
          status: "no-changes",
          changedFileCount: 0,
          isInvestigation,
        });

        issueSummaries.push({
          number: issue.number,
          title: issue.title,
          classification: issue.classification || "unknown",
          status: "no-changes",
        });
        return;
      }

      // Get diff summary (from within the worktree)
      const diffSummary = await getDiffSummary(config.baseBranch, worktreePath);

      // Create PR
      const shouldDraft = config.createDraftPRs || result.confidence < config.draftThreshold;

      const pr = await createPRForIssue(github, issue, result, {
        branchName,
        baseBranch: config.baseBranch,
        diffSummary,
        draft: shouldDraft,
      });

      prsCreated.push({ ...pr, issueNumber: issue.number });

      if (config.autoLabel && issue.classification) {
        await github.addLabel(issue.number, `dispatch:${issue.classification}`);
      }

      issueStatus = "solved";

      // Collect insight for cross-issue learning
      memory.addInsight(issue.number, result, issue.classification || "unknown");

      telemetry.recordIssue({
        issueNumber: issue.number,
        classification: issue.classification || "unknown",
        confidence: result.confidence,
        solveTimeMs: Date.now() - solveStart,
        status: "solved",
        changedFileCount: result.changedFiles.length,
        isInvestigation,
      });

      issueSummaries.push({
        number: issue.number,
        title: issue.title,
        classification: issue.classification || "unknown",
        status: "solved",
        confidence: result.confidence,
        prNumber: pr.number,
        prUrl: pr.url,
        summary: result.summary,
      });

      log.success(`[#${issue.number}] PR #${pr.number} created (confidence: ${result.confidence}/10)`);

      // Save checkpoint for resume capability
      await saveCheckpoint(cwd, config.stateDir, issueSummaries);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error(`[#${issue.number}] Failed: ${errorMsg}`);

      telemetry.recordIssue({
        issueNumber: issue.number,
        classification: issue.classification || "unknown",
        confidence: null,
        solveTimeMs: Date.now() - issueStartTime,
        status: "failed",
        failureReason: errorMsg,
        changedFileCount: 0,
        isInvestigation: ["investigation", "audit", "documentation"].includes(
          issue.classification || ""
        ),
      });

      issueSummaries.push({
        number: issue.number,
        title: issue.title,
        classification: issue.classification || "unknown",
        status: "failed",
        error: errorMsg,
      });
    } finally {
      // Always clean up the worktree
      try {
        await removeWorktree(worktreePath, cwd, {
          deleteBranch: issueStatus !== "solved" ? branchName : undefined,
        });
      } catch {
        log.debug(`[#${issue.number}] Worktree cleanup failed (non-fatal)`);
      }

      semaphore.release();
    }
  };

  // Process issues in batches for cross-issue learning
  const batchSize = config.concurrency;
  for (let i = 0; i < issues.length; i += batchSize) {
    const batch = issues.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(issues.length / batchSize);

    log.info(`\nBatch ${batchNum}/${totalBatches} (${batch.length} issues)`);

    // Process batch in parallel (with semaphore for concurrency control)
    await Promise.all(batch.map(processIssue));

    // Log insight count between batches
    if (memory.getInsightCollector().count > 0 && i + batchSize < issues.length) {
      log.info(`[memory] ${memory.getInsightCollector().count} insights collected, feeding into next batch`);
    }
  }

  // 5. Generate summary
  const summary: RunSummary = {
    startedAt: new Date(startTime).toISOString(),
    duration: Date.now() - startTime,
    issues: issueSummaries,
    totalAttempted: issueSummaries.filter((i) => i.status !== "skipped").length,
    totalSolved: issueSummaries.filter((i) => i.status === "solved").length,
    totalFailed: issueSummaries.filter((i) => i.status === "failed").length,
    prsCreated,
    costSummary: router ? (() => {
      const cs = router.getCostSummary();
      return {
        totalCostUSD: cs.totalCostUSD,
        byPhase: cs.byPhase as Record<string, number>,
        byProvider: cs.byProvider,
        totalInputTokens: cs.totalInputTokens,
        totalOutputTokens: cs.totalOutputTokens,
      };
    })() : undefined,
    memoryStats: {
      codebaseContextLoaded: !!memory.getCodebaseContext(),
      insightsCollected: memory.getInsightCollector().count,
      lessonsLoaded: memory.lessonsCount,
    },
  };

  // Clear checkpoint on successful completion
  await clearCheckpoint(cwd, config.stateDir);

  await saveSummary(summary, cwd, config.stateDir);
  printSummary(summary);

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

function printSummary(summary: RunSummary) {
  log.header("Run Complete");

  const duration = Math.round(summary.duration / 1000 / 60);
  console.log(chalk.gray(`  Duration: ${duration} minutes`));
  console.log(
    `  ${chalk.green(`✓ ${summary.totalSolved} solved`)}  ` +
    `${chalk.red(`✗ ${summary.totalFailed} failed`)}  ` +
    `${chalk.gray(`${summary.issues.length} total`)}`
  );
  console.log();

  if (summary.prsCreated.length > 0) {
    console.log(chalk.bold("  Pull Requests:"));
    for (const pr of summary.prsCreated) {
      console.log(`    ${chalk.green("→")} PR #${pr.number} (issue #${pr.issueNumber}): ${pr.url}`);
    }
    console.log();
  }

  const failed = summary.issues.filter((i) => i.status === "failed");
  if (failed.length > 0) {
    console.log(chalk.bold("  Failed Issues:"));
    for (const issue of failed) {
      console.log(`    ${chalk.red("✗")} #${issue.number}: ${issue.title}`);
      if (issue.error) {
        console.log(chalk.gray(`      ${issue.error}`));
      }
    }
    console.log();
  }

  // Cost breakdown
  if (summary.costSummary && summary.costSummary.totalCostUSD > 0) {
    console.log(chalk.bold("  Cost Breakdown:"));
    for (const [phase, cost] of Object.entries(summary.costSummary.byPhase)) {
      if (cost > 0) {
        console.log(`    ${chalk.cyan(phase.padEnd(14))} $${cost.toFixed(4)}`);
      }
    }
    console.log(chalk.gray(`    ${"─".repeat(30)}`));
    console.log(`    ${chalk.bold("Total")}${" ".repeat(9)} ${chalk.yellow(`$${summary.costSummary.totalCostUSD.toFixed(4)}`)}`);
    console.log();
  }

  // Memory stats
  if (summary.memoryStats) {
    const m = summary.memoryStats;
    const parts: string[] = [];
    if (m.codebaseContextLoaded) parts.push("context cached");
    if (m.insightsCollected > 0) parts.push(`${m.insightsCollected} insights`);
    if (m.lessonsLoaded > 0) parts.push(`${m.lessonsLoaded} lessons`);
    if (parts.length > 0) {
      console.log(chalk.gray(`  Memory: ${parts.join(", ")}`));
      console.log();
    }
  }
}

/** Save checkpoint for resume capability */
async function saveCheckpoint(
  cwd: string,
  stateDir: string,
  issueSummaries: IssueSummary[],
): Promise<void> {
  try {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const dir = join(cwd, stateDir);
    await mkdir(dir, { recursive: true });
    const checkpoint = {
      processedIssues: issueSummaries.map((i) => i.number),
      timestamp: new Date().toISOString(),
    };
    await writeFile(join(dir, "checkpoint.json"), JSON.stringify(checkpoint, null, 2), "utf-8");
  } catch {
    // Non-fatal
  }
}

/** Clear checkpoint after successful run */
async function clearCheckpoint(cwd: string, stateDir: string): Promise<void> {
  try {
    const { unlink } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await unlink(join(cwd, stateDir, "checkpoint.json"));
  } catch {
    // Not found or already cleared
  }
}

/** Load checkpoint for resume */
export async function loadCheckpoint(cwd: string, stateDir: string): Promise<number[]> {
  try {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const raw = await readFile(join(cwd, stateDir, "checkpoint.json"), "utf-8");
    const data = JSON.parse(raw) as { processedIssues: number[] };
    return data.processedIssues || [];
  } catch {
    return [];
  }
}

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import type { AIEngine, Issue, RepoContext, SolveResult } from "../engine/types.js";
import type { GitHubClient } from "../github/client.js";
import type { DispatchConfig } from "../utils/config.js";
import { slugifyTitle } from "../github/issues.js";
import { createPRForIssue } from "../github/pulls.js";
import {
  git,
  stageChanges,
  stagedDiffStats,
  commitStaged,
  pushBranch,
  getDiffSummary,
  type DiffStats,
} from "../utils/git.js";
import { createWorktree, removeWorktree, getWorktreePath } from "../utils/worktree.js";
import { log, getLogDir } from "../utils/logger.js";
import { assessResult, LANE_LABELS, type Assessment } from "./scorer.js";
import { prepareWorktree, runVerify, verifyFeedback, type VerifyOutcome } from "./verify.js";
import type { Readiness } from "./readiness.js";
import { appendTranscriptEvent } from "../provenance/transcript.js";
import { appendTrailers, SESSION_TRAILER } from "../provenance/trailers.js";
import {
  saveSession,
  importNativeTranscript,
  pushSessionRef,
  sessionDir,
  TRANSCRIPT_FILE,
  type SessionRecord,
} from "../provenance/store.js";
import type { IssueSummary } from "../reporter/summary.js";
import type { IssueTelemetry } from "../telemetry/collector.js";

export interface SolveIssueContext {
  config: DispatchConfig;
  engine: AIEngine;
  github: GitHubClient;
  cwd: string;
  /** Command that verifies a change, or null when the project has none */
  verifyCommand: string | null;
  /** Repository brief shared by every session in the run, and the ref it describes */
  repoBrief?: { brief: string; ref: string };
  readiness?: Readiness;
  /** Spend cap for this issue in USD (undefined = no cap) */
  maxCostUsd?: number;
}

export interface IssueOutcome {
  summary: IssueSummary;
  telemetry: IssueTelemetry;
  costUsd: number;
  pr?: { number: number; url: string };
}

/** Issue types whose output is a report rather than a code change */
const REPORT_TYPES = ["investigation", "audit", "documentation"];

/** True if the worktree has changes other than the given linked paths */
async function hasChanges(worktreePath: string, ignore: string[]): Promise<boolean> {
  const { stdout } = await git(["status", "--porcelain"], worktreePath);
  return stdout
    .split("\n")
    .filter(Boolean)
    .some((line) => !ignore.includes(line.slice(3)));
}

/**
 * Run the verify command; if it fails, hand the output back to the agent and try again,
 * up to `repairAttempts` times. Returns the final result and verification outcome.
 */
async function verifyWithRepairs(
  issue: Issue,
  result: SolveResult,
  context: RepoContext,
  ctx: SolveIssueContext,
): Promise<{ result: SolveResult; verify: VerifyOutcome }> {
  const { config, engine } = ctx;
  const command = ctx.verifyCommand!;
  const runAndRecord = async (repairs: number): Promise<VerifyOutcome> => {
    log.info(`[#${issue.number}] Verifying: ${chalk.cyan(command)}`);
    const outcome = { ...(await runVerify(command, context.cwd, config.timeoutPerIssue)), repairs };
    await appendTranscriptEvent(context.transcriptFile, "verify", {
      command,
      status: outcome.status,
      exitCode: outcome.exitCode,
      durationMs: outcome.durationMs,
    });
    if (outcome.status === "passed") {
      log.success(`[#${issue.number}] Verification passed`);
    } else {
      log.warn(`[#${issue.number}] Verification failed (${outcome.timedOut ? "timed out" : `exit ${outcome.exitCode}`})`);
    }
    return outcome;
  };

  let verify = await runAndRecord(0);

  while (verify.status === "failed" && verify.repairs < config.repairAttempts && engine.repair) {
    const spent = result.session?.costUsd ?? 0;
    const remaining = ctx.maxCostUsd !== undefined ? ctx.maxCostUsd - spent : undefined;
    if (remaining !== undefined && remaining <= 0) {
      log.warn(`[#${issue.number}] Spend cap reached — not attempting a repair`);
      break;
    }

    const attempt = verify.repairs + 1;
    await appendTranscriptEvent(context.transcriptFile, "repair", { attempt });
    try {
      result = await engine.repair(issue, { ...context, maxCostUsd: remaining }, result, verifyFeedback(verify));
    } catch (err) {
      log.warn(`[#${issue.number}] Repair attempt ${attempt} failed: ${err instanceof Error ? err.message : err}`);
      break;
    }
    verify = await runAndRecord(attempt);
  }

  return { result, verify };
}

/** Save the session record and transcripts; push them to a ref when configured */
async function finalizeRecord(record: SessionRecord, ctx: SolveIssueContext, result?: SolveResult): Promise<void> {
  const { config, engine, cwd } = ctx;
  try {
    const nativePath = result?.session?.nativeTranscriptPath
      ?? (engine.locateTranscript ? await engine.locateTranscript(record.id) : null);
    if (nativePath) {
      await importNativeTranscript(nativePath, cwd, config.stateDir, record.id);
    }

    await saveSession(record, cwd, config.stateDir);

    if (config.provenance === "ref") {
      await pushSessionRef(record, cwd, config.stateDir);
      log.debug(`[#${record.issueNumber}] Session pushed to refs/dispatch/sessions/${record.id}`);
    }
  } catch (err) {
    log.warn(`[#${record.issueNumber}] Could not save session record: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Solve one issue end to end: worktree → agent → verify (and repair) → evidence-based
 * score → commit with provenance trailers → PR. A session record is written whatever happens.
 */
export async function solveIssue(issue: Issue, ctx: SolveIssueContext): Promise<IssueOutcome> {
  const { config, engine, github, cwd } = ctx;
  const sessionId = randomUUID();
  const branchName = `${config.branchPrefix}issue-${issue.number}-${slugifyTitle(issue.title)}`;
  const worktreePath = getWorktreePath(cwd, config.stateDir, issue.number);
  const classification = issue.classification || "unknown";
  const isInvestigation = REPORT_TYPES.includes(classification);
  const keepRecords = config.provenance !== "off";
  const startTime = Date.now();

  const record: SessionRecord = {
    version: 1,
    id: sessionId,
    repo: `${github.owner}/${github.repo}`,
    issueNumber: issue.number,
    issueTitle: issue.title,
    issueUrl: issue.url,
    classification,
    engine: engine.name,
    model: config.model,
    status: "failed",
    startedAt: new Date(startTime).toISOString(),
    durationMs: 0,
    readiness: ctx.readiness,
    branch: branchName,
    baseBranch: config.baseBranch,
    workdir: worktreePath,
    repoBrief: ctx.repoBrief ? { ref: ctx.repoBrief.ref, chars: ctx.repoBrief.brief.length } : undefined,
    hostname: hostname(),
  };

  let transcriptFile: string | undefined;
  if (keepRecords) {
    const dir = sessionDir(cwd, config.stateDir, sessionId);
    await mkdir(dir, { recursive: true });
    transcriptFile = join(dir, TRANSCRIPT_FILE);
  }

  let result: SolveResult | undefined;
  let verify: VerifyOutcome = { status: "skipped", repairs: 0 };
  let assessment: Assessment | undefined;
  let diff: DiffStats | undefined;
  let pr: { number: number; url: string } | undefined;
  let status: SessionRecord["status"] = "failed";
  let errorMsg: string | undefined;

  try {
    log.info(`[#${issue.number}] ${issue.title} (${classification})`);
    log.info(`[#${issue.number}] Creating worktree: ${chalk.cyan(branchName)}`);
    await createWorktree(worktreePath, branchName, config.baseBranch, cwd);

    const prep = await prepareWorktree(worktreePath, cwd, config.setupCommand, config.timeoutPerIssue);
    if (prep.setup && prep.setup.exitCode !== 0) {
      log.warn(`[#${issue.number}] Setup command failed (exit ${prep.setup.exitCode}) — continuing`);
    }

    const logDir = getLogDir();
    const context: RepoContext = {
      owner: github.owner,
      repo: github.repo,
      baseBranch: config.baseBranch,
      cwd: worktreePath,
      timeout: config.timeoutPerIssue,
      issueLogFile: logDir ? join(logDir, `issue-${issue.number}.log`) : undefined,
      transcriptFile,
      sessionId,
      maxCostUsd: ctx.maxCostUsd,
      allowedCommands: ctx.verifyCommand ? [ctx.verifyCommand] : [],
      repoBrief: ctx.repoBrief?.brief,
    };

    await appendTranscriptEvent(transcriptFile, "solve", { engine: engine.name, model: config.model, issue: issue.number });

    const solveStart = Date.now();
    log.info(`[#${issue.number}] Solving...`);
    const progressInterval = setInterval(() => {
      const secs = Math.round((Date.now() - solveStart) / 1000);
      log.info(`[#${issue.number}] Still solving... (${secs}s)`);
    }, 30_000);

    try {
      result = isInvestigation
        ? await engine.investigate(issue, context)
        : await engine.solve(issue, context);
    } finally {
      clearInterval(progressInterval);
    }

    const elapsed = Math.round((Date.now() - solveStart) / 1000);
    log.success(`[#${issue.number}] Solved in ${elapsed}s (self-assessed ${result.confidence}/10)`);

    if (ctx.verifyCommand && (await hasChanges(worktreePath, prep.linked))) {
      ({ result, verify } = await verifyWithRepairs(issue, result, context, ctx));
    }

    const { staged, heldBack } = await stageChanges(worktreePath, prep.linked);
    if (heldBack.length > 0) {
      log.warn(`[#${issue.number}] Held back possible secrets: ${heldBack.join(", ")}`);
    }

    if (staged.length === 0) {
      log.warn(`[#${issue.number}] No changes produced`);
      status = "no-changes";
    } else {
      diff = await stagedDiffStats(worktreePath);
      assessment = assessResult(
        result,
        { verify: verify.status, verifyCommand: verify.command, diff, classification: issue.classification },
        config,
      );
      result = { ...result, confidence: assessment.confidence, changedFiles: diff.files };

      if (verify.status === "failed" && config.onVerifyFail === "skip") {
        throw new Error(`Verification failed (\`${verify.command}\`) — no PR opened (onVerifyFail: "skip")`);
      }

      const message = appendTrailers(result.commitMessage, {
        [SESSION_TRAILER]: keepRecords ? sessionId : undefined,
        "Dispatch-Issue": `#${issue.number}`,
        "Dispatch-Agent": `${engine.name}/${config.model}`,
        "Dispatch-Confidence": `${assessment.confidence}/10`,
        "Dispatch-Verify": verify.command ? `${verify.status} (${verify.command})` : "not run",
      });
      record.commitSha = await commitStaged(message, worktreePath);
      await pushBranch(branchName, worktreePath);

      const diffSummary = await getDiffSummary(config.baseBranch, worktreePath);
      pr = await createPRForIssue(github, issue, result, {
        branchName,
        baseBranch: config.baseBranch,
        diffSummary,
        draft: config.createDraftPRs || assessment.lane === "draft",
        details: {
          assessment,
          verify: verify.command ? verify : undefined,
          heldBack,
          session: keepRecords
            ? { id: sessionId, engine: engine.name, model: config.model, costUsd: result.session?.costUsd, turns: result.session?.turns }
            : undefined,
        },
      });

      if (config.autoLabel && issue.classification) {
        await github.addLabel(issue.number, `dispatch:${issue.classification}`);
      }

      status = "solved";
      record.prNumber = pr.number;
      record.prUrl = pr.url;
      record.heldBack = heldBack.length > 0 ? heldBack : undefined;
      log.success(
        `[#${issue.number}] PR #${pr.number} created — ${LANE_LABELS[assessment.lane]} (confidence: ${assessment.confidence}/10)`
      );
    }
  } catch (err) {
    errorMsg = err instanceof Error ? err.message : String(err);
    log.error(`[#${issue.number}] Failed: ${errorMsg}`);
  } finally {
    record.status = status;
    record.error = errorMsg;
    record.durationMs = Date.now() - startTime;
    record.costUsd = result?.session?.costUsd;
    record.turns = result?.session?.turns;
    record.verify = verify.command ? verify : undefined;
    record.assessment = assessment;
    record.diff = diff;
    record.summary = result?.summary;
    record.uncertainties = result?.uncertainties;

    if (keepRecords) {
      await finalizeRecord(record, ctx, result);
    }

    // Always clean up the worktree; keep the branch only when a PR uses it
    try {
      await removeWorktree(worktreePath, cwd, {
        deleteBranch: status !== "solved" ? branchName : undefined,
      });
    } catch {
      log.debug(`[#${issue.number}] Worktree cleanup failed (non-fatal)`);
    }
  }

  const costUsd = result?.session?.costUsd ?? 0;
  const summary: IssueSummary = {
    number: issue.number,
    title: issue.title,
    classification,
    status,
    confidence: assessment?.confidence ?? result?.confidence,
    prNumber: pr?.number,
    prUrl: pr?.url,
    summary: status === "solved" ? result?.summary : undefined,
    error: errorMsg,
    lane: assessment?.lane,
    draft: pr ? config.createDraftPRs || assessment?.lane === "draft" : undefined,
    verify: verify.command ? verify.status : undefined,
    verifyCommand: verify.command,
    costUsd: result?.session?.costUsd,
    sessionId: keepRecords ? sessionId : undefined,
    readiness: ctx.readiness?.score,
    diff: diff ? { files: diff.files.length, additions: diff.additions, deletions: diff.deletions } : undefined,
  };

  const telemetry: IssueTelemetry = {
    issueNumber: issue.number,
    classification: issue.classification || "unknown",
    confidence: status === "failed" ? null : summary.confidence ?? null,
    solveTimeMs: Date.now() - startTime,
    status,
    failureReason: errorMsg,
    changedFileCount: diff?.files.length ?? 0,
    isInvestigation,
  };

  return { summary, telemetry, costUsd, pr };
}

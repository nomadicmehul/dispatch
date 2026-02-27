import type { IssueClassification } from "../engine/types.js";

/** Per-issue telemetry record */
export interface IssueTelemetry {
  issueNumber: number;
  classification: IssueClassification | "unknown";
  confidence: number | null;
  solveTimeMs: number;
  status: "solved" | "failed" | "no-changes" | "skipped";
  failureReason?: string;
  changedFileCount: number;
  isInvestigation: boolean;
}

/** Aggregate run telemetry event */
export interface RunTelemetryEvent {
  anonymousId: string;
  eventType: "run_completed";
  timestamp: string;
  durationMs: number;

  repoOwner: string;
  repoName: string;

  engine: string;
  model: string;
  concurrency: number;
  maxIssues: number;
  maxTurnsPerIssue: number;
  draftThreshold: number;
  createDraftPRs: boolean;

  issuesChecked: number;
  issuesProcessed: number;
  issuesSolved: number;
  issuesFailed: number;
  issuesNoChanges: number;
  prsCreated: number;

  classificationBreakdown: Record<string, number>;
  confidenceScores: number[];
  solveTimes: number[];
  failureCategories: string[];

  avgChangedFiles: number;
  investigationCount: number;
}

/** Categorize a failure reason into a generic bucket (no PII) */
export function categorizeFailure(error: string): string {
  const lower = error.toLowerCase();
  if (lower.includes("timeout")) return "timeout";
  if (lower.includes("rate limit") || lower.includes("ratelimit")) return "rate-limit";
  if (lower.includes("token") || lower.includes("auth")) return "auth-error";
  if (lower.includes("parse") || lower.includes("json")) return "parse-error";
  if (lower.includes("spawn") || lower.includes("enoent")) return "engine-not-found";
  if (lower.includes("network") || lower.includes("fetch")) return "network-error";
  return "unknown-error";
}

/** Collects metrics during a single pipeline run */
export class TelemetryCollector {
  private issues: IssueTelemetry[] = [];
  private issuesCheckedCount = 0;
  private solveStartTimes = new Map<number, number>();

  /** Record the total number of issues fetched from GitHub */
  recordIssuesChecked(count: number): void {
    this.issuesCheckedCount = count;
  }

  /** Mark the start of solving an issue (for timing) */
  startSolve(issueNumber: number): void {
    this.solveStartTimes.set(issueNumber, Date.now());
  }

  /** Get the start time for an issue solve */
  getSolveStartTime(issueNumber: number): number | undefined {
    return this.solveStartTimes.get(issueNumber);
  }

  /** Record the outcome of processing a single issue */
  recordIssue(telemetry: IssueTelemetry): void {
    this.issues.push(telemetry);
  }

  /** Build the final telemetry event for the completed run */
  buildEvent(params: {
    anonymousId: string;
    startedAt: string;
    durationMs: number;
    repoOwner: string;
    repoName: string;
    engine: string;
    model: string;
    concurrency: number;
    maxIssues: number;
    maxTurnsPerIssue: number;
    draftThreshold: number;
    createDraftPRs: boolean;
    prsCreated: number;
  }): RunTelemetryEvent {
    const classificationBreakdown: Record<string, number> = {};
    const confidenceScores: number[] = [];
    const solveTimes: number[] = [];
    const failureCategories: string[] = [];
    let totalChangedFiles = 0;
    let investigationCount = 0;

    for (const issue of this.issues) {
      const cls = issue.classification || "unknown";
      classificationBreakdown[cls] = (classificationBreakdown[cls] || 0) + 1;

      if (issue.confidence !== null) {
        confidenceScores.push(issue.confidence);
      }

      if (issue.solveTimeMs > 0) {
        solveTimes.push(issue.solveTimeMs);
      }

      if (issue.status === "failed" && issue.failureReason) {
        failureCategories.push(categorizeFailure(issue.failureReason));
      }

      totalChangedFiles += issue.changedFileCount;
      if (issue.isInvestigation) investigationCount++;
    }

    return {
      anonymousId: params.anonymousId,
      eventType: "run_completed",
      timestamp: params.startedAt,
      durationMs: params.durationMs,
      repoOwner: params.repoOwner,
      repoName: params.repoName,
      engine: params.engine,
      model: params.model,
      concurrency: params.concurrency,
      maxIssues: params.maxIssues,
      maxTurnsPerIssue: params.maxTurnsPerIssue,
      draftThreshold: params.draftThreshold,
      createDraftPRs: params.createDraftPRs,
      issuesChecked: this.issuesCheckedCount,
      issuesProcessed: this.issues.filter((i) => i.status !== "skipped").length,
      issuesSolved: this.issues.filter((i) => i.status === "solved").length,
      issuesFailed: this.issues.filter((i) => i.status === "failed").length,
      issuesNoChanges: this.issues.filter((i) => i.status === "no-changes").length,
      prsCreated: params.prsCreated,
      classificationBreakdown,
      confidenceScores,
      solveTimes,
      failureCategories,
      avgChangedFiles: this.issues.length > 0
        ? totalChangedFiles / this.issues.length
        : 0,
      investigationCount,
    };
  }
}

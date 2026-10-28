import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Lane } from "../orchestrator/scorer.js";
import type { SkipReason } from "../orchestrator/selection.js";
import type { VerifyStatus } from "../orchestrator/verify.js";

export interface IssueSummary {
  number: number;
  title: string;
  classification: string;
  status: "solved" | "failed" | "skipped" | "no-changes";
  confidence?: number;
  prNumber?: number;
  prUrl?: string;
  summary?: string;
  error?: string;
  /** Review lane for solved issues */
  lane?: Lane;
  draft?: boolean;
  verify?: VerifyStatus;
  verifyCommand?: string;
  costUsd?: number;
  sessionId?: string;
  readiness?: number;
  diff?: { files: number; additions: number; deletions: number };
  skipReason?: SkipReason | "dry-run";
  skipDetail?: string;
}

export interface RunSummary {
  startedAt: string;
  duration: number;
  issues: IssueSummary[];
  totalAttempted: number;
  totalSolved: number;
  totalFailed: number;
  prsCreated: Array<{ number: number; url: string; issueNumber: number }>;
  /** Estimated spend in USD, when the engine reports it */
  totalCostUsd?: number;
}

export async function saveSummary(
  summary: RunSummary,
  cwd: string,
  stateDir: string
): Promise<string> {
  const dir = join(cwd, stateDir);
  await mkdir(dir, { recursive: true });

  const filePath = join(dir, "last-run.json");
  await writeFile(filePath, JSON.stringify(summary, null, 2) + "\n", "utf-8");

  // Also save timestamped run
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const historyPath = join(dir, `run-${timestamp}.json`);
  await writeFile(historyPath, JSON.stringify(summary, null, 2) + "\n", "utf-8");

  return filePath;
}

export async function loadLastSummary(
  cwd: string,
  stateDir: string
): Promise<RunSummary | null> {
  try {
    const filePath = join(cwd, stateDir, "last-run.json");
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw) as RunSummary;
  } catch {
    return null;
  }
}

export function formatCost(costUsd: number | undefined): string {
  return costUsd === undefined ? "" : `$${costUsd.toFixed(2)}`;
}

/** One-line evidence summary for a solved issue */
function evidenceLine(issue: IssueSummary): string {
  const parts: string[] = [];
  if (issue.confidence !== undefined) parts.push(`${issue.confidence}/10`);
  if (issue.verify === "passed") parts.push(`${issue.verifyCommand} ✓`);
  if (issue.verify === "failed") parts.push(`${issue.verifyCommand} ✗`);
  if (issue.verify === "skipped") parts.push("not verified");
  if (issue.diff) parts.push(`+${issue.diff.additions} −${issue.diff.deletions}`);
  if (issue.costUsd !== undefined) parts.push(formatCost(issue.costUsd));
  return parts.join(" · ");
}

const LANE_SECTIONS: Array<{ lane: Lane; heading: string }> = [
  { lane: "ready", heading: "✅ Ready to merge" },
  { lane: "review", heading: "👀 Needs eyes" },
  { lane: "draft", heading: "📝 Drafts" },
];

/**
 * Format the morning report as a review queue: PRs grouped by lane, most
 * mergeable first, then failures and the issues Dispatch chose to skip.
 */
export function formatMorningSummary(summary: RunSummary): string {
  const duration = Math.round(summary.duration / 1000 / 60);
  const lines: string[] = [];
  const solved = summary.issues.filter((i) => i.status === "solved");
  const failed = summary.issues.filter((i) => i.status === "failed");
  const noChanges = summary.issues.filter((i) => i.status === "no-changes");
  const skipped = summary.issues.filter((i) => i.status === "skipped");

  lines.push(`☀️  Dispatch Morning Report`);
  lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`Run started: ${summary.startedAt}`);
  lines.push(`Duration: ${duration} minutes${summary.totalCostUsd ? ` · Cost: ${formatCost(summary.totalCostUsd)}` : ""}`);
  lines.push(``);

  const laneCounts = LANE_SECTIONS
    .map(({ lane }) => ({ lane, count: solved.filter((i) => (i.lane ?? "review") === lane).length }))
    .filter((c) => c.count > 0)
    .map((c) => `${c.count} ${c.lane}`);
  lines.push(
    `📊 Results: ${summary.prsCreated.length} PRs${laneCounts.length ? ` (${laneCounts.join(", ")})` : ""}, ` +
    `${summary.totalFailed} failed, ${skipped.length} skipped`
  );
  lines.push(``);

  for (const { lane, heading } of LANE_SECTIONS) {
    const inLane = solved.filter((i) => (i.lane ?? "review") === lane);
    if (inLane.length === 0) continue;

    lines.push(heading);
    for (const issue of inLane) {
      const pr = issue.prNumber ? `PR #${issue.prNumber} → ` : "";
      lines.push(`   ${pr}#${issue.number}: ${issue.title}`);
      const evidence = evidenceLine(issue);
      if (evidence) lines.push(`     ${evidence}`);
      if (issue.prUrl) lines.push(`     ${issue.prUrl}`);
      if (issue.summary) lines.push(`   └─ ${issue.summary}`);
    }
    lines.push(``);
  }

  if (failed.length > 0) {
    lines.push(`❌ Failed:`);
    for (const issue of failed) {
      lines.push(`   #${issue.number}: ${issue.title}`);
      if (issue.error) {
        lines.push(`   └─ ${issue.error}`);
      }
    }
    lines.push(``);
  }

  if (noChanges.length > 0) {
    lines.push(`⚪ No changes needed:`);
    for (const issue of noChanges) {
      lines.push(`   #${issue.number}: ${issue.title}`);
    }
    lines.push(``);
  }

  if (skipped.length > 0) {
    lines.push(`⏭️  Skipped:`);
    const byReason = new Map<string, IssueSummary[]>();
    for (const issue of skipped) {
      const reason = issue.skipReason ?? "skipped";
      byReason.set(reason, [...(byReason.get(reason) ?? []), issue]);
    }
    for (const [reason, issues] of byReason) {
      lines.push(`   ${reason} (${issues.length})`);
      for (const issue of issues.slice(0, 5)) {
        lines.push(`   └─ #${issue.number}: ${issue.title}${issue.skipDetail ? ` — ${issue.skipDetail}` : ""}`);
      }
      if (issues.length > 5) lines.push(`      … and ${issues.length - 5} more`);
    }
    lines.push(``);
  }

  if (solved.length > 0 || failed.length > 0) {
    lines.push(`🔍 See how any result was made: dispatch explain <issue-or-pr-number>`);
  }

  return lines.join("\n");
}

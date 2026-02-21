import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";

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
}

export interface RunSummary {
  startedAt: string;
  duration: number;
  issues: IssueSummary[];
  totalAttempted: number;
  totalSolved: number;
  totalFailed: number;
  prsCreated: Array<{ number: number; url: string; issueNumber: number }>;
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

/** Format a human-readable morning summary */
export function formatMorningSummary(summary: RunSummary): string {
  const duration = Math.round(summary.duration / 1000 / 60);
  const lines: string[] = [];

  lines.push(`☀️  Dispatch Morning Report`);
  lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`Run started: ${summary.startedAt}`);
  lines.push(`Duration: ${duration} minutes`);
  lines.push(``);
  lines.push(`📊 Results: ${summary.totalSolved} solved, ${summary.totalFailed} failed, ${summary.issues.length} total`);
  lines.push(``);

  if (summary.prsCreated.length > 0) {
    lines.push(`🔗 Pull Requests:`);
    for (const pr of summary.prsCreated) {
      const issue = summary.issues.find((i) => i.number === pr.issueNumber);
      const confidence = issue?.confidence ? ` (confidence: ${issue.confidence}/10)` : "";
      lines.push(`   → PR #${pr.number} for issue #${pr.issueNumber}${confidence}`);
      lines.push(`     ${pr.url}`);
    }
    lines.push(``);
  }

  const solved = summary.issues.filter((i) => i.status === "solved");
  if (solved.length > 0) {
    lines.push(`✅ Solved:`);
    for (const issue of solved) {
      lines.push(`   #${issue.number}: ${issue.title}`);
      if (issue.summary) {
        lines.push(`   └─ ${issue.summary}`);
      }
    }
    lines.push(``);
  }

  const failed = summary.issues.filter((i) => i.status === "failed");
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

  const noChanges = summary.issues.filter((i) => i.status === "no-changes");
  if (noChanges.length > 0) {
    lines.push(`⚪ No changes needed:`);
    for (const issue of noChanges) {
      lines.push(`   #${issue.number}: ${issue.title}`);
    }
    lines.push(``);
  }

  return lines.join("\n");
}

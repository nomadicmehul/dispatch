import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { RunTelemetryEvent } from "./collector.js";

/** Cumulative statistics stored in .dispatch/stats.json */
export interface AggregateStats {
  version: 1;
  firstRunAt: string;
  lastRunAt: string;
  totalRuns: number;
  totalIssuesChecked: number;
  totalIssuesProcessed: number;
  totalIssuesSolved: number;
  totalIssuesFailed: number;
  totalPRsCreated: number;
  totalDurationMs: number;
  classificationBreakdown: Record<string, number>;
  confidenceHistogram: Record<string, number>;
  engineUsage: Record<string, number>;
  avgSolveTimeMs: number;
  failureCategoryBreakdown: Record<string, number>;
  recentRuns: Array<{
    timestamp: string;
    issuesProcessed: number;
    issuesSolved: number;
    prsCreated: number;
    durationMs: number;
  }>;
}

const STATS_FILENAME = "stats.json";
const MAX_RECENT_RUNS = 50;

function emptyStats(): AggregateStats {
  return {
    version: 1,
    firstRunAt: "",
    lastRunAt: "",
    totalRuns: 0,
    totalIssuesChecked: 0,
    totalIssuesProcessed: 0,
    totalIssuesSolved: 0,
    totalIssuesFailed: 0,
    totalPRsCreated: 0,
    totalDurationMs: 0,
    classificationBreakdown: {},
    confidenceHistogram: {},
    engineUsage: {},
    avgSolveTimeMs: 0,
    failureCategoryBreakdown: {},
    recentRuns: [],
  };
}

export async function loadStats(cwd: string, stateDir: string): Promise<AggregateStats> {
  try {
    const filePath = join(cwd, stateDir, STATS_FILENAME);
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw) as AggregateStats;
  } catch {
    return emptyStats();
  }
}

export async function updateStats(
  event: RunTelemetryEvent,
  cwd: string,
  stateDir: string,
): Promise<void> {
  const stats = await loadStats(cwd, stateDir);

  if (!stats.firstRunAt) stats.firstRunAt = event.timestamp;
  stats.lastRunAt = event.timestamp;
  stats.totalRuns++;
  stats.totalIssuesChecked += event.issuesChecked;
  stats.totalIssuesProcessed += event.issuesProcessed;
  stats.totalIssuesSolved += event.issuesSolved;
  stats.totalIssuesFailed += event.issuesFailed;
  stats.totalPRsCreated += event.prsCreated;
  stats.totalDurationMs += event.durationMs;

  for (const [cls, count] of Object.entries(event.classificationBreakdown)) {
    stats.classificationBreakdown[cls] = (stats.classificationBreakdown[cls] || 0) + count;
  }

  for (const score of event.confidenceScores) {
    const key = String(Math.round(score));
    stats.confidenceHistogram[key] = (stats.confidenceHistogram[key] || 0) + 1;
  }

  const engineKey = `${event.engine}:${event.model}`;
  stats.engineUsage[engineKey] = (stats.engineUsage[engineKey] || 0) + 1;

  const totalSolveSamples = event.solveTimes.length;
  if (totalSolveSamples > 0) {
    const newAvg = event.solveTimes.reduce((a, b) => a + b, 0) / totalSolveSamples;
    const prevWeight = Math.max(0, stats.totalRuns - 1);
    stats.avgSolveTimeMs = prevWeight > 0
      ? (stats.avgSolveTimeMs * prevWeight + newAvg) / stats.totalRuns
      : newAvg;
  }

  for (const cat of event.failureCategories) {
    stats.failureCategoryBreakdown[cat] = (stats.failureCategoryBreakdown[cat] || 0) + 1;
  }

  stats.recentRuns.push({
    timestamp: event.timestamp,
    issuesProcessed: event.issuesProcessed,
    issuesSolved: event.issuesSolved,
    prsCreated: event.prsCreated,
    durationMs: event.durationMs,
  });
  if (stats.recentRuns.length > MAX_RECENT_RUNS) {
    stats.recentRuns = stats.recentRuns.slice(-MAX_RECENT_RUNS);
  }

  const dir = join(cwd, stateDir);
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, STATS_FILENAME);
  await writeFile(filePath, JSON.stringify(stats, null, 2) + "\n", "utf-8");
}

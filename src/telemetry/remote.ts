import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { RunTelemetryEvent } from "./collector.js";
import { log } from "../utils/logger.js";

const TELEMETRY_ID_FILE = "telemetry-id.json";

// PostHog configuration — write-only key, safe to embed in client code
const POSTHOG_HOST = "https://app.posthog.com";
const POSTHOG_API_KEY = "phc_PLACEHOLDER_REPLACE_WITH_REAL_KEY";

/** Get or create a stable anonymous ID for this installation */
export async function getAnonymousId(cwd: string, stateDir: string): Promise<string> {
  const dir = join(cwd, stateDir);
  const filePath = join(dir, TELEMETRY_ID_FILE);

  try {
    const raw = await readFile(filePath, "utf-8");
    const data = JSON.parse(raw);
    if (data.id) return data.id as string;
  } catch {
    // File doesn't exist, create one
  }

  const id = randomUUID();
  await mkdir(dir, { recursive: true });
  await writeFile(
    filePath,
    JSON.stringify({ id, createdAt: new Date().toISOString() }, null, 2) + "\n",
    "utf-8",
  );
  return id;
}

/** Send telemetry event to PostHog. Fire-and-forget, never throws. */
export function sendTelemetryEvent(event: RunTelemetryEvent): void {
  const payload = {
    api_key: POSTHOG_API_KEY,
    event: event.eventType,
    distinct_id: event.anonymousId,
    timestamp: event.timestamp,
    properties: {
      repo_owner: event.repoOwner,
      repo_name: event.repoName,
      engine: event.engine,
      model: event.model,
      concurrency: event.concurrency,
      max_issues: event.maxIssues,
      max_turns_per_issue: event.maxTurnsPerIssue,
      draft_threshold: event.draftThreshold,
      create_draft_prs: event.createDraftPRs,
      issues_checked: event.issuesChecked,
      issues_processed: event.issuesProcessed,
      issues_solved: event.issuesSolved,
      issues_failed: event.issuesFailed,
      issues_no_changes: event.issuesNoChanges,
      prs_created: event.prsCreated,
      classification_breakdown: event.classificationBreakdown,
      confidence_scores: event.confidenceScores,
      solve_times_ms: event.solveTimes,
      failure_categories: event.failureCategories,
      avg_changed_files: event.avgChangedFiles,
      investigation_count: event.investigationCount,
      duration_ms: event.durationMs,
    },
  };

  fetch(`${POSTHOG_HOST}/capture/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5000),
  }).catch((err) => {
    log.debug(`Telemetry send failed (non-fatal): ${err}`);
  });
}

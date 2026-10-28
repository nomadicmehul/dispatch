import type { Issue } from "../engine/types.js";

/** How ready an issue is to hand to an agent, on a 0-10 scale */
export interface Readiness {
  score: number;
  /** What earned points */
  reasons: string[];
  /** What would make the issue easier to solve */
  missing: string[];
}

const FILE_REFERENCE = /\b[\w./-]+\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|cs|c|cc|cpp|h|swift|md|json|ya?ml|toml|css|scss|html|sql|sh)\b/;
const CODE_OR_LOG = /```|`[^`\n]+`|\bat \S+:\d+|\b(Error|Exception|Traceback)\b/;
const STRUCTURE = /\b(steps to reproduce|repro|expected|actual|acceptance criteria|definition of done)\b/i;
const CHECKLIST = /^\s*[-*] \[[ xX]\]/m;

/**
 * Score how well an issue describes the work, with cheap heuristics (no AI call).
 * Vague one-liners score low and are skipped instead of producing a guessed PR.
 * A maintainer can always opt an issue in with the ready label.
 */
export function scoreReadiness(issue: Issue, options: { readyLabel?: string } = {}): Readiness {
  if (options.readyLabel && issue.labels.includes(options.readyLabel)) {
    return { score: 10, reasons: [`labelled ${options.readyLabel}`], missing: [] };
  }

  const reasons: string[] = [];
  const missing: string[] = [];
  const body = issue.body.trim();
  let score = 0;

  if (issue.title.trim().length >= 15 && issue.title.trim().split(/\s+/).length >= 3) {
    score += 1;
    reasons.push("descriptive title");
  } else {
    missing.push("a descriptive title");
  }

  if (body.length >= 80) {
    score += body.length >= 300 ? 3 : 2;
    reasons.push("detailed description");
  } else {
    missing.push("a description of a few sentences");
  }

  if (FILE_REFERENCE.test(body)) {
    score += 2;
    reasons.push("names files or code");
  } else {
    missing.push("the files or code involved");
  }

  if (STRUCTURE.test(body)) {
    score += 2;
    reasons.push("expected behaviour or acceptance criteria");
  } else {
    missing.push("expected vs. actual behaviour, or acceptance criteria");
  }

  if (CODE_OR_LOG.test(body)) {
    score += 1;
    reasons.push("code, logs, or errors");
  }

  if (CHECKLIST.test(body)) {
    score += 1;
    reasons.push("task checklist");
  }

  return { score: Math.min(10, score), reasons, missing };
}

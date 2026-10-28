import type { IssueClassification, SolveResult } from "../engine/types.js";
import type { DiffStats } from "../utils/git.js";
import type { VerifyStatus } from "./verify.js";

/** Where a PR lands in the morning review queue */
export type Lane = "ready" | "review" | "draft";

/** One piece of evidence behind a score: true = good, false = concern, null = information */
export interface Signal {
  ok: boolean | null;
  label: string;
}

export interface Assessment {
  /** Final confidence (1-10) after evidence */
  confidence: number;
  /** What the agent said about its own work */
  selfConfidence: number;
  lane: Lane;
  signals: Signal[];
}

export interface Evidence {
  verify: VerifyStatus;
  verifyCommand?: string;
  diff: DiffStats;
  classification?: IssueClassification;
}

const CODE_TYPES: Array<IssueClassification | undefined> = ["code-fix", "feature", "refactor", "unknown", undefined];

/** True for test files: tests/ and __tests__/ folders, *.test.* and *.spec.* files, Go and Python test files */
export function isTestPath(filePath: string): boolean {
  return (
    /(^|\/)(tests?|__tests__|spec)\//.test(filePath) ||
    /\.(test|spec)\.[a-z]+$/.test(filePath) ||
    /_test\.(go|py)$/.test(filePath) ||
    /(^|\/)test_[^/]+\.py$/.test(filePath)
  );
}

const clamp = (n: number) => Math.min(10, Math.max(1, n));

/**
 * Combine the agent's self-assessment with evidence Dispatch checked itself
 * (verification, the real diff, test changes) into a score and a review lane.
 */
export function assessResult(
  result: SolveResult,
  evidence: Evidence,
  options: { draftThreshold: number; maxDiffLines: number },
): Assessment {
  const selfConfidence = clamp(result.confidence);
  const signals: Signal[] = [{ ok: null, label: `Agent self-assessed ${selfConfidence}/10` }];
  const isCode = CODE_TYPES.includes(evidence.classification);
  let score = selfConfidence;

  if (evidence.verify === "passed") {
    score += 1;
    signals.push({ ok: true, label: `\`${evidence.verifyCommand}\` passed` });
  } else if (evidence.verify === "failed") {
    score = Math.min(score, 3);
    signals.push({ ok: false, label: `\`${evidence.verifyCommand}\` failed` });
  } else if (isCode) {
    score -= 1;
    signals.push({ ok: null, label: "No verify command — changes were not tested" });
  }

  const testsTouched = evidence.diff.files.some(isTestPath);
  if (testsTouched) {
    if (isCode) score += 1;
    signals.push({ ok: true, label: "Tests added or updated" });
  } else if (evidence.classification === "code-fix" || evidence.classification === "feature") {
    signals.push({ ok: false, label: "No test changes" });
  }

  const lines = evidence.diff.additions + evidence.diff.deletions;
  const fileCount = evidence.diff.files.length;
  const largeDiff = lines > options.maxDiffLines;
  if (largeDiff) {
    score -= 2;
    signals.push({ ok: false, label: `Large diff: ${lines} lines (limit ${options.maxDiffLines})` });
  } else {
    signals.push({ ok: true, label: `Diff size: ${lines} lines across ${fileCount} file${fileCount === 1 ? "" : "s"}` });
  }
  if (fileCount > 10) score -= 1;

  if (result.uncertainties.length >= 3) {
    score -= 1;
    signals.push({ ok: false, label: `${result.uncertainties.length} open uncertainties` });
  }

  if (fileCount === 0) score = Math.min(score, 3);

  const confidence = clamp(score);
  let lane: Lane = "review";
  if (confidence < options.draftThreshold || evidence.verify === "failed" || largeDiff) {
    lane = "draft";
  } else if (confidence >= 8 && evidence.verify === "passed" && result.uncertainties.length === 0) {
    lane = "ready";
  }

  return { confidence, selfConfidence, lane, signals };
}

/** Determine PR type based on confidence */
export function shouldBeDraft(confidence: number, threshold: number): boolean {
  return confidence < threshold;
}

/** Generate a human-readable confidence label */
export function confidenceLabel(score: number): string {
  if (score >= 9) return "Very High — ship it";
  if (score >= 7) return "High — review recommended";
  if (score >= 5) return "Medium — careful review needed";
  if (score >= 3) return "Low — significant manual review";
  return "Very Low — mostly exploratory";
}

export const LANE_LABELS: Record<Lane, string> = {
  ready: "Ready to merge",
  review: "Needs eyes",
  draft: "Draft",
};

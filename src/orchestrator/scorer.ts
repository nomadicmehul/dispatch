import type { SolveResult } from "../engine/types.js";

/** Adjust confidence based on heuristics */
export function adjustConfidence(result: SolveResult): SolveResult {
  let adjustedScore = result.confidence;

  // Boost confidence if there are changed files and no uncertainties
  if (result.changedFiles.length > 0 && result.uncertainties.length === 0) {
    adjustedScore = Math.min(10, adjustedScore + 1);
  }

  // Lower confidence if many files changed (risky)
  if (result.changedFiles.length > 10) {
    adjustedScore = Math.max(1, adjustedScore - 1);
  }

  // Lower confidence if no files changed but success claimed
  if (result.success && result.changedFiles.length === 0) {
    adjustedScore = Math.min(adjustedScore, 3);
  }

  // Lower confidence if too many uncertainties
  if (result.uncertainties.length >= 3) {
    adjustedScore = Math.max(1, adjustedScore - 1);
  }

  return {
    ...result,
    confidence: adjustedScore,
  };
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

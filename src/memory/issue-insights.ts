import type { IssueInsight, RunInsights } from "./types.js";
import type { SolveResult } from "../engine/types.js";
import { log } from "../utils/logger.js";

/**
 * Manages cross-issue insights within a single run.
 * Insights from batch N are fed into batch N+1.
 */
export class InsightCollector {
  private insights: IssueInsight[] = [];
  private maxInsights: number;

  constructor(maxInsights: number = 20) {
    this.maxInsights = maxInsights;
  }

  /**
   * Extract insights from a completed solve result.
   * Called after each successful issue solve.
   */
  addFromSolve(
    issueNumber: number,
    result: SolveResult,
    classification: string,
  ): void {
    // Extract patterns from changed files
    const patterns: string[] = [];
    const dirs = new Set(result.changedFiles.map((f) => f.split("/").slice(0, -1).join("/")));
    if (dirs.size > 0) {
      patterns.push(`Modified directories: ${[...dirs].join(", ")}`);
    }

    // Extract insight from summary
    const insight: IssueInsight = {
      fromIssue: issueNumber,
      insight: `Issue #${issueNumber} (${classification}): ${result.summary}`,
      relevantFiles: result.changedFiles.slice(0, 10), // Cap at 10
      patterns,
      confidence: result.confidence,
      timestamp: Date.now(),
    };

    this.insights.push(insight);

    // Keep only the most recent/high-confidence insights
    if (this.insights.length > this.maxInsights) {
      this.insights.sort((a, b) => b.confidence - a.confidence);
      this.insights = this.insights.slice(0, this.maxInsights);
    }

    log.debug(`[memory] Added insight from issue #${issueNumber} (total: ${this.insights.length})`);
  }

  /**
   * Format insights for injection into an AI prompt.
   * Returns a concise summary suitable for the context window.
   */
  formatForPrompt(): string {
    if (this.insights.length === 0) return "";

    const lines = [
      "## Insights from previously solved issues in this run",
      "",
    ];

    for (const insight of this.insights) {
      lines.push(`- ${insight.insight}`);
      if (insight.relevantFiles.length > 0) {
        lines.push(`  Files: ${insight.relevantFiles.join(", ")}`);
      }
      if (insight.patterns.length > 0) {
        lines.push(`  ${insight.patterns.join("; ")}`);
      }
    }

    return lines.join("\n");
  }

  /** Get raw insights data */
  getInsights(): RunInsights {
    return {
      insights: [...this.insights],
      issuesProcessed: this.insights.length,
    };
  }

  /** Get count of collected insights */
  get count(): number {
    return this.insights.length;
  }
}

import type { CodebaseContext, MemoryConfig, RunInsights } from "./types.js";
import type { SolveResult } from "../engine/types.js";
import { getCodebaseContext } from "./codebase-context.js";
import { InsightCollector } from "./issue-insights.js";
import { log } from "../utils/logger.js";
import { loadLessonsForPrompt } from "../commands/learn.js";

const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  enableCodebaseContext: true,
  enableCrossIssue: true,
  cacheMaxAgeMs: 60 * 60 * 1000, // 1 hour
  maxInsights: 20,
  stateDir: ".dispatch",
};

/**
 * MemoryManager — manages Tier 1 (codebase context) and Tier 2 (cross-issue insights).
 *
 * Usage:
 *   const memory = new MemoryManager(config);
 *   await memory.initialize(cwd);  // loads/generates codebase context
 *   memory.addInsight(issueNum, result, classification);  // after each solve
 *   const context = memory.getContextForIssue(issue);  // before each solve
 */
export class MemoryManager {
  private config: MemoryConfig;
  private codebaseContext: CodebaseContext | null = null;
  private insightCollector: InsightCollector;
  private lessonsPrompt: string = "";
  private initialized = false;

  constructor(config: Partial<MemoryConfig> = {}) {
    this.config = { ...DEFAULT_MEMORY_CONFIG, ...config };
    this.insightCollector = new InsightCollector(this.config.maxInsights);
  }

  /** Initialize memory — load or generate codebase context */
  async initialize(cwd: string): Promise<void> {
    if (this.config.enableCodebaseContext) {
      try {
        this.codebaseContext = await getCodebaseContext(
          cwd,
          this.config.stateDir,
          this.config.cacheMaxAgeMs,
        );
        log.debug(`[memory] Codebase context loaded (${this.codebaseContext.tokenEstimate} tokens)`);
      } catch (err) {
        log.warn(`[memory] Failed to generate codebase context: ${err}`);
      }
    }
    // Load lessons from previous runs (Tier 3 local)
    try {
      this.lessonsPrompt = await loadLessonsForPrompt(cwd, this.config.stateDir);
      if (this.lessonsPrompt) {
        log.debug(`[memory] Loaded lessons from previous PR reviews`);
      }
    } catch {
      // No lessons yet — that's fine
    }

    this.initialized = true;
  }

  /** Get the count of loaded lessons */
  get lessonsCount(): number {
    return this.lessonsPrompt ? this.lessonsPrompt.split("\n- ").length - 1 : 0;
  }

  /** Get formatted codebase context for prompt injection */
  getCodebaseContextPrompt(): string {
    if (!this.codebaseContext) return "";

    return [
      "## Codebase Context",
      "",
      this.codebaseContext.structure,
      "",
      `Dependencies: ${this.codebaseContext.dependencies.join(", ")}`,
    ].join("\n");
  }

  /** Get formatted cross-issue insights for prompt injection */
  getInsightsPrompt(): string {
    if (!this.config.enableCrossIssue) return "";
    return this.insightCollector.formatForPrompt();
  }

  /** Get lessons prompt */
  getLessonsPrompt(): string {
    return this.lessonsPrompt;
  }

  /** Get all memory context formatted for prompt injection */
  getFullContextPrompt(): string {
    const parts: string[] = [];

    const codebase = this.getCodebaseContextPrompt();
    if (codebase) parts.push(codebase);

    const insights = this.getInsightsPrompt();
    if (insights) parts.push(insights);

    if (this.lessonsPrompt) parts.push(this.lessonsPrompt);

    return parts.join("\n\n");
  }

  /** Add an insight after solving an issue */
  addInsight(
    issueNumber: number,
    result: SolveResult,
    classification: string,
  ): void {
    if (!this.config.enableCrossIssue) return;
    this.insightCollector.addFromSolve(issueNumber, result, classification);
  }

  /** Get the insight collector (for advanced usage) */
  getInsightCollector(): InsightCollector {
    return this.insightCollector;
  }

  /** Get the cached codebase context object */
  getCodebaseContext(): CodebaseContext | null {
    return this.codebaseContext;
  }

  /** Get run insights */
  getRunInsights(): RunInsights {
    return this.insightCollector.getInsights();
  }

  /** Check if initialized */
  get isInitialized(): boolean {
    return this.initialized;
  }
}

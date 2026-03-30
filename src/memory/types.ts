/**
 * Memory system types for Dispatch v2.
 * Tier 1: Codebase context (cached analysis of repo structure)
 * Tier 2: Cross-issue insights (learned within a run)
 */

/** Cached codebase context — regenerated when stale */
export interface CodebaseContext {
  /** When this cache was generated */
  generatedAt: string;
  /** Git commit hash when generated */
  commitHash: string;
  /** Repository structure summary */
  structure: string;
  /** Key patterns detected (test framework, module system, etc.) */
  patterns: {
    testFramework: string | null;
    moduleSystem: string;
    buildTool: string | null;
    linter: string | null;
    language: string;
    packageManager: string;
  };
  /** Important files (entry points, configs, key modules) */
  keyFiles: string[];
  /** Dependencies summary */
  dependencies: string[];
  /** File tree (depth-limited) */
  fileTree: string;
  /** Approximate token count of this context */
  tokenEstimate: number;
}

/** An insight learned from solving one issue, available for subsequent issues */
export interface IssueInsight {
  /** Issue number that produced this insight */
  fromIssue: number;
  /** What was learned */
  insight: string;
  /** Files that were relevant */
  relevantFiles: string[];
  /** Patterns discovered */
  patterns: string[];
  /** Confidence in this insight (1-10) */
  confidence: number;
  /** Timestamp */
  timestamp: number;
}

/** Collection of insights from current run */
export interface RunInsights {
  insights: IssueInsight[];
  /** Total issues processed so far in this run */
  issuesProcessed: number;
}

/** Configuration for the memory manager */
export interface MemoryConfig {
  /** Enable Tier 1 codebase context caching */
  enableCodebaseContext: boolean;
  /** Enable Tier 2 cross-issue learning */
  enableCrossIssue: boolean;
  /** Max age for codebase context cache in ms (default: 1 hour) */
  cacheMaxAgeMs: number;
  /** Max number of insights to carry forward between batches */
  maxInsights: number;
  /** State directory for cache storage */
  stateDir: string;
}

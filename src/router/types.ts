/**
 * Model routing types for Dispatch v2.
 * The ModelRouter selects the optimal model per pipeline phase.
 */

/** Pipeline phases that need model selection */
export type PipelinePhase = "classify" | "solve" | "score" | "create-issue";

/** Supported AI providers */
export type AIProvider = "anthropic" | "gemini" | "github-models" | "openai";

/** A specific model with its metadata */
export interface ModelSpec {
  /** Provider identifier */
  provider: AIProvider;
  /** Model identifier (e.g., "claude-sonnet-4-20250514", "gemini-2.5-pro") */
  modelId: string;
  /** Human-friendly display name */
  displayName: string;
  /** Cost per 1M input tokens in USD */
  inputCostPer1M: number;
  /** Cost per 1M output tokens in USD */
  outputCostPer1M: number;
  /** Max context window in tokens */
  maxContextTokens: number;
  /** Recommended phases for this model */
  recommendedPhases: PipelinePhase[];
}

/** Routing strategy */
export type RoutingStrategy = "auto" | "provider-locked" | "pinned";

/** ModelRouter configuration */
export interface RouterConfig {
  /** Routing strategy */
  strategy: RoutingStrategy;
  /** When strategy is "provider-locked", which provider to use */
  preferredProvider?: AIProvider;
  /** When strategy is "pinned", model ID to use for all phases */
  pinnedModel?: string;
  /** Override model for a specific phase */
  phaseOverrides?: Partial<Record<PipelinePhase, string>>;
}

/** Cost tracking for a single API call */
export interface CostEntry {
  phase: PipelinePhase;
  provider: AIProvider;
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUSD: number;
  timestamp: number;
}

/** Aggregated cost for a run */
export interface RunCostSummary {
  totalCostUSD: number;
  byPhase: Record<PipelinePhase, number>;
  byProvider: Record<string, number>;
  totalInputTokens: number;
  totalOutputTokens: number;
  entries: CostEntry[];
}

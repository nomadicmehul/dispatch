import type {
  AIProvider,
  CostEntry,
  ModelSpec,
  PipelinePhase,
  RouterConfig,
  RunCostSummary,
} from "./types.js";
import { findModel, cheapestForPhase, strongestForPhase, MODEL_REGISTRY } from "./models.js";
import { log } from "../utils/logger.js";

export class ModelRouter {
  private config: RouterConfig;
  private costEntries: CostEntry[] = [];

  constructor(config: RouterConfig) {
    this.config = config;
  }

  /**
   * Get the model to use for a given pipeline phase.
   *
   * Strategy logic:
   * - "pinned": Use config.pinnedModel for everything
   * - "provider-locked": Use cheap model from preferred provider for classify/score,
   *   strong model for solve/create-issue
   * - "auto": Pick the best model per phase across all available providers
   *
   * Phase overrides always take precedence.
   */
  getModelForPhase(phase: PipelinePhase): ModelSpec {
    // Phase overrides always win
    if (this.config.phaseOverrides?.[phase]) {
      const override = findModel(this.config.phaseOverrides[phase]!);
      if (override) return override;
      log.warn(`Phase override model "${this.config.phaseOverrides[phase]}" not found in registry, falling back`);
    }

    switch (this.config.strategy) {
      case "pinned": {
        if (this.config.pinnedModel) {
          const model = findModel(this.config.pinnedModel);
          if (model) return model;
          log.warn(`Pinned model "${this.config.pinnedModel}" not found in registry`);
        }
        // Fall through to auto
        return this.autoSelectModel(phase);
      }

      case "provider-locked": {
        const provider = this.config.preferredProvider;
        if (!provider) {
          log.warn("provider-locked strategy but no preferredProvider set, falling back to auto");
          return this.autoSelectModel(phase);
        }

        // Use cheap model for lightweight phases, strong for heavy phases
        if (phase === "classify" || phase === "score") {
          const cheap = cheapestForPhase(phase, provider);
          if (cheap) return cheap;
        }
        const strong = strongestForPhase(phase, provider);
        if (strong) return strong;

        // Fallback: any model from that provider
        const fallback = MODEL_REGISTRY.find((m) => m.provider === provider);
        if (fallback) return fallback;

        log.warn(`No models found for provider "${provider}", falling back to auto`);
        return this.autoSelectModel(phase);
      }

      case "auto":
      default:
        return this.autoSelectModel(phase);
    }
  }

  /** Auto-select: cheap for classify/score, strong for solve/create-issue */
  private autoSelectModel(phase: PipelinePhase): ModelSpec {
    if (phase === "classify" || phase === "score") {
      return cheapestForPhase(phase) || MODEL_REGISTRY[0];
    }
    return strongestForPhase(phase) || MODEL_REGISTRY[0];
  }

  /** Record a cost entry after an API call */
  recordCost(entry: Omit<CostEntry, "timestamp">): void {
    this.costEntries.push({ ...entry, timestamp: Date.now() });
  }

  /** Estimate cost given token counts and a model spec */
  estimateCost(model: ModelSpec, inputTokens: number, outputTokens: number): number {
    return (
      (inputTokens / 1_000_000) * model.inputCostPer1M +
      (outputTokens / 1_000_000) * model.outputCostPer1M
    );
  }

  /** Get the full run cost summary */
  getCostSummary(): RunCostSummary {
    const byPhase: Record<string, number> = {};
    const byProvider: Record<string, number> = {};
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    for (const entry of this.costEntries) {
      byPhase[entry.phase] = (byPhase[entry.phase] || 0) + entry.estimatedCostUSD;
      byProvider[entry.provider] = (byProvider[entry.provider] || 0) + entry.estimatedCostUSD;
      totalInputTokens += entry.inputTokens;
      totalOutputTokens += entry.outputTokens;
    }

    return {
      totalCostUSD: this.costEntries.reduce((sum, e) => sum + e.estimatedCostUSD, 0),
      byPhase: byPhase as Record<PipelinePhase, number>,
      byProvider,
      totalInputTokens,
      totalOutputTokens,
      entries: [...this.costEntries],
    };
  }

  /** Reset cost tracking (between runs) */
  resetCosts(): void {
    this.costEntries = [];
  }
}

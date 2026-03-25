import type { ModelSpec } from "./types.js";

/**
 * Registry of known models with pricing and capabilities.
 * Prices are approximate and should be updated periodically.
 */
export const MODEL_REGISTRY: ModelSpec[] = [
  // Anthropic
  {
    provider: "anthropic",
    modelId: "claude-sonnet-4-20250514",
    displayName: "Claude Sonnet 4",
    inputCostPer1M: 3,
    outputCostPer1M: 15,
    maxContextTokens: 200_000,
    recommendedPhases: ["solve", "create-issue"],
  },
  {
    provider: "anthropic",
    modelId: "claude-haiku-3-5-20241022",
    displayName: "Claude Haiku 3.5",
    inputCostPer1M: 0.8,
    outputCostPer1M: 4,
    maxContextTokens: 200_000,
    recommendedPhases: ["classify", "score"],
  },
  // Gemini
  {
    provider: "gemini",
    modelId: "gemini-2.5-pro",
    displayName: "Gemini 2.5 Pro",
    inputCostPer1M: 1.25,
    outputCostPer1M: 10,
    maxContextTokens: 1_000_000,
    recommendedPhases: ["solve", "create-issue"],
  },
  {
    provider: "gemini",
    modelId: "gemini-2.5-flash",
    displayName: "Gemini 2.5 Flash",
    inputCostPer1M: 0.15,
    outputCostPer1M: 0.60,
    maxContextTokens: 1_000_000,
    recommendedPhases: ["classify", "score"],
  },
  // GitHub Models (free tier — costs are $0 for rate-limited access)
  {
    provider: "github-models",
    modelId: "openai/gpt-4.1",
    displayName: "GPT-4.1 (GitHub Models)",
    inputCostPer1M: 0,
    outputCostPer1M: 0,
    maxContextTokens: 128_000,
    recommendedPhases: ["classify", "solve", "score", "create-issue"],
  },
  {
    provider: "github-models",
    modelId: "openai/gpt-4.1-mini",
    displayName: "GPT-4.1 Mini (GitHub Models)",
    inputCostPer1M: 0,
    outputCostPer1M: 0,
    maxContextTokens: 128_000,
    recommendedPhases: ["classify", "score"],
  },
];

/** Find a model spec by ID (exact match) */
export function findModel(modelId: string): ModelSpec | undefined {
  return MODEL_REGISTRY.find((m) => m.modelId === modelId);
}

/** Find all models for a provider */
export function modelsForProvider(provider: string): ModelSpec[] {
  return MODEL_REGISTRY.filter((m) => m.provider === provider);
}

/** Find the cheapest model recommended for a phase from a provider */
export function cheapestForPhase(phase: string, provider?: string): ModelSpec | undefined {
  let candidates = MODEL_REGISTRY.filter((m) =>
    m.recommendedPhases.includes(phase as any)
  );
  if (provider) {
    candidates = candidates.filter((m) => m.provider === provider);
  }
  if (candidates.length === 0) return undefined;
  return candidates.sort((a, b) => a.inputCostPer1M - b.inputCostPer1M)[0];
}

/** Find the strongest model recommended for a phase from a provider */
export function strongestForPhase(phase: string, provider?: string): ModelSpec | undefined {
  let candidates = MODEL_REGISTRY.filter((m) =>
    m.recommendedPhases.includes(phase as any)
  );
  if (provider) {
    candidates = candidates.filter((m) => m.provider === provider);
  }
  if (candidates.length === 0) return undefined;
  // Higher cost = generally stronger
  return candidates.sort((a, b) => b.inputCostPer1M - a.inputCostPer1M)[0];
}

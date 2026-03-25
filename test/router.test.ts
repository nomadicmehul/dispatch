import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ModelRouter } from "../src/router/router.js";
import { findModel, cheapestForPhase, strongestForPhase, MODEL_REGISTRY } from "../src/router/models.js";
import type { RouterConfig } from "../src/router/types.js";

describe("ModelRouter", () => {
  describe("pinned strategy", () => {
    it("returns the pinned model for all phases", () => {
      const router = new ModelRouter({
        strategy: "pinned",
        pinnedModel: "gemini-2.5-pro",
      });

      const classify = router.getModelForPhase("classify");
      const solve = router.getModelForPhase("solve");
      assert.equal(classify.modelId, "gemini-2.5-pro");
      assert.equal(solve.modelId, "gemini-2.5-pro");
    });

    it("falls back to auto if pinned model not found", () => {
      const router = new ModelRouter({
        strategy: "pinned",
        pinnedModel: "nonexistent-model",
      });

      const model = router.getModelForPhase("solve");
      assert.ok(model.modelId); // Should get some model
    });
  });

  describe("provider-locked strategy", () => {
    it("uses cheap model for classify, strong for solve", () => {
      const router = new ModelRouter({
        strategy: "provider-locked",
        preferredProvider: "gemini",
      });

      const classify = router.getModelForPhase("classify");
      const solve = router.getModelForPhase("solve");

      assert.equal(classify.provider, "gemini");
      assert.equal(solve.provider, "gemini");
      // Classify should use cheaper model
      assert.ok(classify.inputCostPer1M <= solve.inputCostPer1M);
    });
  });

  describe("auto strategy", () => {
    it("selects cheap models for classify/score", () => {
      const router = new ModelRouter({ strategy: "auto" });

      const classify = router.getModelForPhase("classify");
      const solve = router.getModelForPhase("solve");

      // Classify model should be cheaper than solve model
      assert.ok(classify.inputCostPer1M <= solve.inputCostPer1M);
    });
  });

  describe("phase overrides", () => {
    it("overrides take precedence over strategy", () => {
      const router = new ModelRouter({
        strategy: "pinned",
        pinnedModel: "gemini-2.5-pro",
        phaseOverrides: {
          classify: "gemini-2.5-flash",
        },
      });

      const classify = router.getModelForPhase("classify");
      assert.equal(classify.modelId, "gemini-2.5-flash");

      // Non-overridden phase uses pinned
      const solve = router.getModelForPhase("solve");
      assert.equal(solve.modelId, "gemini-2.5-pro");
    });
  });

  describe("cost tracking", () => {
    it("records and summarizes costs", () => {
      const router = new ModelRouter({ strategy: "auto" });

      router.recordCost({
        phase: "classify",
        provider: "gemini",
        model: "gemini-2.5-flash",
        inputTokens: 1000,
        outputTokens: 50,
        estimatedCostUSD: 0.001,
      });

      router.recordCost({
        phase: "solve",
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        inputTokens: 50000,
        outputTokens: 5000,
        estimatedCostUSD: 0.225,
      });

      const summary = router.getCostSummary();
      assert.ok(summary.totalCostUSD > 0);
      assert.equal(summary.entries.length, 2);
      assert.equal(summary.totalInputTokens, 51000);
    });
  });
});

describe("Model Registry", () => {
  it("has models for all providers", () => {
    const providers = new Set(MODEL_REGISTRY.map((m) => m.provider));
    assert.ok(providers.has("anthropic"));
    assert.ok(providers.has("gemini"));
    assert.ok(providers.has("github-models"));
  });

  it("findModel returns correct model", () => {
    const model = findModel("gemini-2.5-pro");
    assert.ok(model);
    assert.equal(model.provider, "gemini");
  });

  it("cheapestForPhase returns cheapest", () => {
    const model = cheapestForPhase("classify");
    assert.ok(model);
    // Should be one of the cheaper models
    assert.ok(model.inputCostPer1M <= 1);
  });
});

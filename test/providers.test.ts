import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getDetectedProvidersSummary } from "../src/router/detect.js";
import { MODEL_REGISTRY, findModel, modelsForProvider } from "../src/router/models.js";

describe("Provider Detection", () => {
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Save and clear all provider keys
    for (const key of ["ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "GITHUB_TOKEN", "OPENAI_API_KEY"]) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    // Restore env
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("detects no providers when no keys are set", () => {
    const providers = getDetectedProvidersSummary();
    assert.ok(providers.every((p) => !p.available));
  });

  it("detects Anthropic when ANTHROPIC_API_KEY is set", () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const providers = getDetectedProvidersSummary();
    const anthropic = providers.find((p) => p.provider === "anthropic");
    assert.ok(anthropic?.available);
  });

  it("detects Gemini when GEMINI_API_KEY is set", () => {
    process.env.GEMINI_API_KEY = "test-key";
    const providers = getDetectedProvidersSummary();
    const gemini = providers.find((p) => p.provider === "gemini");
    assert.ok(gemini?.available);
  });

  it("detects Gemini when GOOGLE_API_KEY is set", () => {
    process.env.GOOGLE_API_KEY = "test-key";
    const providers = getDetectedProvidersSummary();
    const gemini = providers.find((p) => p.provider === "gemini");
    assert.ok(gemini?.available);
  });

  it("detects GitHub Models when GITHUB_TOKEN is set", () => {
    process.env.GITHUB_TOKEN = "test-token";
    const providers = getDetectedProvidersSummary();
    const gh = providers.find((p) => p.provider === "github-models");
    assert.ok(gh?.available);
  });

  it("detects OpenAI when OPENAI_API_KEY is set", () => {
    process.env.OPENAI_API_KEY = "test-key";
    const providers = getDetectedProvidersSummary();
    const openai = providers.find((p) => p.provider === "openai");
    assert.ok(openai?.available);
  });

  it("detects multiple providers simultaneously", () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.OPENAI_API_KEY = "test-key";
    const providers = getDetectedProvidersSummary();
    const available = providers.filter((p) => p.available);
    assert.ok(available.length >= 2);
  });
});

describe("Model Registry — OpenAI models", () => {
  it("includes OpenAI provider models", () => {
    const openaiModels = modelsForProvider("openai");
    assert.ok(openaiModels.length >= 2, "Should have at least 2 OpenAI models");
  });

  it("findModel returns gpt-4.1", () => {
    const model = findModel("gpt-4.1");
    assert.ok(model);
    assert.equal(model.provider, "openai");
  });

  it("findModel returns gpt-4.1-mini", () => {
    const model = findModel("gpt-4.1-mini");
    assert.ok(model);
    assert.equal(model.provider, "openai");
  });

  it("findModel returns o3-mini", () => {
    const model = findModel("o3-mini");
    assert.ok(model);
    assert.equal(model.provider, "openai");
  });

  it("all models have valid cost data", () => {
    for (const model of MODEL_REGISTRY) {
      assert.ok(model.inputCostPer1M >= 0, `${model.modelId} has negative input cost`);
      assert.ok(model.outputCostPer1M >= 0, `${model.modelId} has negative output cost`);
      assert.ok(model.maxContextTokens > 0, `${model.modelId} has invalid context window`);
      assert.ok(model.recommendedPhases.length > 0, `${model.modelId} has no recommended phases`);
    }
  });

  it("every provider has at least one model recommended for solve", () => {
    const providers = new Set(MODEL_REGISTRY.map((m) => m.provider));
    for (const provider of providers) {
      const solveModels = MODEL_REGISTRY.filter(
        (m) => m.provider === provider && m.recommendedPhases.includes("solve")
      );
      assert.ok(solveModels.length > 0, `Provider "${provider}" has no solve-capable models`);
    }
  });
});

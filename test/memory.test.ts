import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InsightCollector } from "../src/memory/issue-insights.js";
import { ContextBudgetManager } from "../src/memory/budget.js";
import type { SolveResult } from "../src/engine/types.js";

describe("InsightCollector", () => {
  it("collects insights from solved issues", () => {
    const collector = new InsightCollector(10);

    const result: SolveResult = {
      success: true,
      changedFiles: ["src/foo.ts", "src/bar.ts"],
      summary: "Fixed the null check",
      confidence: 8,
      uncertainties: [],
      commitMessage: "fix: null check",
    };

    collector.addFromSolve(42, result, "code-fix");
    assert.equal(collector.count, 1);

    const formatted = collector.formatForPrompt();
    assert.ok(formatted.includes("Issue #42"));
    assert.ok(formatted.includes("Fixed the null check"));
  });

  it("limits insights to maxInsights", () => {
    const collector = new InsightCollector(3);

    for (let i = 0; i < 5; i++) {
      collector.addFromSolve(i, {
        success: true,
        changedFiles: [`file${i}.ts`],
        summary: `Fixed issue ${i}`,
        confidence: i + 1,
        uncertainties: [],
        commitMessage: `fix: issue ${i}`,
      }, "code-fix");
    }

    assert.equal(collector.count, 3);

    // Should keep highest confidence
    const insights = collector.getInsights();
    const confidences = insights.insights.map((i) => i.confidence);
    assert.ok(confidences.every((c) => c >= 3));
  });

  it("returns empty string when no insights", () => {
    const collector = new InsightCollector(10);
    assert.equal(collector.formatForPrompt(), "");
  });
});

describe("ContextBudgetManager", () => {
  const mockModel = {
    provider: "anthropic" as const,
    modelId: "test",
    displayName: "Test",
    inputCostPer1M: 3,
    outputCostPer1M: 15,
    maxContextTokens: 1000,  // Small for testing
    recommendedPhases: ["solve" as const],
  };

  it("tracks available tokens", () => {
    const budget = new ContextBudgetManager(mockModel, 0.25);
    assert.equal(budget.availableTokens, 750); // 1000 - 25%
  });

  it("adds sections and tracks usage", () => {
    const budget = new ContextBudgetManager(mockModel, 0.25);
    budget.addSection("system", "You are a helpful assistant.", "critical");
    assert.ok(budget.usedTokens > 0);
    assert.ok(budget.remainingTokens < budget.availableTokens);
  });

  it("respects priority ordering in build output", () => {
    const budget = new ContextBudgetManager(mockModel, 0.25);
    budget.addSection("low", "low priority content", "low");
    budget.addSection("critical", "critical content", "critical");

    const output = budget.build();
    // Critical should appear before low
    const criticalIdx = output.indexOf("critical content");
    const lowIdx = output.indexOf("low priority content");
    assert.ok(criticalIdx < lowIdx);
  });

  it("truncates low-priority content when over budget", () => {
    const budget = new ContextBudgetManager(mockModel, 0.25);

    // Fill up most of the budget with critical content
    budget.addSection("critical", "x".repeat(2800), "critical"); // ~700 tokens
    budget.addSection("low", "y".repeat(400), "low"); // ~100 tokens, won't fully fit

    const output = budget.build();
    assert.ok(output.includes("x".repeat(100))); // Critical content preserved
  });
});

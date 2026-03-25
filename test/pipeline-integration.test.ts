import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MemoryManager } from "../src/memory/manager.js";
import { InsightCollector } from "../src/memory/issue-insights.js";

describe("Pipeline Integration", () => {
  describe("MemoryManager", () => {
    it("initializes without errors when no repo context", async () => {
      const memory = new MemoryManager({
        enableCodebaseContext: false,
        enableCrossIssue: true,
        cacheMaxAgeMs: 60000,
        maxInsights: 10,
        stateDir: ".dispatch",
      });

      await memory.initialize("/tmp/nonexistent");
      assert.ok(memory.isInitialized);
    });

    it("returns empty context when disabled", async () => {
      const memory = new MemoryManager({
        enableCodebaseContext: false,
        enableCrossIssue: false,
        cacheMaxAgeMs: 60000,
        maxInsights: 10,
        stateDir: ".dispatch",
      });

      await memory.initialize("/tmp/nonexistent");

      assert.equal(memory.getCodebaseContextPrompt(), "");
      assert.equal(memory.getInsightsPrompt(), "");
      assert.equal(memory.getFullContextPrompt(), "");
    });

    it("collects and surfaces insights", async () => {
      const memory = new MemoryManager({
        enableCodebaseContext: false,
        enableCrossIssue: true,
        cacheMaxAgeMs: 60000,
        maxInsights: 10,
        stateDir: ".dispatch",
      });

      await memory.initialize("/tmp/nonexistent");

      memory.addInsight(1, {
        success: true,
        changedFiles: ["src/a.ts"],
        summary: "Fixed bug in module A",
        confidence: 8,
        uncertainties: [],
        commitMessage: "fix: module A",
      }, "code-fix");

      const prompt = memory.getInsightsPrompt();
      assert.ok(prompt.includes("Fixed bug in module A"));
      assert.ok(prompt.includes("Issue #1"));
    });
  });

  describe("Batch Processing Logic", () => {
    it("creates correct batch sizes", () => {
      const items = [1, 2, 3, 4, 5, 6, 7];
      const batchSize = 3;
      const batches: number[][] = [];

      for (let i = 0; i < items.length; i += batchSize) {
        batches.push(items.slice(i, i + batchSize));
      }

      assert.equal(batches.length, 3);
      assert.deepEqual(batches[0], [1, 2, 3]);
      assert.deepEqual(batches[1], [4, 5, 6]);
      assert.deepEqual(batches[2], [7]);
    });
  });
});

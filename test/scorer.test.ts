import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { adjustConfidence, shouldBeDraft, confidenceLabel } from "../src/orchestrator/scorer.js";
import type { SolveResult } from "../src/engine/types.js";

function makeResult(overrides: Partial<SolveResult> = {}): SolveResult {
  return {
    success: true,
    changedFiles: ["file.ts"],
    summary: "Fixed the thing",
    confidence: 7,
    uncertainties: [],
    commitMessage: "fix: resolve issue",
    ...overrides,
  };
}

describe("adjustConfidence", () => {
  it("boosts confidence when files changed and no uncertainties", () => {
    const result = makeResult({ confidence: 7, changedFiles: ["a.ts"], uncertainties: [] });
    assert.equal(adjustConfidence(result).confidence, 8);
  });

  it("does not boost above 10", () => {
    const result = makeResult({ confidence: 10, changedFiles: ["a.ts"], uncertainties: [] });
    assert.equal(adjustConfidence(result).confidence, 10);
  });

  it("lowers confidence when many files changed", () => {
    const files = Array.from({ length: 11 }, (_, i) => `file${i}.ts`);
    const result = makeResult({ confidence: 7, changedFiles: files, uncertainties: ["x"] });
    assert.equal(adjustConfidence(result).confidence, 6);
  });

  it("caps confidence at 3 when no files changed but success claimed", () => {
    const result = makeResult({ confidence: 8, changedFiles: [], success: true });
    assert.equal(adjustConfidence(result).confidence, 3);
  });

  it("lowers confidence with many uncertainties", () => {
    const result = makeResult({
      confidence: 7,
      uncertainties: ["a", "b", "c"],
      changedFiles: ["x.ts"],
    });
    // boost from no-uncertainty doesn't apply, but many-uncertainties penalty does
    assert.equal(adjustConfidence(result).confidence, 6);
  });

  it("does not lower below 1", () => {
    const files = Array.from({ length: 11 }, (_, i) => `file${i}.ts`);
    const result = makeResult({
      confidence: 1,
      changedFiles: files,
      uncertainties: ["a", "b", "c"],
    });
    assert.equal(adjustConfidence(result).confidence, 1);
  });
});

describe("shouldBeDraft", () => {
  it("returns true when confidence is below threshold", () => {
    assert.equal(shouldBeDraft(3, 5), true);
  });

  it("returns false when confidence meets threshold", () => {
    assert.equal(shouldBeDraft(5, 5), false);
  });

  it("returns false when confidence exceeds threshold", () => {
    assert.equal(shouldBeDraft(8, 5), false);
  });
});

describe("confidenceLabel", () => {
  it("returns correct label for very high confidence", () => {
    assert.ok(confidenceLabel(9).includes("Very High"));
    assert.ok(confidenceLabel(10).includes("Very High"));
  });

  it("returns correct label for high confidence", () => {
    assert.ok(confidenceLabel(7).includes("High"));
    assert.ok(confidenceLabel(8).includes("High"));
  });

  it("returns correct label for medium confidence", () => {
    assert.ok(confidenceLabel(5).includes("Medium"));
    assert.ok(confidenceLabel(6).includes("Medium"));
  });

  it("returns correct label for low confidence", () => {
    assert.ok(confidenceLabel(3).includes("Low"));
    assert.ok(confidenceLabel(4).includes("Low"));
  });

  it("returns correct label for very low confidence", () => {
    assert.ok(confidenceLabel(1).includes("Very Low"));
    assert.ok(confidenceLabel(2).includes("Very Low"));
  });
});

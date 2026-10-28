import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assessResult, isTestPath, shouldBeDraft, confidenceLabel, type Evidence } from "../src/orchestrator/scorer.js";
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

function makeEvidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    verify: "passed",
    verifyCommand: "npm test",
    diff: { files: ["src/parser.ts", "test/parser.test.ts"], additions: 20, deletions: 4 },
    classification: "code-fix",
    ...overrides,
  };
}

const options = { draftThreshold: 5, maxDiffLines: 400 };

describe("assessResult", () => {
  it("boosts confidence when verification passes and tests changed", () => {
    const a = assessResult(makeResult({ confidence: 7 }), makeEvidence(), options);
    assert.equal(a.selfConfidence, 7);
    assert.equal(a.confidence, 9);
    assert.equal(a.lane, "ready");
  });

  it("caps confidence at 3 and drafts when verification fails", () => {
    const a = assessResult(makeResult({ confidence: 9 }), makeEvidence({ verify: "failed" }), options);
    assert.ok(a.confidence <= 4);
    assert.equal(a.lane, "draft");
    assert.ok(a.signals.some((s) => s.ok === false && s.label.includes("npm test")));
  });

  it("lowers confidence for untested code changes", () => {
    const a = assessResult(
      makeResult({ confidence: 7 }),
      makeEvidence({ verify: "skipped", verifyCommand: undefined, diff: { files: ["src/a.ts"], additions: 5, deletions: 1 } }),
      options,
    );
    assert.equal(a.confidence, 6);
    assert.equal(a.lane, "review");
  });

  it("does not penalize docs work without a verify command", () => {
    const a = assessResult(
      makeResult({ confidence: 7 }),
      makeEvidence({ verify: "skipped", classification: "documentation", diff: { files: ["README.md"], additions: 30, deletions: 2 } }),
      options,
    );
    assert.equal(a.confidence, 7);
  });

  it("drafts large diffs", () => {
    const a = assessResult(
      makeResult({ confidence: 9 }),
      makeEvidence({ diff: { files: ["src/a.ts"], additions: 500, deletions: 100 } }),
      options,
    );
    assert.equal(a.lane, "draft");
    assert.ok(a.signals.some((s) => s.label.startsWith("Large diff")));
  });

  it("keeps uncertain work out of the ready lane", () => {
    const a = assessResult(makeResult({ confidence: 9, uncertainties: ["edge case"] }), makeEvidence(), options);
    assert.equal(a.lane, "review");
  });

  it("lowers confidence with many uncertainties", () => {
    const a = assessResult(makeResult({ confidence: 7, uncertainties: ["a", "b", "c"] }), makeEvidence(), options);
    assert.equal(a.confidence, 8);
  });

  it("caps confidence at 3 when nothing changed", () => {
    const a = assessResult(makeResult({ confidence: 9 }), makeEvidence({ diff: { files: [], additions: 0, deletions: 0 } }), options);
    assert.equal(a.confidence, 3);
  });

  it("stays within 1-10", () => {
    const high = assessResult(makeResult({ confidence: 10 }), makeEvidence(), options);
    const low = assessResult(makeResult({ confidence: 1 }), makeEvidence({ verify: "failed", diff: { files: ["a.ts"], additions: 900, deletions: 0 } }), options);
    assert.equal(high.confidence, 10);
    assert.equal(low.confidence, 1);
  });

  it("respects the draft threshold", () => {
    const a = assessResult(makeResult({ confidence: 6 }), makeEvidence({ verify: "skipped", diff: { files: ["a.ts"], additions: 1, deletions: 1 } }), { ...options, draftThreshold: 7 });
    assert.equal(a.lane, "draft");
  });
});

describe("isTestPath", () => {
  it("recognizes common test file layouts", () => {
    for (const path of ["test/a.ts", "src/__tests__/a.ts", "a.test.ts", "b.spec.js", "pkg/a_test.go", "tests/test_api.py"]) {
      assert.ok(isTestPath(path), path);
    }
  });

  it("does not flag source files", () => {
    for (const path of ["src/testing-utils.ts", "src/contest.ts", "latest.md"]) {
      assert.ok(!isTestPath(path), path);
    }
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
  it("labels very high confidence", () => {
    assert.ok(confidenceLabel(9).startsWith("Very High"));
  });

  it("labels very low confidence", () => {
    assert.ok(confidenceLabel(1).startsWith("Very Low"));
  });
});

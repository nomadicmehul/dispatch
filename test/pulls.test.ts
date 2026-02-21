import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPRBody } from "../src/github/pulls.js";
import type { Issue, SolveResult } from "../src/engine/types.js";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    number: 42,
    title: "Fix the parser bug",
    body: "Parser crashes on empty input",
    labels: ["bug"],
    comments: [],
    author: "user",
    url: "https://github.com/test/test/issues/42",
    createdAt: "2024-01-01T00:00:00Z",
    reactions: 5,
    classification: "code-fix",
    ...overrides,
  };
}

function makeResult(overrides: Partial<SolveResult> = {}): SolveResult {
  return {
    success: true,
    changedFiles: ["src/parser.ts"],
    summary: "Added null check for empty input.",
    confidence: 8,
    uncertainties: [],
    commitMessage: "fix: handle empty input in parser",
    ...overrides,
  };
}

describe("buildPRBody", () => {
  it("includes issue number and title", () => {
    const body = buildPRBody(makeIssue(), makeResult(), "");
    assert.ok(body.includes("#42"));
    assert.ok(body.includes("Fix the parser bug"));
  });

  it("includes confidence score", () => {
    const body = buildPRBody(makeIssue(), makeResult({ confidence: 8 }), "");
    assert.ok(body.includes("8/10"));
  });

  it("shows green emoji for high confidence", () => {
    const body = buildPRBody(makeIssue(), makeResult({ confidence: 9 }), "");
    assert.ok(body.includes("\u{1F7E2}")); // green circle emoji
  });

  it("shows yellow emoji for medium confidence", () => {
    const body = buildPRBody(makeIssue(), makeResult({ confidence: 6 }), "");
    assert.ok(body.includes("\u{1F7E1}")); // yellow circle emoji
  });

  it("shows red emoji for low confidence", () => {
    const body = buildPRBody(makeIssue(), makeResult({ confidence: 3 }), "");
    assert.ok(body.includes("\u{1F534}")); // red circle emoji
  });

  it("includes uncertainties when present", () => {
    const result = makeResult({ uncertainties: ["edge case not tested"] });
    const body = buildPRBody(makeIssue(), result, "");
    assert.ok(body.includes("edge case not tested"));
    assert.ok(body.includes("Uncertainty"));
  });

  it("includes changed files", () => {
    const result = makeResult({ changedFiles: ["src/parser.ts", "test/parser.test.ts"] });
    const body = buildPRBody(makeIssue(), result, "");
    assert.ok(body.includes("src/parser.ts"));
    assert.ok(body.includes("test/parser.test.ts"));
  });

  it("includes diff summary when provided", () => {
    const diff = " 2 files changed, 10 insertions(+), 3 deletions(-)";
    const body = buildPRBody(makeIssue(), makeResult(), diff);
    assert.ok(body.includes("10 insertions"));
  });

  it("includes Closes directive", () => {
    const body = buildPRBody(makeIssue(), makeResult(), "");
    assert.ok(body.includes("Closes #42"));
  });

  it("includes classification type", () => {
    const body = buildPRBody(makeIssue({ classification: "feature" }), makeResult(), "");
    assert.ok(body.includes("feature"));
  });
});

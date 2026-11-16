import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { heuristicClassify } from "../src/orchestrator/classifier.js";
import type { Issue } from "../src/engine/types.js";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    number: 1,
    title: "Test issue",
    body: "",
    labels: [],
    comments: [],
    author: "user",
    url: "https://github.com/test/test/issues/1",
    createdAt: "2024-01-01T00:00:00Z",
    reactions: 0,
    ...overrides,
  };
}

describe("heuristicClassify", () => {
  it("classifies bug label as code-fix", () => {
    const issue = makeIssue({ labels: ["bug"] });
    assert.equal(heuristicClassify(issue), "code-fix");
  });

  it("classifies enhancement label as feature", () => {
    const issue = makeIssue({ labels: ["enhancement"] });
    assert.equal(heuristicClassify(issue), "feature");
  });

  it("classifies documentation label as documentation", () => {
    const issue = makeIssue({ labels: ["documentation"] });
    assert.equal(heuristicClassify(issue), "documentation");
  });

  it("classifies security label as audit", () => {
    const issue = makeIssue({ labels: ["security"] });
    assert.equal(heuristicClassify(issue), "audit");
  });

  it("classifies refactor label as refactor", () => {
    const issue = makeIssue({ labels: ["refactor"] });
    assert.equal(heuristicClassify(issue), "refactor");
  });

  it("classifies investigation label as investigation", () => {
    const issue = makeIssue({ labels: ["investigation"] });
    assert.equal(heuristicClassify(issue), "investigation");
  });

  it("falls back to keyword matching for title with 'bug'", () => {
    const issue = makeIssue({ title: "There is a bug in the parser" });
    assert.equal(heuristicClassify(issue), "code-fix");
  });

  it("falls back to keyword matching for 'investigate'", () => {
    const issue = makeIssue({ title: "Investigate why builds are slow" });
    assert.equal(heuristicClassify(issue), "investigation");
  });

  it("falls back to keyword matching for 'add'", () => {
    const issue = makeIssue({ title: "Add dark mode support" });
    assert.equal(heuristicClassify(issue), "feature");
  });

  it("returns unknown for unclassifiable issues", () => {
    const issue = makeIssue({ title: "Something", body: "something else" });
    assert.equal(heuristicClassify(issue), "unknown");
  });

  it("label takes priority over keyword match", () => {
    const issue = makeIssue({ title: "Fix the documentation", labels: ["enhancement"] });
    assert.equal(heuristicClassify(issue), "feature");
  });
});

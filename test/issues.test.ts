import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { prioritizeIssues, slugifyTitle } from "../src/github/issues.js";
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

describe("prioritizeIssues", () => {
  it("sorts P0 before P1", () => {
    const issues = [
      makeIssue({ number: 1, labels: ["p1"] }),
      makeIssue({ number: 2, labels: ["p0"] }),
    ];
    const sorted = prioritizeIssues(issues);
    assert.equal(sorted[0].number, 2);
    assert.equal(sorted[1].number, 1);
  });

  it("sorts critical before high", () => {
    const issues = [
      makeIssue({ number: 1, labels: ["high"] }),
      makeIssue({ number: 2, labels: ["critical"] }),
    ];
    const sorted = prioritizeIssues(issues);
    assert.equal(sorted[0].number, 2);
  });

  it("sorts by reactions when same priority", () => {
    const issues = [
      makeIssue({ number: 1, labels: ["p2"], reactions: 3 }),
      makeIssue({ number: 2, labels: ["p2"], reactions: 10 }),
    ];
    const sorted = prioritizeIssues(issues);
    assert.equal(sorted[0].number, 2);
  });

  it("sorts by age when same priority and reactions", () => {
    const issues = [
      makeIssue({ number: 1, createdAt: "2024-06-01T00:00:00Z" }),
      makeIssue({ number: 2, createdAt: "2024-01-01T00:00:00Z" }),
    ];
    const sorted = prioritizeIssues(issues);
    assert.equal(sorted[0].number, 2); // older first
  });

  it("does not mutate original array", () => {
    const issues = [
      makeIssue({ number: 1, labels: ["p3"] }),
      makeIssue({ number: 2, labels: ["p0"] }),
    ];
    const sorted = prioritizeIssues(issues);
    assert.notEqual(sorted, issues);
    assert.equal(issues[0].number, 1); // original unchanged
  });
});

describe("slugifyTitle", () => {
  it("lowercases and removes special chars", () => {
    assert.equal(slugifyTitle("Fix: The Bug!"), "fix-the-bug");
  });

  it("replaces spaces with hyphens", () => {
    assert.equal(slugifyTitle("add dark mode"), "add-dark-mode");
  });

  it("collapses multiple hyphens", () => {
    assert.equal(slugifyTitle("fix --- the --- bug"), "fix-the-bug");
  });

  it("truncates to 40 characters", () => {
    const long = "a".repeat(50);
    assert.ok(slugifyTitle(long).length <= 40);
  });

  it("removes trailing hyphens", () => {
    assert.equal(slugifyTitle("fix the bug-"), "fix-the-bug");
  });

  it("handles empty string", () => {
    assert.equal(slugifyTitle(""), "");
  });
});

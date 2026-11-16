import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatMorningSummary, type RunSummary, type IssueSummary } from "../src/reporter/summary.js";

function makeSummary(issues: IssueSummary[]): RunSummary {
  return {
    startedAt: "2026-10-28T02:00:00.000Z",
    duration: 5 * 60 * 1000,
    issues,
    totalAttempted: issues.filter((i) => i.status !== "skipped").length,
    totalSolved: issues.filter((i) => i.status === "solved").length,
    totalFailed: issues.filter((i) => i.status === "failed").length,
    prsCreated: issues.filter((i) => i.prNumber).map((i) => ({ number: i.prNumber!, url: i.prUrl!, issueNumber: i.number })),
    totalCostUsd: 1.25,
  };
}

const solved = (number: number, lane: "ready" | "review" | "draft"): IssueSummary => ({
  number,
  title: `Issue ${number}`,
  classification: "code-fix",
  status: "solved",
  confidence: 8,
  prNumber: 100 + number,
  prUrl: `https://github.com/o/r/pull/${100 + number}`,
  lane,
  verify: "passed",
  verifyCommand: "npm test",
  costUsd: 0.5,
  diff: { files: 2, additions: 10, deletions: 3 },
});

describe("formatMorningSummary", () => {
  it("groups PRs into review lanes, most mergeable first", () => {
    const text = formatMorningSummary(makeSummary([solved(2, "draft"), solved(1, "ready"), solved(3, "review")]));
    const ready = text.indexOf("Ready to merge");
    const review = text.indexOf("Needs eyes");
    const drafts = text.indexOf("Drafts");
    assert.ok(ready > 0 && ready < review && review < drafts);
    assert.ok(text.includes("3 PRs (1 ready, 1 review, 1 draft)"));
    assert.ok(text.includes("8/10 · npm test ✓ · +10 −3 · $0.50"));
    assert.ok(text.includes("Cost: $1.25"));
  });

  it("groups skipped issues by reason and truncates long lists", () => {
    const skipped: IssueSummary[] = Array.from({ length: 7 }, (_, i) => ({
      number: i + 10,
      title: `Outside issue ${i}`,
      classification: "unknown",
      status: "skipped",
      skipReason: "untrusted-author",
      skipDetail: "author is NONE",
    }));
    const text = formatMorningSummary(makeSummary(skipped));
    assert.ok(text.includes("untrusted-author (7)"));
    assert.ok(text.includes("… and 2 more"));
  });

  it("points to dispatch explain when there are results", () => {
    assert.ok(formatMorningSummary(makeSummary([solved(1, "ready")])).includes("dispatch explain"));
  });
});

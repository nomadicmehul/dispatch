import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scoreReadiness } from "../src/orchestrator/readiness.js";
import { selectIssues, parseDispatchedIssueNumbers, isTrustedIssue } from "../src/orchestrator/selection.js";
import { isTrustedAssociation, candidateLimit } from "../src/github/issues.js";
import type { Issue } from "../src/engine/types.js";

const GOOD_BODY = `Calling parse("") in src/parser.ts throws instead of returning an empty list.

Steps to reproduce:
1. Run \`parse("")\`

Expected: []
Actual: TypeError: Cannot read properties of undefined`;

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    number: 1,
    title: "Parser crashes on empty input",
    body: GOOD_BODY,
    labels: [],
    comments: [],
    author: "maintainer",
    authorAssociation: "MEMBER",
    url: "https://github.com/test/test/issues/1",
    createdAt: "2024-01-01T00:00:00Z",
    reactions: 0,
    ...overrides,
  };
}

const defaults = {
  trustedAuthors: ["OWNER", "MEMBER", "COLLABORATOR"],
  readyLabel: "dispatch:ready",
  minReadiness: 3,
  maxIssues: 10,
  dispatched: new Set<number>(),
};

describe("scoreReadiness", () => {
  it("scores a well-described bug highly", () => {
    const r = scoreReadiness(makeIssue());
    assert.ok(r.score >= 7, `score ${r.score}`);
    assert.deepEqual(r.missing, []);
  });

  it("scores a vague one-liner low and says what is missing", () => {
    const r = scoreReadiness(makeIssue({ title: "Fix login", body: "" }));
    assert.equal(r.score, 0);
    assert.ok(r.missing.includes("a descriptive title"));
    assert.ok(r.missing.some((m) => m.includes("files")));
  });

  it("gives maintainer-labelled issues full readiness", () => {
    const r = scoreReadiness(makeIssue({ title: "x", body: "", labels: ["dispatch:ready"] }), { readyLabel: "dispatch:ready" });
    assert.equal(r.score, 10);
  });

  it("never exceeds 10", () => {
    const body = `${GOOD_BODY}\n\n${"More detail. ".repeat(40)}\n- [ ] add test\n- [x] repro`;
    assert.equal(scoreReadiness(makeIssue({ body })).score, 10);
  });
});

describe("trust", () => {
  it("trusts configured associations case-insensitively", () => {
    assert.ok(isTrustedAssociation("member", ["MEMBER"]));
    assert.ok(!isTrustedAssociation("CONTRIBUTOR", ["MEMBER"]));
    assert.ok(!isTrustedAssociation(undefined, ["MEMBER"]));
  });

  it("trusts everyone with *", () => {
    assert.ok(isTrustedAssociation("NONE", ["*"]));
  });

  it("trusts an outside issue once a maintainer adds the ready label", () => {
    const issue = makeIssue({ authorAssociation: "NONE", labels: ["dispatch:ready"] });
    assert.ok(isTrustedIssue(issue, defaults.trustedAuthors, defaults.readyLabel));
  });
});

describe("parseDispatchedIssueNumbers", () => {
  it("extracts issue numbers from Dispatch branches only", () => {
    const numbers = parseDispatchedIssueNumbers(
      ["dispatch/issue-42-fix-login", "dispatch/issue-7", "dispatch/issue-12x", "feature/issue-9-x", "dispatch/other"],
      "dispatch/",
    );
    assert.deepEqual([...numbers].sort((a, b) => a - b), [7, 42]);
  });
});

describe("selectIssues", () => {
  it("skips untrusted, already-dispatched, and vague issues with reasons", () => {
    const issues = [
      makeIssue({ number: 1 }),
      makeIssue({ number: 2, authorAssociation: "NONE" }),
      makeIssue({ number: 3 }),
      makeIssue({ number: 4, title: "Fix it", body: "broken" }),
    ];
    const { selected, skipped, readiness } = selectIssues(issues, { ...defaults, dispatched: new Set([3]) });

    assert.deepEqual(selected.map((i) => i.number), [1]);
    const reasons = Object.fromEntries(skipped.map((s) => [s.issue.number, s.reason]));
    assert.deepEqual(reasons, { 2: "untrusted-author", 3: "already-dispatched", 4: "not-ready" });
    assert.ok(readiness.get(1)!.score >= 7);
  });

  it("applies maxIssues after filtering, by priority", () => {
    const issues = [
      makeIssue({ number: 1, authorAssociation: "NONE" }),
      makeIssue({ number: 2, labels: ["p2"] }),
      makeIssue({ number: 3, labels: ["p0"] }),
      makeIssue({ number: 4 }),
    ];
    const { selected, skipped } = selectIssues(issues, { ...defaults, maxIssues: 2 });

    assert.deepEqual(selected.map((i) => i.number), [3, 2]);
    assert.deepEqual(skipped.filter((s) => s.reason === "over-limit").map((s) => s.issue.number), [4]);
  });
});

describe("candidateLimit", () => {
  it("looks at more issues than it will solve, within bounds", () => {
    assert.equal(candidateLimit(1), 50);
    assert.equal(candidateLimit(20), 100);
    assert.equal(candidateLimit(500), 300);
  });
});

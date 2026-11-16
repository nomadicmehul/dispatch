import type { Issue } from "../engine/types.js";
import { isTrustedAssociation, prioritizeIssues } from "../github/issues.js";
import { scoreReadiness, type Readiness } from "./readiness.js";

export type SkipReason =
  | "already-dispatched"
  | "untrusted-author"
  | "not-ready"
  | "over-limit"
  | "budget-exhausted";

export interface SkippedIssue {
  issue: Issue;
  reason: SkipReason;
  detail: string;
}

export interface SelectionOptions {
  /** GitHub author associations to trust; "*" trusts everyone */
  trustedAuthors: string[];
  readyLabel: string;
  minReadiness: number;
  maxIssues: number;
  /** Issue numbers that already have a Dispatch branch on origin */
  dispatched: Set<number>;
}

export interface Selection {
  selected: Issue[];
  skipped: SkippedIssue[];
  readiness: Map<number, Readiness>;
}

/**
 * An issue is trusted if its author is, or if a maintainer added the ready label
 * (only people with triage access can label issues).
 */
export function isTrustedIssue(issue: Issue, trustedAuthors: string[], readyLabel: string): boolean {
  return isTrustedAssociation(issue.authorAssociation, trustedAuthors) || issue.labels.includes(readyLabel);
}

/** Issue numbers from Dispatch branch names such as "dispatch/issue-42-fix-login" */
export function parseDispatchedIssueNumbers(branches: string[], branchPrefix: string): Set<number> {
  const numbers = new Set<number>();
  for (const branch of branches) {
    if (!branch.startsWith(branchPrefix)) continue;
    const match = branch.slice(branchPrefix.length).match(/^issue-(\d+)(?:-|$)/);
    if (match) numbers.add(Number(match[1]));
  }
  return numbers;
}

/**
 * Decide which issues to dispatch this run, and why the others were skipped.
 * Filters run before the maxIssues limit, so skipped issues don't use up slots.
 */
export function selectIssues(issues: Issue[], options: SelectionOptions): Selection {
  const skipped: SkippedIssue[] = [];
  const readiness = new Map<number, Readiness>();
  const eligible: Issue[] = [];

  for (const issue of issues) {
    if (options.dispatched.has(issue.number)) {
      skipped.push({ issue, reason: "already-dispatched", detail: "a Dispatch branch already exists (delete it to retry)" });
      continue;
    }

    if (!isTrustedIssue(issue, options.trustedAuthors, options.readyLabel)) {
      skipped.push({
        issue,
        reason: "untrusted-author",
        detail: `author is ${issue.authorAssociation || "unknown"}; add the "${options.readyLabel}" label to opt it in`,
      });
      continue;
    }

    const score = scoreReadiness(issue, { readyLabel: options.readyLabel });
    readiness.set(issue.number, score);
    if (score.score < options.minReadiness) {
      skipped.push({
        issue,
        reason: "not-ready",
        detail: `readiness ${score.score}/10; needs ${score.missing.join(", ")}`,
      });
      continue;
    }

    eligible.push(issue);
  }

  const prioritized = prioritizeIssues(eligible);
  const selected = prioritized.slice(0, options.maxIssues);
  for (const issue of prioritized.slice(options.maxIssues)) {
    skipped.push({ issue, reason: "over-limit", detail: `beyond maxIssues (${options.maxIssues})` });
  }

  return { selected, skipped, readiness };
}

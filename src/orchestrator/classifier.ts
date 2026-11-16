import type { Issue, IssueClassification } from "../engine/types.js";

/** Quick heuristic classification based on labels and keywords (fallback) */
export function heuristicClassify(issue: Issue): IssueClassification {
  const text = `${issue.title} ${issue.body}`.toLowerCase();
  const labels = issue.labels.map((l) => l.toLowerCase());

  // Check labels first
  if (labels.some((l) => ["bug", "fix", "error", "crash", "broken"].includes(l))) {
    return "code-fix";
  }
  if (labels.some((l) => ["enhancement", "feature", "feature-request"].includes(l))) {
    return "feature";
  }
  if (labels.some((l) => ["documentation", "docs"].includes(l))) {
    return "documentation";
  }
  if (labels.some((l) => ["investigation", "research", "question"].includes(l))) {
    return "investigation";
  }
  if (labels.some((l) => ["security", "audit", "accessibility", "a11y"].includes(l))) {
    return "audit";
  }
  if (labels.some((l) => ["refactor", "tech-debt", "cleanup"].includes(l))) {
    return "refactor";
  }

  // Check keywords in title/body
  if (text.match(/\b(figure out|investigate|research|why is|analyze|look into)\b/)) {
    return "investigation";
  }
  if (text.match(/\b(audit|review|check for|scan|assess)\b/)) {
    return "audit";
  }
  if (text.match(/\b(document|readme|docs|write up|explain)\b/)) {
    return "documentation";
  }
  if (text.match(/\b(bug|fix|broken|error|crash|doesn't work|not working)\b/)) {
    return "code-fix";
  }
  if (text.match(/\b(add|implement|create|new|feature|support)\b/)) {
    return "feature";
  }
  if (text.match(/\b(refactor|restructure|clean up|reorganize|simplify)\b/)) {
    return "refactor";
  }

  return "unknown";
}

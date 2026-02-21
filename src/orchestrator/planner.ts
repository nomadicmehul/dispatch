import type { Issue, IssueClassification } from "../engine/types.js";

/** Strategy hints for the AI engine based on issue type */
export interface SolveStrategy {
  classification: IssueClassification;
  /** Suggested approach steps */
  steps: string[];
  /** Tools the AI should prioritize */
  preferredTools: string[];
  /** Expected output type */
  expectedOutput: "code-changes" | "document" | "mixed";
}

export function planStrategy(issue: Issue): SolveStrategy {
  const classification = issue.classification || "unknown";

  switch (classification) {
    case "code-fix":
      return {
        classification,
        steps: [
          "Read the issue to understand the bug",
          "Find the relevant code files",
          "Reproduce or understand the bug",
          "Implement the fix",
          "Check for regressions",
          "Run tests if available",
        ],
        preferredTools: ["Read", "Edit", "Grep", "Glob", "Bash"],
        expectedOutput: "code-changes",
      };

    case "feature":
      return {
        classification,
        steps: [
          "Understand the feature request",
          "Explore the codebase architecture",
          "Plan the implementation",
          "Implement the feature",
          "Add tests if applicable",
          "Update docs if needed",
        ],
        preferredTools: ["Read", "Write", "Edit", "Grep", "Glob", "Bash"],
        expectedOutput: "code-changes",
      };

    case "investigation":
      return {
        classification,
        steps: [
          "Understand what needs investigating",
          "Explore the relevant codebase",
          "Gather evidence and data",
          "Analyze findings",
          "Write investigation report",
        ],
        preferredTools: ["Read", "Grep", "Glob", "Write", "Bash"],
        expectedOutput: "document",
      };

    case "documentation":
      return {
        classification,
        steps: [
          "Understand what needs documenting",
          "Read the relevant code",
          "Write clear documentation",
          "Add code examples if helpful",
        ],
        preferredTools: ["Read", "Write", "Glob", "Grep"],
        expectedOutput: "document",
      };

    case "audit":
      return {
        classification,
        steps: [
          "Understand audit scope and criteria",
          "Systematically review codebase",
          "Categorize findings by severity",
          "Write audit report with recommendations",
        ],
        preferredTools: ["Read", "Grep", "Glob", "Write", "Bash"],
        expectedOutput: "document",
      };

    case "refactor":
      return {
        classification,
        steps: [
          "Understand refactoring goals",
          "Map current code structure",
          "Plan incremental changes",
          "Execute refactoring",
          "Verify behavior preserved",
        ],
        preferredTools: ["Read", "Edit", "Grep", "Glob", "Bash"],
        expectedOutput: "code-changes",
      };

    default:
      return {
        classification: "unknown",
        steps: [
          "Read the issue carefully",
          "Explore relevant code",
          "Take the most appropriate action",
        ],
        preferredTools: ["Read", "Edit", "Write", "Grep", "Glob", "Bash"],
        expectedOutput: "mixed",
      };
  }
}

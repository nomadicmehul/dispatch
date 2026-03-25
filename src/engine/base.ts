import type { Issue, IssueClassification } from "./types.js";

/** Build a rich context prompt from an issue, its comments, and optional memory context */
export function buildIssuePrompt(
  issue: Issue,
  options?: { codebaseContext?: string; crossIssueInsights?: string },
): string {
  let prompt = `# GitHub Issue #${issue.number}: ${issue.title}\n\n`;

  if (issue.labels.length > 0) {
    prompt += `**Labels:** ${issue.labels.join(", ")}\n`;
  }
  prompt += `**Author:** ${issue.author}\n`;
  prompt += `**Created:** ${issue.createdAt}\n\n`;

  // Inject codebase context (Tier 1 memory)
  if (options?.codebaseContext) {
    prompt += `${options.codebaseContext}\n\n`;
  }

  // Inject cross-issue insights (Tier 2 memory)
  if (options?.crossIssueInsights) {
    prompt += `${options.crossIssueInsights}\n\n`;
  }

  if (issue.body) {
    prompt += `## Description\n\n${issue.body}\n\n`;
  }

  if (issue.comments.length > 0) {
    prompt += `## Discussion (${issue.comments.length} comments)\n\n`;
    for (const comment of issue.comments) {
      prompt += `**${comment.author}** (${comment.createdAt}):\n${comment.body}\n\n---\n\n`;
    }
  }

  return prompt;
}

/** System prompts tailored to each issue type */
export const SYSTEM_PROMPTS: Record<IssueClassification, string> = {
  "code-fix": `You are solving a GitHub issue that requires code changes.

Your job:
1. Read the issue carefully, understand what needs to be fixed
2. Explore the codebase to understand the relevant code
3. Make the minimal, targeted changes needed to fix the issue
4. If the project has tests, add or update tests for your changes
5. Ensure your changes don't break existing functionality

Guidelines:
- Make small, focused changes — don't refactor unrelated code
- Follow the existing code style and patterns in the project
- If you're unsure about something, document it clearly
- Commit your changes with a clear, descriptive message`,

  feature: `You are implementing a new feature based on a GitHub issue.

Your job:
1. Read the feature request carefully
2. Explore the codebase to understand architecture and patterns
3. Implement the feature following existing patterns
4. Add tests if the project has a test suite
5. Update any relevant documentation

Guidelines:
- Follow existing architectural patterns
- Keep the implementation minimal and focused on the request
- If the feature is ambiguous, implement the most reasonable interpretation
- Document any assumptions you made`,

  investigation: `You are investigating a technical question from a GitHub issue.

Your job:
1. Read the question/investigation request carefully
2. Research the codebase thoroughly to find relevant information
3. Create a detailed findings document (markdown file)
4. Include evidence, code references, and data to support your findings
5. Provide actionable recommendations

Guidelines:
- Be thorough — check logs, configs, code paths, dependencies
- Use concrete evidence (file paths, line numbers, metrics)
- Structure your report with clear sections
- End with specific, actionable recommendations
- Save your report as a markdown file in the repo (e.g., docs/investigations/issue-NNN.md)`,

  documentation: `You are creating or updating documentation based on a GitHub issue.

Your job:
1. Read what documentation is needed
2. Explore the relevant code to understand what to document
3. Write clear, accurate documentation
4. Follow the project's existing documentation style

Guidelines:
- Write for the intended audience (developers, users, operators)
- Include code examples where helpful
- Keep it concise but complete
- Follow existing doc structure and formatting`,

  audit: `You are performing a codebase audit based on a GitHub issue.

Your job:
1. Understand what aspects need auditing (security, accessibility, performance, etc.)
2. Systematically review the relevant parts of the codebase
3. Create a detailed audit report as a markdown file
4. Categorize findings by severity (critical, warning, info)
5. Provide specific remediation steps for each finding

Guidelines:
- Be systematic — don't skip files or modules
- Provide file paths and line numbers for each finding
- Prioritize findings by impact
- Include both problems found and things done well
- Save your report as docs/audits/issue-NNN.md`,

  refactor: `You are refactoring code based on a GitHub issue.

Your job:
1. Understand the refactoring goal
2. Explore the code to understand current structure
3. Plan the refactoring approach (minimal, incremental changes)
4. Execute the refactoring
5. Verify nothing is broken

Guidelines:
- Make incremental changes, not a big-bang rewrite
- Preserve all existing behavior
- Run tests if available
- Follow existing code style`,

  unknown: `You are working on a GitHub issue. Read it carefully, understand what's needed, and take the most appropriate action. If it requires code changes, make them. If it requires research, document your findings. If it's unclear, document what you found and what questions remain.`,
};

/** Prompt for confidence self-assessment */
export const CONFIDENCE_PROMPT = `Now assess your work on this issue. Respond in this exact JSON format:

{
  "confidence": <number 1-10>,
  "summary": "<2-3 sentence summary of what you did>",
  "uncertainties": ["<thing you're unsure about>", ...],
  "changedFiles": ["<file1>", "<file2>", ...],
  "commitMessage": "<conventional commit message — short subject line, max 72 chars, e.g. fix: make floating badges visible on mobile>"
}

Scoring guide:
- 9-10: Fully solved, tested, confident in correctness
- 7-8: Solved but minor uncertainty (e.g., edge cases, style choices)
- 5-6: Partially solved, significant assumptions made
- 3-4: Best effort, but substantial uncertainty
- 1-2: Minimal progress, mostly questions remain`;

/** Prompt for issue classification */
export const CLASSIFICATION_PROMPT = `Classify this GitHub issue into exactly ONE category. Respond with just the category name, nothing else.

Categories:
- code-fix: Bug fix, error correction, broken functionality
- feature: New functionality, enhancement, improvement
- investigation: Research question, "figure out why...", performance analysis
- documentation: Write/update docs, README, comments
- audit: Review codebase for issues (security, accessibility, performance)
- refactor: Code restructuring without behavior change

Issue title: "{title}"
Issue body: "{body}"

Category:`;

/** Prompt for creating structured issues */
export const ISSUE_CREATION_PROMPT = `You are a technical project manager creating a well-structured GitHub issue from a description.

Create a GitHub issue with:
1. A clear, concise title (imperative mood, <70 chars)
2. A detailed description with:
   - **Problem/Goal**: What needs to happen and why
   - **Acceptance Criteria**: Bullet list of what "done" looks like
   - **Technical Notes**: Any relevant technical context
3. Suggested labels from: bug, enhancement, documentation, investigation, refactor, performance, security, accessibility

Respond in this exact JSON format:
{
  "title": "...",
  "body": "...",
  "labels": ["..."]
}

Description to convert:
"{description}"`;

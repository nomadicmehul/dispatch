import type { Issue } from "../engine/types.js";
import type { GitHubClient } from "./client.js";
import { log } from "../utils/logger.js";

/** Fetch and hydrate issues with comments and metadata */
export async function fetchAndHydrateIssues(
  client: GitHubClient,
  options: {
    labels?: string[];
    excludeLabels?: string[];
    maxIssues?: number;
  }
): Promise<Issue[]> {
  log.info(`Fetching open issues from ${client.owner}/${client.repo}...`);

  const rawIssues = await client.fetchOpenIssues(options);

  if (rawIssues.length === 0) {
    log.info("No open issues found matching filters.");
    return [];
  }

  log.info(`Found ${rawIssues.length} open issues. Fetching comments...`);

  const issues: Issue[] = await Promise.all(
    rawIssues.map(async (raw) => {
      const comments = raw.comments > 0
        ? await client.fetchIssueComments(raw.number)
        : [];

      return {
        number: raw.number,
        title: raw.title,
        body: raw.body || "",
        labels: raw.labels,
        comments,
        author: raw.user,
        url: raw.html_url,
        createdAt: raw.created_at,
        reactions: raw.reactions,
      };
    })
  );

  return issues;
}

/** Sort issues by priority */
export function prioritizeIssues(issues: Issue[]): Issue[] {
  return [...issues].sort((a, b) => {
    // Priority labels first
    const getPriority = (issue: Issue): number => {
      for (const label of issue.labels) {
        const lower = label.toLowerCase();
        if (lower === "p0" || lower === "critical" || lower === "urgent") return 0;
        if (lower === "p1" || lower === "high") return 1;
        if (lower === "p2" || lower === "medium") return 2;
        if (lower === "p3" || lower === "low") return 3;
      }
      return 4; // No priority label
    };

    const priorityDiff = getPriority(a) - getPriority(b);
    if (priorityDiff !== 0) return priorityDiff;

    // Then by reactions (more reactions = more important)
    if (b.reactions !== a.reactions) return b.reactions - a.reactions;

    // Then by age (older first)
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });
}

/** Create a slug from issue title for branch names */
export function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .substring(0, 40)
    .replace(/-$/, "");
}

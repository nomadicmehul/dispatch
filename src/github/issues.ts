import type { Issue } from "../engine/types.js";
import type { GitHubClient } from "./client.js";
import { log } from "../utils/logger.js";

/** True if Dispatch may act on text written by this GitHub author association ("*" trusts everyone) */
export function isTrustedAssociation(association: string | undefined, trustedAuthors: string[]): boolean {
  if (trustedAuthors.includes("*")) return true;
  return Boolean(association) && trustedAuthors.includes(association!.toUpperCase());
}

/** How many open issues to look at for a run that solves at most `maxIssues` */
export function candidateLimit(maxIssues: number): number {
  return Math.min(300, Math.max(50, maxIssues * 5));
}

/** Fetch open issues without comments (comments are fetched later, for selected issues only) */
export async function fetchCandidateIssues(
  client: GitHubClient,
  options: {
    labels?: string[];
    excludeLabels?: string[];
    limit: number;
  }
): Promise<Issue[]> {
  log.info(`Fetching open issues from ${client.owner}/${client.repo}...`);

  const rawIssues = await client.fetchOpenIssues({
    labels: options.labels,
    excludeLabels: options.excludeLabels,
    maxIssues: options.limit,
  });

  if (rawIssues.length === 0) {
    log.info("No open issues found matching filters.");
    return [];
  }

  log.info(`Found ${rawIssues.length} open issues.`);

  return rawIssues.map((raw) => ({
    number: raw.number,
    title: raw.title,
    body: raw.body || "",
    labels: raw.labels,
    comments: [],
    commentCount: raw.comments,
    author: raw.user,
    authorAssociation: raw.author_association,
    url: raw.html_url,
    createdAt: raw.created_at,
    reactions: raw.reactions,
  }));
}

/** Fetch comments for the given issues, keeping only those from trusted authors */
export async function hydrateComments(
  client: GitHubClient,
  issues: Issue[],
  trustedAuthors: string[]
): Promise<void> {
  await Promise.all(
    issues.map(async (issue) => {
      if (!issue.commentCount) return;
      const comments = await client.fetchIssueComments(issue.number);
      issue.comments = comments.filter((c) => isTrustedAssociation(c.authorAssociation, trustedAuthors));
      issue.omittedComments = comments.length - issue.comments.length;
    })
  );
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

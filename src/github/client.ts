import { Octokit } from "@octokit/rest";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { log } from "../utils/logger.js";

const exec = promisify(execFile);

const OctokitWithPlugins = Octokit.plugin(retry, throttling);

/** Create an authenticated Octokit client */
export async function createOctokit(): Promise<Octokit> {
  let token = process.env.GITHUB_TOKEN;

  if (!token) {
    // Try getting token from gh CLI
    try {
      const { stdout } = await exec("gh", ["auth", "token"]);
      token = stdout.trim();
    } catch {
      // gh not available or not authenticated
    }
  }

  if (!token) {
    throw new Error(
      "GitHub token not found. Set GITHUB_TOKEN environment variable or authenticate with `gh auth login`."
    );
  }

  return new OctokitWithPlugins({
    auth: token,
    throttle: {
      onRateLimit: (retryAfter: number, options: { method: string; url: string }, _octokit: unknown, retryCount: number) => {
        log.warn(`Rate limit hit for ${options.method} ${options.url}, retrying after ${retryAfter}s`);
        return retryCount < 2;
      },
      onSecondaryRateLimit: (retryAfter: number, options: { method: string; url: string }) => {
        log.warn(`Secondary rate limit hit for ${options.method} ${options.url}, retrying after ${retryAfter}s`);
        return true;
      },
    },
  });
}

export class GitHubClient {
  private octokit: Octokit;
  readonly owner: string;
  readonly repo: string;

  constructor(octokit: Octokit, owner: string, repo: string) {
    this.octokit = octokit;
    this.owner = owner;
    this.repo = repo;
  }

  static async create(owner: string, repo: string): Promise<GitHubClient> {
    const octokit = await createOctokit();
    return new GitHubClient(octokit, owner, repo);
  }

  /** Fetch open issues with optional label filters (paginated) */
  async fetchOpenIssues(options: {
    labels?: string[];
    excludeLabels?: string[];
    maxIssues?: number;
  } = {}): Promise<Array<{
    number: number;
    title: string;
    body: string | null;
    labels: string[];
    user: string;
    html_url: string;
    created_at: string;
    reactions: number;
    comments: number;
  }>> {
    const { labels = [], excludeLabels = [], maxIssues = 30 } = options;

    const params: Record<string, unknown> = {
      owner: this.owner,
      repo: this.repo,
      state: "open" as const,
      per_page: Math.min(maxIssues, 100),
      sort: "created" as const,
      direction: "desc" as const,
    };

    if (labels.length > 0) {
      params.labels = labels.join(",");
    }

    // Use pagination to handle maxIssues > 100
    const issues = await this.octokit.paginate(
      this.octokit.issues.listForRepo,
      params as Parameters<Octokit["issues"]["listForRepo"]>[0],
      (response, done) => {
        const items = response.data;
        // Stop paginating once we have enough
        if (items.length >= maxIssues) {
          done();
        }
        return items;
      }
    );

    // Filter out pull requests (GitHub API returns PRs in issues endpoint)
    let filtered = issues.filter((issue) => !(issue as { pull_request?: unknown }).pull_request);

    // Filter out excluded labels
    if (excludeLabels.length > 0) {
      filtered = filtered.filter((issue) => {
        const issueLabels = issue.labels.map((l) =>
          typeof l === "string" ? l : (l as { name?: string }).name || ""
        );
        return !issueLabels.some((label) => excludeLabels.includes(label));
      });
    }

    return filtered.slice(0, maxIssues).map((issue) => ({
      number: issue.number,
      title: issue.title,
      body: issue.body ?? null,
      labels: issue.labels.map((l) => (typeof l === "string" ? l : (l as { name?: string }).name || "")),
      user: issue.user?.login || "unknown",
      html_url: issue.html_url,
      created_at: issue.created_at,
      reactions: (issue.reactions as { total_count?: number })?.total_count || 0,
      comments: issue.comments,
    }));
  }

  /** Fetch comments for an issue (paginated) */
  async fetchIssueComments(issueNumber: number): Promise<Array<{
    author: string;
    body: string;
    createdAt: string;
  }>> {
    const comments = await this.octokit.paginate(
      this.octokit.issues.listComments,
      {
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        per_page: 100,
      }
    );

    return comments.map((c) => ({
      author: c.user?.login || "unknown",
      body: c.body || "",
      createdAt: c.created_at,
    }));
  }

  /** Create a pull request */
  async createPullRequest(options: {
    title: string;
    body: string;
    head: string;
    base: string;
    draft?: boolean;
    labels?: string[];
  }): Promise<{ number: number; url: string }> {
    const { data: pr } = await this.octokit.pulls.create({
      owner: this.owner,
      repo: this.repo,
      title: options.title,
      body: options.body,
      head: options.head,
      base: options.base,
      draft: options.draft || false,
    });

    // Add labels if provided
    if (options.labels && options.labels.length > 0) {
      try {
        await this.octokit.issues.addLabels({
          owner: this.owner,
          repo: this.repo,
          issue_number: pr.number,
          labels: options.labels,
        });
      } catch (err) {
        log.warn(`Could not add labels to PR #${pr.number}: ${err}`);
      }
    }

    return { number: pr.number, url: pr.html_url };
  }

  /** Create a new issue */
  async createIssue(options: {
    title: string;
    body: string;
    labels?: string[];
  }): Promise<{ number: number; url: string }> {
    const { data: issue } = await this.octokit.issues.create({
      owner: this.owner,
      repo: this.repo,
      title: options.title,
      body: options.body,
      labels: options.labels || [],
    });

    return { number: issue.number, url: issue.html_url };
  }

  /** Add a comment to an issue */
  async addComment(issueNumber: number, body: string): Promise<void> {
    await this.octokit.issues.createComment({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      body,
    });
  }

  /** Add a label to an issue */
  async addLabel(issueNumber: number, label: string): Promise<void> {
    try {
      // Ensure label exists
      try {
        await this.octokit.issues.getLabel({
          owner: this.owner,
          repo: this.repo,
          name: label,
        });
      } catch {
        await this.octokit.issues.createLabel({
          owner: this.owner,
          repo: this.repo,
          name: label,
          color: "7057ff",
          description: "Auto-classified by dispatch",
        });
      }

      await this.octokit.issues.addLabels({
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        labels: [label],
      });
    } catch (err) {
      log.warn(`Could not add label "${label}" to #${issueNumber}: ${err}`);
    }
  }
}

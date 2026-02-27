import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { log } from "./logger.js";

const exec = promisify(execFile);

export interface GitResult {
  stdout: string;
  stderr: string;
}

export async function git(args: string[], cwd?: string): Promise<GitResult> {
  log.debug(`git ${args.join(" ")}`);
  const { stdout, stderr } = await exec("git", args, {
    cwd: cwd || process.cwd(),
    maxBuffer: 10 * 1024 * 1024,
  });
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

/** Get the remote origin URL and parse owner/repo */
export async function getRepoInfo(cwd?: string): Promise<{ owner: string; repo: string }> {
  const { stdout } = await git(["remote", "get-url", "origin"], cwd);
  const url = stdout;

  // Handle SSH: git@github.com:owner/repo.git
  const sshMatch = url.match(/git@github\.com:(.+?)\/(.+?)(?:\.git)?$/);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  // Handle HTTPS: https://github.com/owner/repo.git
  const httpsMatch = url.match(/github\.com\/(.+?)\/(.+?)(?:\.git)?$/);
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }

  throw new Error(`Could not parse GitHub repo from remote URL: ${url}`);
}

/** Sensitive file patterns that should never be staged */
const SENSITIVE_PATTERNS = [
  ".env*", "*.pem", "*.key", "*.p12", "*.pfx",
  "credentials*", "*.secret", ".secrets*",
  "secrets.yaml", "secrets.yml", "secrets.json",
  "*.token", "*password*",
];

/** Stage all changes, commit, and push — with sensitive file protection */
export async function commitAndPush(
  branchName: string,
  message: string,
  cwd?: string
): Promise<{ hasChanges: boolean }> {
  // Check for changes
  const { stdout: status } = await git(["status", "--porcelain"], cwd);
  if (!status) {
    return { hasChanges: false };
  }

  await git(["add", "-A"], cwd);

  // Unstage sensitive files before committing
  for (const pattern of SENSITIVE_PATTERNS) {
    try {
      await git(["reset", "HEAD", "--", pattern], cwd);
    } catch {
      // Pattern didn't match any staged files — that's fine
    }
  }

  // Check if there are still staged changes after filtering
  const { stdout: staged } = await git(["diff", "--cached", "--name-only"], cwd);
  if (!staged) {
    return { hasChanges: false };
  }

  await git(["commit", "-m", message], cwd);
  await git(["push", "-u", "origin", branchName], cwd);
  return { hasChanges: true };
}

/** Get short diff summary for PR description */
export async function getDiffSummary(baseBranch: string, cwd?: string): Promise<string> {
  const { stdout } = await git(["diff", "--stat", `origin/${baseBranch}...HEAD`], cwd);
  return stdout;
}

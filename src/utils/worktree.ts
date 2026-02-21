import { join } from "node:path";
import { rm, access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { log } from "./logger.js";

const exec = promisify(execFile);

async function git(args: string[], cwd?: string): Promise<string> {
  log.debug(`git ${args.join(" ")}`);
  const { stdout } = await exec("git", args, {
    cwd: cwd || process.cwd(),
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}

/**
 * Create a git worktree with a new branch based on a remote base branch.
 */
export async function createWorktree(
  worktreePath: string,
  branchName: string,
  baseBranch: string,
  cwd: string
): Promise<void> {
  // Clean up if path already exists (e.g. from a previous crashed run)
  try {
    await access(worktreePath);
    log.warn(`Worktree path already exists: ${worktreePath}, removing...`);
    await removeWorktree(worktreePath, cwd);
  } catch {
    // Path doesn't exist, good
  }

  // Prune stale worktree references first — this is critical because
  // `git branch -D` refuses to delete a branch that git thinks is still
  // checked out in a worktree (even if the worktree directory is gone).
  try {
    await git(["worktree", "prune"], cwd);
  } catch {
    // ignore prune errors
  }

  await git(["fetch", "origin", baseBranch], cwd);

  // Delete stale branch from a previous crashed run (if it exists)
  try {
    await git(["branch", "-D", branchName], cwd);
    log.warn(`Deleted stale branch: ${branchName}`);
  } catch {
    // Branch doesn't exist, good
  }

  await git(
    ["worktree", "add", worktreePath, "-b", branchName, `origin/${baseBranch}`],
    cwd
  );
}

/**
 * Remove a git worktree and optionally delete the associated branch.
 */
export async function removeWorktree(
  worktreePath: string,
  cwd: string,
  options: { deleteBranch?: string } = {}
): Promise<void> {
  try {
    await git(["worktree", "remove", worktreePath, "--force"], cwd);
  } catch (err) {
    log.debug(`worktree remove failed (may already be gone): ${err}`);
    try {
      await git(["worktree", "prune"], cwd);
    } catch { /* ignore prune errors */ }
  }

  // Clean up directory if it still exists
  try {
    await rm(worktreePath, { recursive: true, force: true });
  } catch { /* ignore */ }

  if (options.deleteBranch) {
    try {
      await git(["branch", "-D", options.deleteBranch], cwd);
    } catch { /* branch may not exist */ }
  }
}

/**
 * Build the worktree path for an issue.
 */
export function getWorktreePath(cwd: string, stateDir: string, issueNumber: number): string {
  return join(cwd, stateDir, "worktrees", `issue-${issueNumber}`);
}

/**
 * Clean up all worktrees in the dispatch state directory.
 * Useful for crash recovery at pipeline start.
 */
export async function cleanupAllWorktrees(cwd: string, stateDir: string): Promise<void> {
  try {
    await git(["worktree", "prune"], cwd);
    const worktreeDir = join(cwd, stateDir, "worktrees");
    await rm(worktreeDir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

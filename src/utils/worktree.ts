import { join } from "node:path";
import { rm, access } from "node:fs/promises";
import { git, gitRemote } from "./git.js";
import { log } from "./logger.js";
import { Semaphore } from "./semaphore.js";

/**
 * Worktree commands change shared state in the main repository (.git/worktrees, refs), and
 * running them in parallel is unsafe: a `git worktree prune` for one issue can remove the
 * half-created entry of another issue's `git worktree add`. Issues are solved in parallel,
 * so these short git steps run one at a time; the agents themselves still run in parallel.
 */
const worktreeLock = new Semaphore(1);

async function withWorktreeLock<T>(fn: () => Promise<T>): Promise<T> {
  await worktreeLock.acquire();
  try {
    return await fn();
  } finally {
    worktreeLock.release();
  }
}

/** The worktree that has `branchName` checked out, other than `except`, or null */
export async function worktreeHoldingBranch(branchName: string, cwd: string, except?: string): Promise<string | null> {
  const { stdout } = await git(["worktree", "list", "--porcelain"], cwd);
  for (const block of stdout.split("\n\n")) {
    const path = block.match(/^worktree (.+)$/m)?.[1];
    const branch = block.match(/^branch refs\/heads\/(.+)$/m)?.[1];
    if (path && branch === branchName && path !== except) return path;
  }
  return null;
}

/**
 * Create a git worktree with a new branch based on a remote base branch.
 */
export function createWorktree(
  worktreePath: string,
  branchName: string,
  baseBranch: string,
  cwd: string
): Promise<void> {
  return withWorktreeLock(async () => {
    // Clean up if path already exists (e.g. from a previous crashed run)
    try {
      await access(worktreePath);
      log.warn(`Worktree path already exists: ${worktreePath}, removing...`);
      await removeWorktreeUnlocked(worktreePath, cwd);
    } catch {
      // Path doesn't exist, good
    }

    // Forget worktrees whose folders are gone, so their branches can be reused
    try {
      await git(["worktree", "prune"], cwd);
    } catch {
      // ignore prune errors
    }

    // A branch that is still checked out somewhere else (e.g. a `dispatch resume` worktree
    // holding someone's work) must not be reset; say where it is instead of failing in git
    const holder = await worktreeHoldingBranch(branchName, cwd, worktreePath);
    if (holder) {
      throw new Error(
        `Branch ${branchName} is checked out in ${holder} (for example by dispatch resume). ` +
        `Remove that worktree (git worktree remove ${holder}) to let Dispatch work on this issue again.`
      );
    }

    await gitRemote(["fetch", "origin", baseBranch], cwd);

    // A branch left from an earlier run (its PR closed, or a crash) is reset to the base
    // in the same step that creates the worktree (-B)
    try {
      await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branchName}`], cwd);
      log.warn(`Resetting existing branch ${branchName} to origin/${baseBranch}`);
    } catch {
      // no such branch yet
    }

    await git(["worktree", "add", "-B", branchName, worktreePath, `origin/${baseBranch}`], cwd);
  });
}

/**
 * Create a git worktree that checks out an existing branch from origin
 * (used by `dispatch resume` to continue work on a Dispatch PR).
 */
export function createWorktreeFromBranch(
  worktreePath: string,
  branchName: string,
  cwd: string
): Promise<void> {
  return withWorktreeLock(async () => {
    try {
      await access(worktreePath);
      await removeWorktreeUnlocked(worktreePath, cwd);
    } catch {
      // Path doesn't exist, good
    }

    try {
      await git(["worktree", "prune"], cwd);
    } catch {
      // ignore prune errors
    }

    await gitRemote(["fetch", "origin", branchName], cwd);
    await git(["worktree", "add", "-B", branchName, worktreePath, `origin/${branchName}`], cwd);
  });
}

async function removeWorktreeUnlocked(
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
 * Remove a git worktree and optionally delete the associated branch.
 */
export function removeWorktree(
  worktreePath: string,
  cwd: string,
  options: { deleteBranch?: string } = {}
): Promise<void> {
  return withWorktreeLock(() => removeWorktreeUnlocked(worktreePath, cwd, options));
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

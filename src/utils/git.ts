import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { log } from "./logger.js";

const exec = promisify(execFile);

export interface GitResult {
  stdout: string;
  stderr: string;
}

export async function git(
  args: string[],
  cwd?: string,
  options: { env?: NodeJS.ProcessEnv; maxBuffer?: number } = {},
): Promise<GitResult> {
  log.debug(`git ${args.join(" ")}`);
  const { stdout, stderr } = await exec("git", args, {
    cwd: cwd || process.cwd(),
    maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
    env: options.env ? { ...process.env, ...options.env } : undefined,
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

/**
 * True for files that usually hold credentials. Matches on the file name only, so
 * source files such as `reset-password.ts` or `credentials-form.tsx` are not caught,
 * and templates such as `.env.example` can still be committed.
 */
export function isSensitivePath(filePath: string): boolean {
  const name = filePath.split("/").pop() || "";
  if (/^\.env(\..+)?$/.test(name)) {
    return !/\.(example|sample|template|dist|defaults)$/.test(name);
  }
  return (
    /\.(pem|key|p12|pfx|jks|keystore|secret|token)$/.test(name) ||
    /^id_(rsa|dsa|ecdsa|ed25519)$/.test(name) ||
    /^(credentials|secrets)\.(json|ya?ml|toml|ini)$/.test(name) ||
    /^\.(npmrc|netrc|pypirc|secrets)$/.test(name)
  );
}

/**
 * Stage all changes except likely secrets and the given paths (e.g. a linked node_modules).
 * Returns what was staged and which files were held back.
 */
export async function stageChanges(
  cwd: string,
  exclude: string[] = [],
): Promise<{ staged: string[]; heldBack: string[] }> {
  const { stdout: status } = await git(["status", "--porcelain"], cwd);
  if (!status) {
    return { staged: [], heldBack: [] };
  }

  await git(["add", "-A"], cwd);

  const { stdout: names } = await git(["diff", "--cached", "--name-only", "-z"], cwd);
  const stagedPaths = names.split("\0").filter(Boolean);
  const excluded = stagedPaths.filter((p) => exclude.includes(p) || isSensitivePath(p));

  if (excluded.length > 0) {
    await git(["reset", "-q", "--", ...excluded], cwd);
  }

  return {
    staged: stagedPaths.filter((p) => !excluded.includes(p)),
    heldBack: excluded.filter((p) => !exclude.includes(p)),
  };
}

export interface DiffStats {
  files: string[];
  additions: number;
  deletions: number;
}

/** Line counts for the staged changes (binary files count as changed files only) */
export async function stagedDiffStats(cwd: string): Promise<DiffStats> {
  const { stdout } = await git(["diff", "--cached", "--numstat"], cwd);
  const stats: DiffStats = { files: [], additions: 0, deletions: 0 };

  for (const line of stdout.split("\n").filter(Boolean)) {
    const [added, deleted, ...rest] = line.split("\t");
    stats.files.push(rest.join("\t"));
    stats.additions += Number(added) || 0;
    stats.deletions += Number(deleted) || 0;
  }

  return stats;
}

/**
 * Committer identity to use when git has none configured (e.g. a fresh CI runner).
 * Returns env overrides, or an empty object when an identity already exists.
 */
async function identityEnv(cwd: string): Promise<NodeJS.ProcessEnv> {
  try {
    const { stdout } = await git(["config", "user.email"], cwd);
    if (stdout) return {};
  } catch {
    // not configured
  }
  const name = "dispatch[bot]";
  const email = "dispatch-bot@users.noreply.github.com";
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  };
}

/** Commit the staged changes and return the new commit SHA */
export async function commitStaged(message: string, cwd: string): Promise<string> {
  await git(["commit", "-m", message], cwd, { env: await identityEnv(cwd) });
  const { stdout } = await git(["rev-parse", "HEAD"], cwd);
  return stdout;
}

/** Push a branch to origin and set its upstream */
export async function pushBranch(branchName: string, cwd: string): Promise<void> {
  await git(["push", "-u", "origin", branchName], cwd);
}

/** Branch names on origin matching a glob, e.g. "dispatch/issue-*" */
export async function listRemoteBranches(pattern: string, cwd: string): Promise<string[]> {
  const { stdout } = await git(["ls-remote", "--heads", "origin", `refs/heads/${pattern}`], cwd);
  return stdout
    .split("\n")
    .map((line) => line.split("\t")[1] || "")
    .filter((ref) => ref.startsWith("refs/heads/"))
    .map((ref) => ref.slice("refs/heads/".length));
}

/**
 * Store files as a commit under a custom ref, without touching any branch or the index.
 * Used to keep session transcripts in the repository itself (refs/dispatch/sessions/<id>).
 */
export async function writeFilesToRef(
  ref: string,
  files: Array<{ name: string; path: string }>,
  message: string,
  cwd: string,
  indexFile: string,
): Promise<string> {
  const indexEnv = { GIT_INDEX_FILE: indexFile };

  for (const file of files) {
    const { stdout: blob } = await git(["hash-object", "-w", "--", file.path], cwd);
    await git(["update-index", "--add", "--cacheinfo", `100644,${blob},${file.name}`], cwd, { env: indexEnv });
  }

  const { stdout: tree } = await git(["write-tree"], cwd, { env: indexEnv });
  const { stdout: commit } = await git(["commit-tree", tree, "-m", message], cwd, {
    env: await identityEnv(cwd),
  });
  await git(["update-ref", ref, commit], cwd);
  return commit;
}

/** Get short diff summary for PR description */
export async function getDiffSummary(baseBranch: string, cwd?: string): Promise<string> {
  const { stdout } = await git(["diff", "--stat", `origin/${baseBranch}...HEAD`], cwd);
  return stdout;
}

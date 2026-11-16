import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { scrubEnv } from "../utils/env.js";
import { log } from "../utils/logger.js";

const exec = promisify(execFile);

/** A PR opened in this run and the files its branch changes */
export interface BranchChange {
  issueNumber: number;
  prNumber: number;
  branch: string;
  files: string[];
}

/** Two PRs from the same run that change the same files */
export interface Overlap {
  a: BranchChange;
  b: BranchChange;
  files: string[];
  /** true = merging both conflicts, false = they merge cleanly, null = couldn't tell */
  conflicts: boolean | null;
}

/** Pairs of changes that touch at least one common file */
export function overlappingPairs(changes: BranchChange[]): Array<Pick<Overlap, "a" | "b" | "files">> {
  const pairs: Array<Pick<Overlap, "a" | "b" | "files">> = [];
  for (let i = 0; i < changes.length; i++) {
    const filesA = new Set(changes[i].files);
    for (let j = i + 1; j < changes.length; j++) {
      const files = changes[j].files.filter((f) => filesA.has(f));
      if (files.length > 0) pairs.push({ a: changes[i], b: changes[j], files: files.sort() });
    }
  }
  return pairs;
}

/**
 * Whether merging two branches conflicts, without touching the working tree or index
 * (`git merge-tree --write-tree`, git 2.38+). Exit 0 = clean, 1 = conflicts.
 */
export async function mergeConflicts(branchA: string, branchB: string, cwd: string): Promise<boolean | null> {
  try {
    await exec("git", ["merge-tree", "--write-tree", "--no-messages", branchA, branchB], {
      cwd,
      env: scrubEnv(process.env),
      maxBuffer: 10 * 1024 * 1024,
    });
    return false;
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (code === 1) return true;
    log.debug(`merge-tree ${branchA} ${branchB} failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/** Find PRs from this run that change the same files, and check whether each pair merges cleanly */
export async function detectOverlaps(changes: BranchChange[], cwd: string): Promise<Overlap[]> {
  const overlaps: Overlap[] = [];
  for (const pair of overlappingPairs(changes)) {
    overlaps.push({ ...pair, conflicts: await mergeConflicts(pair.a.branch, pair.b.branch, cwd) });
  }
  return overlaps;
}

/** One line describing an overlap from the point of view of `self` */
export function describeOverlap(overlap: Overlap, self: number): string {
  const other = overlap.a.prNumber === self ? overlap.b : overlap.a;
  const files = overlap.files.map((f) => `\`${f}\``).join(", ");
  const verdict = overlap.conflicts === true
    ? "**merging both conflicts**: merge one, then rebase the other"
    : overlap.conflicts === false
      ? "they merge cleanly, but check that the combined result still makes sense"
      : "couldn't check whether they merge cleanly";
  return `#${other.prNumber} (issue #${other.issueNumber}) also changes ${files}; ${verdict}.`;
}

/** PR comment listing every overlap that involves `prNumber` */
export function overlapComment(overlaps: Overlap[], prNumber: number): string | undefined {
  const mine = overlaps.filter((o) => o.a.prNumber === prNumber || o.b.prNumber === prNumber);
  if (mine.length === 0) return undefined;
  return [
    "**Dispatch: overlapping PRs from the same run**",
    "",
    "These PRs were solved in parallel and change the same files:",
    "",
    ...mine.map((o) => `- ${describeOverlap(o, prNumber)}`),
  ].join("\n");
}

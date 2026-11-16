import { mkdir, readdir, readFile, writeFile, access, rm } from "node:fs/promises";
import { join } from "node:path";
import { git, writeFilesToRef, type DiffStats } from "../utils/git.js";
import { log } from "../utils/logger.js";
import { redactSecrets } from "./redact.js";
import type { Assessment } from "../orchestrator/scorer.js";
import type { VerifyOutcome } from "../orchestrator/verify.js";

/**
 * A session record is the "why" behind a Dispatch commit: which issue, which agent,
 * what it cost, what was verified, and the full transcript of how the change was made.
 *
 * Records live in <stateDir>/sessions/<id>/ (meta.json, transcript.jsonl, native.jsonl),
 * and with provenance "ref" they are also pushed to refs/dispatch/sessions/<id>, so a
 * session recorded on a CI runner can be explained and resumed from any clone.
 */
export interface SessionRecord {
  version: 1;
  /** Session UUID; for the Claude engine this is also the Claude Code session ID */
  id: string;
  /** owner/name of the repository the session worked in */
  repo: string;
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  classification: string;
  engine: string;
  model: string;
  status: "solved" | "failed" | "no-changes";
  error?: string;
  startedAt: string;
  durationMs: number;
  costUsd?: number;
  turns?: number;
  readiness?: { score: number; reasons: string[]; missing: string[] };
  verify?: VerifyOutcome;
  assessment?: Assessment;
  summary?: string;
  uncertainties?: string[];
  diff?: DiffStats;
  heldBack?: string[];
  branch: string;
  baseBranch: string;
  /** Directory the agent worked in (paths in the transcript are relative to it) */
  workdir?: string;
  /** The shared repository brief the agent received, if any */
  repoBrief?: { ref: string; chars: number };
  commitSha?: string;
  prNumber?: number;
  prUrl?: string;
  hostname: string;
}

export const TRANSCRIPT_FILE = "transcript.jsonl";
export const NATIVE_TRANSCRIPT_FILE = "native.jsonl";
const META_FILE = "meta.json";
const REF_PREFIX = "refs/dispatch/sessions/";

export function sessionsRoot(cwd: string, stateDir: string): string {
  return join(cwd, stateDir, "sessions");
}

export function sessionDir(cwd: string, stateDir: string, id: string): string {
  return join(sessionsRoot(cwd, stateDir), id);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function saveSession(record: SessionRecord, cwd: string, stateDir: string): Promise<void> {
  const dir = sessionDir(cwd, stateDir, record.id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, META_FILE), JSON.stringify(record, null, 2) + "\n", "utf-8");
}

/** Copy an engine's native transcript into the session, with secrets redacted */
export async function importNativeTranscript(
  sourcePath: string,
  cwd: string,
  stateDir: string,
  id: string,
): Promise<void> {
  const raw = await readFile(sourcePath, "utf-8");
  const dir = sessionDir(cwd, stateDir, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, NATIVE_TRANSCRIPT_FILE), redactSecrets(raw), "utf-8");
}

export async function loadSession(cwd: string, stateDir: string, id: string): Promise<SessionRecord | null> {
  try {
    const raw = await readFile(join(sessionDir(cwd, stateDir, id), META_FILE), "utf-8");
    return JSON.parse(raw) as SessionRecord;
  } catch {
    return null;
  }
}

/** All local session records, newest first */
export async function listSessions(cwd: string, stateDir: string): Promise<SessionRecord[]> {
  let ids: string[];
  try {
    ids = await readdir(sessionsRoot(cwd, stateDir));
  } catch {
    return [];
  }

  const records = await Promise.all(ids.map((id) => loadSession(cwd, stateDir, id)));
  return records
    .filter((r): r is SessionRecord => r !== null)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/**
 * Find the newest session matching a target: a session ID (or prefix of at least 6
 * characters), an issue number, or a PR number ("42" or "#42").
 */
export function matchSession(records: SessionRecord[], target: string): SessionRecord | null {
  const value = target.trim().replace(/^#/, "");

  if (/^\d+$/.test(value)) {
    const n = Number(value);
    const byNumber = records.find((r) => r.issueNumber === n || r.prNumber === n);
    // A session ID can start with digits, so fall through to prefix matching
    if (byNumber || target.trim().startsWith("#")) return byNumber ?? null;
  }

  if (value.length >= 6) {
    return records.find((r) => r.id.startsWith(value.toLowerCase())) ?? null;
  }

  return null;
}

/** Push a session to refs/dispatch/sessions/<id> on origin */
export async function pushSessionRef(record: SessionRecord, cwd: string, stateDir: string): Promise<void> {
  const dir = sessionDir(cwd, stateDir, record.id);
  const files: Array<{ name: string; path: string }> = [];
  for (const name of [META_FILE, TRANSCRIPT_FILE, NATIVE_TRANSCRIPT_FILE]) {
    if (await exists(join(dir, name))) files.push({ name, path: join(dir, name) });
  }

  const indexFile = join(dir, ".index");
  const ref = `${REF_PREFIX}${record.id}`;
  try {
    await writeFilesToRef(ref, files, `dispatch session ${record.id} (issue #${record.issueNumber})`, cwd, indexFile);
    await git(["push", "origin", `${ref}:${ref}`], cwd);
  } finally {
    await rm(indexFile, { force: true });
  }
}

/**
 * Fetch session refs from origin and unpack any that aren't present locally.
 * Returns how many sessions were added.
 */
export async function fetchSessionRefs(cwd: string, stateDir: string): Promise<number> {
  await git(["fetch", "origin", `+${REF_PREFIX}*:${REF_PREFIX}*`], cwd);
  const { stdout } = await git(["for-each-ref", "--format=%(refname)", REF_PREFIX], cwd);

  let added = 0;
  for (const ref of stdout.split("\n").filter(Boolean)) {
    const id = ref.slice(REF_PREFIX.length);
    const dir = sessionDir(cwd, stateDir, id);
    if (await exists(join(dir, META_FILE))) continue;

    await mkdir(dir, { recursive: true });
    const { stdout: listing } = await git(["ls-tree", "--name-only", ref], cwd);
    for (const name of listing.split("\n").filter(Boolean)) {
      const { stdout: content } = await git(["show", `${ref}:${name}`], cwd, { maxBuffer: 256 * 1024 * 1024 });
      await writeFile(join(dir, name), content + "\n", "utf-8");
    }
    added++;
  }

  return added;
}

/** Find a session locally, then in session refs on origin */
export async function findSession(target: string, cwd: string, stateDir: string): Promise<SessionRecord | null> {
  const local = matchSession(await listSessions(cwd, stateDir), target);
  if (local) return local;

  try {
    const added = await fetchSessionRefs(cwd, stateDir);
    if (added > 0) log.debug(`Fetched ${added} session(s) from origin`);
  } catch (err) {
    log.debug(`No session refs fetched from origin: ${err instanceof Error ? err.message : err}`);
    return null;
  }

  return matchSession(await listSessions(cwd, stateDir), target);
}

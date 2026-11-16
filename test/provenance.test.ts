import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { scrubEnv, secretValues } from "../src/utils/env.js";
import { redactSecrets } from "../src/provenance/redact.js";
import { appendTrailers, parseTrailers, SESSION_TRAILER } from "../src/provenance/trailers.js";
import { buildTimeline, appendTranscriptEvent, readTranscript } from "../src/provenance/transcript.js";
import {
  saveSession,
  listSessions,
  matchSession,
  findSession,
  pushSessionRef,
  sessionDir,
  TRANSCRIPT_FILE,
  type SessionRecord,
} from "../src/provenance/store.js";

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    version: 1,
    id: randomUUID(),
    repo: "owner/repo",
    issueNumber: 42,
    issueTitle: "Fix parser",
    issueUrl: "https://github.com/owner/repo/issues/42",
    classification: "code-fix",
    engine: "claude",
    model: "sonnet",
    status: "solved",
    startedAt: "2026-10-28T02:00:00.000Z",
    durationMs: 1000,
    branch: "dispatch/issue-42-fix-parser",
    baseBranch: "main",
    hostname: "runner",
    ...overrides,
  };
}

describe("scrubEnv", () => {
  it("removes credentials but keeps ordinary variables", () => {
    const env = scrubEnv({ PATH: "/bin", HOME: "/h", GITHUB_TOKEN: "x", AWS_SECRET_ACCESS_KEY: "y", NPM_PASSWORD: "z", GH_PAT: "p" });
    assert.deepEqual(env, { PATH: "/bin", HOME: "/h" });
  });

  it("keeps credentials matching a keep pattern", () => {
    const env = scrubEnv({ ANTHROPIC_API_KEY: "k", GITHUB_TOKEN: "t" }, [/^ANTHROPIC_/]);
    assert.deepEqual(env, { ANTHROPIC_API_KEY: "k" });
  });

  it("collects secret values worth redacting", () => {
    assert.deepEqual(secretValues({ GITHUB_TOKEN: "abcdefgh123", SHORT_TOKEN: "abc", PATH: "/bin/long/path" }), ["abcdefgh123"]);
  });
});

describe("redactSecrets", () => {
  it("redacts well-known token formats", () => {
    const text = `token ghp_${"a".repeat(36)} key sk-ant-api03-${"b".repeat(30)} aws AKIAABCDEFGHIJKLMNOP`;
    const result = redactSecrets(text, []);
    assert.ok(!result.includes("ghp_"));
    assert.ok(!result.includes("sk-ant-"));
    assert.ok(!result.includes("AKIA"));
  });

  it("redacts literal secret values and keeps JSON valid", () => {
    const line = JSON.stringify({ output: "export TOKEN=my-very-secret-value" });
    const result = redactSecrets(line, ["my-very-secret-value"]);
    assert.equal(JSON.parse(result).output, "export TOKEN=[REDACTED]");
  });

  it("redacts private key blocks", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----";
    assert.equal(redactSecrets(`key: ${pem}`, []), "key: [REDACTED]");
  });
});

describe("trailers", () => {
  it("appends trailers as the last paragraph and parses them back", () => {
    const message = appendTrailers("fix: handle empty input\n\nLonger body.", {
      [SESSION_TRAILER]: "abc-123",
      "Dispatch-Verify": "passed (npm test)",
      "Dispatch-Skipped": undefined,
    });
    assert.ok(message.endsWith("Dispatch-Session: abc-123\nDispatch-Verify: passed (npm test)"));
    assert.deepEqual(parseTrailers(message), { "Dispatch-Session": "abc-123", "Dispatch-Verify": "passed (npm test)" });
  });

  it("leaves the message alone without trailers", () => {
    assert.equal(appendTrailers("fix: x", {}), "fix: x");
  });
});

describe("buildTimeline", () => {
  it("condenses stream-json events and Dispatch markers", () => {
    const events = [
      { type: "dispatch", phase: "solve", engine: "claude", model: "sonnet" },
      { type: "system", subtype: "init" },
      { type: "assistant", message: { content: [
        { type: "thinking", thinking: "hmm" },
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: "src/parser.ts" } },
      ] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: false }] } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "npm test" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", is_error: true }] } },
      { type: "assistant", parent_tool_use_id: "x", message: { content: [{ type: "tool_use", id: "t3", name: "Grep", input: {} }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "Done." }] } },
      { type: "result", subtype: "success", num_turns: 4, total_cost_usd: 0.1234 },
      { type: "dispatch", phase: "verify", command: "npm test", status: "passed", exitCode: 0, durationMs: 2000 },
    ];

    assert.deepEqual(buildTimeline(events), [
      { kind: "phase", detail: "solve started (claude sonnet)" },
      { kind: "tool", tool: "Read", detail: "src/parser.ts", error: false },
      { kind: "tool", tool: "Bash", detail: "npm test", error: true },
      { kind: "text", detail: "Done." },
      { kind: "result", detail: "success after 4 turns, $0.12" },
      { kind: "phase", detail: "verify passed: npm test (exit 0, 2s)" },
    ]);
  });

  it("shows paths relative to the agent's working directory", () => {
    const events = [{ type: "assistant", message: { content: [
      { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/runner/work/.dispatch/worktrees/issue-7/src/math.js" } },
      { type: "tool_use", id: "t2", name: "Bash", input: { command: "npm test -- /runner/work/.dispatch/worktrees/issue-7" } },
    ] } }];
    const timeline = buildTimeline(events, { workdir: "/runner/work/.dispatch/worktrees/issue-7" });
    assert.deepEqual(timeline.map((e) => e.detail), ["src/math.js", "npm test -- ."]);
  });

  it("reads transcripts and skips broken lines", async () => {
    const file = join(tmpdir(), `dispatch-transcript-${randomUUID()}.jsonl`);
    await writeFile(file, '{"type":"system"}\n{"type":"assist\n');
    await appendTranscriptEvent(file, "repair", { attempt: 1 });
    const events = await readTranscript(file);
    assert.equal(events.length, 2);
    assert.equal(events[1].phase, "repair");
    await rm(file, { force: true });
  });
});

describe("session store", () => {
  let root: string;
  let origin: string;
  let work: string;
  let clone: string;
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();

  before(async () => {
    root = join(tmpdir(), `dispatch-store-${randomUUID()}`);
    origin = join(root, "origin.git");
    work = join(root, "work");
    clone = join(root, "clone");
    await mkdir(work, { recursive: true });
    git(root, "init", "--bare", "-q", origin);
    git(work, "init", "-q", "-b", "main");
    git(work, "config", "user.email", "test@example.com");
    git(work, "config", "user.name", "Test");
    await writeFile(join(work, "README.md"), "hi\n");
    git(work, "add", ".");
    git(work, "commit", "-q", "-m", "init");
    git(work, "remote", "add", "origin", origin);
    git(work, "push", "-q", "origin", "main");
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("saves, lists, and matches sessions by issue, PR, or ID prefix", async () => {
    const older = makeRecord({ issueNumber: 7, startedAt: "2026-10-27T00:00:00.000Z" });
    const newer = makeRecord({ issueNumber: 7, prNumber: 99, startedAt: "2026-10-28T00:00:00.000Z" });
    await saveSession(older, work, ".dispatch");
    await saveSession(newer, work, ".dispatch");

    const records = await listSessions(work, ".dispatch");
    assert.equal(records[0].id, newer.id);
    assert.equal(matchSession(records, "#7")?.id, newer.id);
    assert.equal(matchSession(records, "99")?.id, newer.id);
    assert.equal(matchSession(records, older.id.substring(0, 8))?.id, older.id);
    assert.equal(matchSession(records, "abc"), null);
  });

  it("matches session IDs that start with digits", () => {
    const record = makeRecord({ id: "12345678-aaaa-4bbb-8ccc-dddddddddddd", issueNumber: 7 });
    assert.equal(matchSession([record], "12345678")?.id, record.id);
    assert.equal(matchSession([record], "7")?.id, record.id);
    assert.equal(matchSession([record], "#12345678"), null);
  });

  it("pushes sessions to refs on origin and finds them from another clone", async () => {
    const record = makeRecord({ issueNumber: 42 });
    const dir = sessionDir(work, ".dispatch", record.id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, TRANSCRIPT_FILE), '{"type":"result","subtype":"success"}\n');
    await saveSession(record, work, ".dispatch");

    await pushSessionRef(record, work, ".dispatch");
    assert.ok(git(work, "ls-remote", "origin", `refs/dispatch/sessions/${record.id}`).includes(record.id));
    // Session refs never touch branches
    assert.equal(git(work, "rev-parse", "--abbrev-ref", "HEAD"), "main");
    assert.equal(git(work, "status", "--porcelain", "--untracked-files=no"), "");

    git(root, "clone", "-q", origin, clone);
    const found = await findSession("42", clone, ".dispatch");
    assert.equal(found?.id, record.id);
    const transcript = await readFile(join(sessionDir(clone, ".dispatch", record.id), TRANSCRIPT_FILE), "utf-8");
    assert.ok(transcript.includes('"subtype":"success"'));
  });
});

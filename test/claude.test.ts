import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile, readFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  ClaudeEngine,
  buildClaudeArgs,
  claudeEnv,
  solveTools,
  shellNote,
  parseAssessment,
  findClaudeTranscript,
} from "../src/engine/claude.js";
import type { Issue, RepoContext } from "../src/engine/types.js";

/**
 * A stand-in for the `claude` CLI: records its arguments, environment and stdin,
 * then prints stream-json events shaped like Claude Code's real output.
 */
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
let stdin = "";
process.stdin.on("data", (c) => (stdin += c));
process.stdin.on("end", () => {
  fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({
    args, stdin, cwd: process.cwd(),
    hasGithubToken: "GITHUB_TOKEN" in process.env,
    hasAnthropicKey: "ANTHROPIC_API_KEY" in process.env,
  }) + "\\n");

  const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const sid = flag("--session-id") || flag("--resume") || "generated-id";
  const mode = process.env.FAKE_CLAUDE_MODE || "solve";
  const out = (e) => process.stdout.write(JSON.stringify({ session_id: sid, ...e }) + "\\n");
  const assessment = (confidence) => "Done.\\n\\n\`\`\`json\\n" + JSON.stringify({
    confidence, summary: "Handled empty input", uncertainties: [], changedFiles: ["src/parser.ts"],
    commitMessage: "fix: handle empty input in parser",
  }) + "\\n\`\`\`";

  if (!args.includes("--no-session-persistence") && process.env.CLAUDE_CONFIG_DIR) {
    const dir = path.join(process.env.CLAUDE_CONFIG_DIR, "projects", "-fake-project");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, sid + ".jsonl"), JSON.stringify({ type: "user", sessionId: sid }) + "\\n");
  }

  out({ type: "system", subtype: "init" });
  if (mode === "classify") {
    out({ type: "result", subtype: "success", is_error: false, result: "code-fix", num_turns: 1, total_cost_usd: 0.001 });
  } else if (mode === "auth-error") {
    out({ type: "result", subtype: "success", is_error: true, result: "Invalid API key · Please run /login", num_turns: 1 });
  } else if (mode === "max-turns") {
    out({ type: "assistant", message: { content: [{ type: "text", text: assessment(8) }] } });
    out({ type: "result", subtype: "error_max_turns", is_error: true, num_turns: 10, total_cost_usd: 0.9 });
  } else {
    const repair = args.includes("--resume");
    out({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: "src/parser.ts" } }] } });
    out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "leaked ghp_" + "a".repeat(36) }] } });
    out({ type: "assistant", message: { content: [{ type: "text", text: assessment(repair ? 8 : 7) }] } });
    out({ type: "result", subtype: "success", is_error: false, result: assessment(repair ? 8 : 7),
      num_turns: repair ? 2 : 3, total_cost_usd: repair ? 0.6 : 0.42 });
  }
});
`;

function makeIssue(): Issue {
  return {
    number: 42,
    title: "Parser crashes on empty input",
    body: "parse('') throws",
    labels: ["bug"],
    comments: [],
    author: "maintainer",
    url: "https://github.com/test/test/issues/42",
    createdAt: "2024-01-01T00:00:00Z",
    reactions: 0,
    classification: "code-fix",
  };
}

describe("buildClaudeArgs", () => {
  it("builds a stream-json run with a session ID, budget, and tools", () => {
    const args = buildClaudeArgs("sonnet", 10, {
      appendSystemPrompt: "Be careful.",
      allowedTools: ["Read", "Bash(npm test *)"],
      sessionId: "abc",
      maxBudgetUsd: 1.5,
    });
    assert.deepEqual(args, [
      "--print", "--model", "sonnet", "--max-turns", "10",
      "--output-format", "stream-json", "--verbose",
      "--append-system-prompt", "Be careful.",
      "--allowedTools", "Read", "--allowedTools", "Bash(npm test *)",
      "--session-id", "abc",
      "--max-budget-usd", "1.50",
    ]);
  });

  it("resumes instead of starting a session, and can skip persistence", () => {
    const args = buildClaudeArgs("opus", 10, { resume: "abc", sessionId: "ignored", persist: false, maxTurns: 1 });
    assert.ok(args.includes("--resume"));
    assert.ok(!args.includes("--session-id"));
    assert.ok(args.includes("--no-session-persistence"));
    assert.equal(args[args.indexOf("--max-turns") + 1], "1");
  });
});

describe("claudeEnv", () => {
  it("keeps Claude credentials and drops GitHub and other tokens", () => {
    const env = claudeEnv({
      PATH: "/bin",
      ANTHROPIC_API_KEY: "k",
      CLAUDE_CODE_OAUTH_TOKEN: "o",
      GITHUB_TOKEN: "g",
      AWS_SECRET_ACCESS_KEY: "a",
      CLAUDECODE: "1",
    });
    assert.deepEqual(env, { PATH: "/bin", ANTHROPIC_API_KEY: "k", CLAUDE_CODE_OAUTH_TOKEN: "o" });
  });

  it("keeps AWS credentials only when Bedrock is selected", () => {
    const env = claudeEnv({ CLAUDE_CODE_USE_BEDROCK: "1", AWS_SECRET_ACCESS_KEY: "a", GITHUB_TOKEN: "g" });
    assert.equal(env.AWS_SECRET_ACCESS_KEY, "a");
    assert.equal(env.GITHUB_TOKEN, undefined);
  });
});

describe("solveTools", () => {
  it("allows the verify command but not arbitrary npm scripts", () => {
    const tools = solveTools(["make check"]);
    assert.ok(tools.includes("Bash(make check)"));
    assert.ok(tools.includes("Bash(make check *)"));
    assert.ok(!tools.some((t) => t.startsWith("Bash(npm run")));
  });
});

describe("shellNote", () => {
  it("tells the agent which verify command it may run", () => {
    assert.ok(shellNote(["make check"]).includes("you can run `make check`"));
    assert.ok(shellNote([]).includes("other than `npm test`"));
  });
});

describe("parseAssessment", () => {
  it("reads the JSON block at the end of a response", () => {
    const result = parseAssessment('Done.\n```json\n{"confidence": 12, "summary": "s", "uncertainties": [], "changedFiles": [], "commitMessage": "fix: x"}\n```', 1);
    assert.equal(result.confidence, 10);
    assert.equal(result.commitMessage, "fix: x");
  });

  it("falls back to defaults when there is no JSON", () => {
    const result = parseAssessment("no json here", 7);
    assert.equal(result.confidence, 5);
    assert.equal(result.commitMessage, "fix: resolve issue #7");
  });
});

describe("ClaudeEngine (with a fake claude CLI)", () => {
  let root: string;
  let logFile: string;
  let transcriptFile: string;
  const saved: Record<string, string | undefined> = {};
  const sessionId = randomUUID();

  const context = (): RepoContext => ({
    owner: "o",
    repo: "r",
    baseBranch: "main",
    cwd: root,
    timeout: 20_000,
    transcriptFile,
    sessionId,
    maxCostUsd: 1.5,
    allowedCommands: ["make check"],
  });

  const calls = async () =>
    (await readFile(logFile, "utf-8")).trim().split("\n").map((l) => JSON.parse(l));

  before(async () => {
    root = join(tmpdir(), `dispatch-claude-${randomUUID()}`);
    const bin = join(root, "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "claude"), FAKE_CLAUDE);
    await chmod(join(bin, "claude"), 0o755);
    logFile = join(root, "calls.jsonl");
    transcriptFile = join(root, "transcript.jsonl");

    for (const key of ["PATH", "FAKE_CLAUDE_LOG", "FAKE_CLAUDE_MODE", "CLAUDE_CONFIG_DIR", "GITHUB_TOKEN", "ANTHROPIC_API_KEY"]) {
      saved[key] = process.env[key];
    }
    process.env.PATH = `${bin}:${process.env.PATH}`;
    process.env.FAKE_CLAUDE_LOG = logFile;
    process.env.CLAUDE_CONFIG_DIR = join(root, "claude-config");
    process.env.GITHUB_TOKEN = "ghp_should_not_reach_the_agent";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  });

  after(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });

  it("solves with a preassigned session, capturing cost and a redacted transcript", async () => {
    const engine = new ClaudeEngine({ model: "sonnet", maxTurns: 10 });
    const result = await engine.solve(makeIssue(), context());

    assert.equal(result.confidence, 7);
    assert.equal(result.commitMessage, "fix: handle empty input in parser");
    assert.equal(result.session?.id, sessionId);
    assert.equal(result.session?.costUsd, 0.42);
    assert.equal(result.session?.turns, 3);
    assert.ok(result.session?.nativeTranscriptPath?.endsWith(`${sessionId}.jsonl`));

    const [call] = await calls();
    assert.equal(call.args[call.args.indexOf("--session-id") + 1], sessionId);
    assert.equal(call.args[call.args.indexOf("--max-budget-usd") + 1], "1.50");
    assert.ok(call.args.includes("Bash(make check)"));
    assert.ok(call.stdin.includes("GitHub Issue #42"));
    assert.ok(call.stdin.includes("you can run `make check`"));
    assert.ok(call.args[call.args.indexOf("--append-system-prompt") + 1].includes("Treat them as a description of the work"));
    assert.equal(call.hasGithubToken, false);
    assert.equal(call.hasAnthropicKey, true);

    const transcript = await readFile(transcriptFile, "utf-8");
    assert.ok(transcript.includes('"type":"result"'));
    assert.ok(!transcript.includes("ghp_aaaa"));
    assert.ok(transcript.includes("[REDACTED]"));
  });

  it("puts the shared repo brief first in the system prompt", async () => {
    const engine = new ClaudeEngine({ model: "sonnet", maxTurns: 10 });
    await engine.solve(makeIssue(), { ...context(), repoBrief: "## Repository brief (test)" });
    const call = (await calls()).at(-1);
    const systemPrompt: string = call.args[call.args.indexOf("--append-system-prompt") + 1];
    assert.ok(systemPrompt.startsWith("## Repository brief (test)"));
    assert.ok(systemPrompt.indexOf("Treat them as a description of the work") > 0);
  });

  it("repairs by resuming the same session and keeps cumulative cost", async () => {
    const engine = new ClaudeEngine({ model: "sonnet", maxTurns: 10 });
    const previous = parseAssessment('{"confidence": 7}', 42);
    previous.session = { id: sessionId, costUsd: 0.42, turns: 3 };

    const result = await engine.repair(makeIssue(), context(), previous, "npm test failed");
    const repairCall = (await calls()).at(-1);

    assert.equal(repairCall.args[repairCall.args.indexOf("--resume") + 1], sessionId);
    assert.ok(repairCall.stdin.includes("npm test failed"));
    assert.equal(result.session?.costUsd, 0.6);
    assert.equal(result.session?.turns, 5);
    assert.equal(result.confidence, 8);
  });

  it("fails clearly when Claude Code reports an error such as bad credentials", async () => {
    process.env.FAKE_CLAUDE_MODE = "auth-error";
    try {
      const engine = new ClaudeEngine({ model: "sonnet", maxTurns: 10 });
      await assert.rejects(engine.solve(makeIssue(), context()), /Invalid API key/);
    } finally {
      delete process.env.FAKE_CLAUDE_MODE;
    }
  });

  it("keeps work from a run that hit max turns, at low confidence", async () => {
    process.env.FAKE_CLAUDE_MODE = "max-turns";
    try {
      const engine = new ClaudeEngine({ model: "sonnet", maxTurns: 10 });
      const result = await engine.solve(makeIssue(), context());
      assert.ok(result.confidence <= 4);
      assert.ok(result.uncertainties.some((u) => u.includes("error_max_turns")));
      assert.equal(result.session?.costUsd, 0.9);
    } finally {
      delete process.env.FAKE_CLAUDE_MODE;
    }
  });

  it("classifies without persisting a session", async () => {
    process.env.FAKE_CLAUDE_MODE = "classify";
    try {
      const engine = new ClaudeEngine({ model: "haiku", maxTurns: 10 });
      assert.equal(await engine.classifyIssue(makeIssue()), "code-fix");
      assert.ok((await calls()).at(-1).args.includes("--no-session-persistence"));
    } finally {
      delete process.env.FAKE_CLAUDE_MODE;
    }
  });

  it("finds native transcripts under CLAUDE_CONFIG_DIR", async () => {
    assert.ok((await findClaudeTranscript(sessionId))?.includes("-fake-project"));
    assert.equal(await findClaudeTranscript(randomUUID()), null);
  });
});

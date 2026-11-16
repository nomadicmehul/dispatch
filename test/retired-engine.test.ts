import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type OpenAI from "openai";
import { runAgenticLoop } from "../src/engine/agentic-loop.js";
import { generateWorkflow, type AuthMethod } from "../src/commands/schedule.js";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "dispatch.js");

describe("retired GitHub Models engine", () => {
  let repo: string;

  before(async () => {
    repo = join(tmpdir(), `dispatch-retired-${randomUUID()}`);
    await mkdir(repo, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    execFileSync("git", ["remote", "add", "origin", "https://github.com/example/example.git"], { cwd: repo });
  });

  after(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  const dispatch = (...args: string[]) =>
    spawnSync(process.execPath, [cli, ...args], {
      cwd: repo,
      encoding: "utf-8",
      env: { ...process.env, DISPATCH_NO_TELEMETRY: "1", GITHUB_TOKEN: "" },
    });

  for (const args of [
    ["run", "--dry-run", "--engine", "github-models"],
    ["create", "--no-post", "--engine", "github-models", "anything"],
    ["schedule", "--stdout", "--auth", "github-models"],
  ]) {
    it(`dispatch ${args[0]} explains the retirement and exits 1`, () => {
      const result = dispatch(...args);
      assert.equal(result.status, 1);
      assert.match(result.stdout + result.stderr, /GitHub Models was retired by GitHub on 2026-07-30/);
    });
  }
});

describe("agentic loop", () => {
  it("reports a non-completion response instead of crashing", async () => {
    // What the retired endpoint returns today: HTTP 200, text/plain "OK"
    const client = { chat: { completions: { create: async () => "OK" } } } as unknown as OpenAI;
    await assert.rejects(
      runAgenticLoop({
        client,
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        tools: [],
        toolOptions: { cwd: tmpdir(), timeout: 1000, trackedFiles: new Set() },
        maxTurns: 1,
        timeout: 10_000,
        logPrefix: "test",
      }),
      /Unexpected response from test API \(no completion\): OK/,
    );
  });
});

describe("workflow log upload", () => {
  it("includes the hidden .dispatch folder, without worktrees", () => {
    for (const auth of ["api-key", "claude-code", "gemini"] as AuthMethod[]) {
      const workflow = generateWorkflow("0 2 * * *", 3, false, [], auth);
      assert.match(workflow, /include-hidden-files: true/, auth);
      assert.match(workflow, /!\.dispatch\/worktrees\//, auth);
    }
  });
});

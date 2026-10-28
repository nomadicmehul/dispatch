import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  detectVerifyCommand,
  resolveVerifyCommand,
  runCommand,
  runVerify,
  prepareWorktree,
  verifyFeedback,
} from "../src/orchestrator/verify.js";

describe("verify", () => {
  let dir: string;

  beforeEach(async () => {
    dir = join(tmpdir(), `dispatch-verify-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("detects npm test, but not the npm init placeholder", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
    assert.equal(await detectVerifyCommand(dir), "npm test");

    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
    assert.equal(await detectVerifyCommand(dir), null);
  });

  it("detects Go, Rust, pytest, and make projects", async () => {
    await writeFile(join(dir, "Makefile"), "build:\n\ttrue\ntest:\n\ttrue\n");
    assert.equal(await detectVerifyCommand(dir), "make test");
    await writeFile(join(dir, "pyproject.toml"), "[tool.pytest.ini_options]\n");
    assert.equal(await detectVerifyCommand(dir), "pytest");
    await writeFile(join(dir, "Cargo.toml"), "[package]\n");
    assert.equal(await detectVerifyCommand(dir), "cargo test");
    await writeFile(join(dir, "go.mod"), "module x\n");
    assert.equal(await detectVerifyCommand(dir), "go test ./...");
  });

  it("resolves configured, auto-detected, and disabled commands", async () => {
    await writeFile(join(dir, "go.mod"), "module x\n");
    assert.equal(await resolveVerifyCommand("make check", dir), "make check");
    assert.equal(await resolveVerifyCommand("", dir), "go test ./...");
    assert.equal(await resolveVerifyCommand("none", dir), null);
  });

  it("runs commands without credentials in the environment", async () => {
    process.env.DISPATCH_TEST_TOKEN = "super-secret-value";
    try {
      const result = await runCommand('echo "token=[$DISPATCH_TEST_TOKEN] ci=$CI"', dir, 5000);
      assert.equal(result.exitCode, 0);
      assert.ok(result.output.includes("token=[]"), result.output);
      assert.ok(result.output.includes("ci="));
    } finally {
      delete process.env.DISPATCH_TEST_TOKEN;
    }
  });

  it("reports failures with the output tail", async () => {
    const outcome = await runVerify("echo boom && exit 3", dir, 5000);
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.exitCode, 3);
    assert.ok(outcome.outputTail?.includes("boom"));
    assert.ok(verifyFeedback(outcome).includes("exited with code 3"));
  });

  it("kills commands that time out, including child processes", async () => {
    const outcome = await runVerify("sleep 5 & sleep 5; wait", dir, 300);
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.timedOut, true);
    assert.ok((outcome.durationMs ?? 0) < 3000);
  });

  it("links node_modules into a worktree, or runs the setup command", async () => {
    const repoRoot = join(dir, "repo");
    const worktree = join(dir, "wt");
    await mkdir(join(repoRoot, "node_modules"), { recursive: true });
    await mkdir(worktree, { recursive: true });
    await writeFile(join(worktree, "package.json"), "{}");

    const linked = await prepareWorktree(worktree, repoRoot, "", 5000);
    assert.deepEqual(linked.linked, ["node_modules"]);
    assert.ok((await lstat(join(worktree, "node_modules"))).isSymbolicLink());

    const setup = await prepareWorktree(worktree, repoRoot, "echo installing", 5000);
    assert.deepEqual(setup.linked, []);
    assert.equal(setup.setup?.exitCode, 0);
  });
});

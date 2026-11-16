import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  buildSrtSettings,
  prepareIssueSandbox,
  sandboxPreflight,
  AGENT_DOMAINS,
  REGISTRY_DOMAINS,
} from "../src/sandbox/srt.js";
import { runCommand } from "../src/orchestrator/verify.js";
import { secretsInStagedDiff } from "../src/utils/git.js";
import { createWorktree, removeWorktree } from "../src/utils/worktree.js";
import { claudeEnv } from "../src/engine/claude.js";

describe("srt settings", () => {
  it("deny the home folder and the main checkout, then re-open only what is listed", () => {
    const settings = buildSrtSettings(
      { allowedDomains: ["api.anthropic.com", "api.anthropic.com"], allowRead: ["/w"], allowWrite: ["/w"] },
      "/home/u",
      ["/home/u/repo"],
    );
    assert.deepEqual(settings.filesystem.denyRead, ["/home/u", "/home/u/repo"]);
    assert.deepEqual(settings.filesystem.allowRead, ["/w"]);
    assert.deepEqual(settings.filesystem.allowWrite, ["/w"]);
    assert.deepEqual(settings.network.allowedDomains, ["api.anthropic.com"]);
  });
});

describe("prepareIssueSandbox", () => {
  let root: string;

  before(async () => {
    root = join(tmpdir(), `dispatch-sandbox-${randomUUID()}`);
    await mkdir(join(root, "home", ".nvm"), { recursive: true });
    await mkdir(join(root, "repo", ".dispatch", "worktrees", "issue-1"), { recursive: true });
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("writes an agent and a verify policy and returns launchers for them", async () => {
    const home = join(root, "home");
    const repo = join(root, "repo");
    const worktree = join(repo, ".dispatch", "worktrees", "issue-1");
    const dir = join(repo, ".dispatch", "sandbox", "s1");

    const box = await prepareIssueSandbox({
      options: { srtPath: "srt", extraDomains: ["npm.example.com"] },
      dir,
      worktreePath: worktree,
      repoRoot: repo,
      home,
    });

    const agent = JSON.parse(await readFile(join(dir, "agent.srt.json"), "utf-8"));
    const verify = JSON.parse(await readFile(join(dir, "verify.srt.json"), "utf-8"));

    // Reads: home and the main checkout denied; worktree, toolchains and config re-opened
    assert.deepEqual(agent.filesystem.denyRead, [home, repo]);
    assert.ok(agent.filesystem.allowRead.includes(worktree));
    assert.ok(agent.filesystem.allowRead.includes(join(home, ".nvm")));
    assert.ok(agent.filesystem.allowRead.includes(join(dir, "claude")));
    // Writes: never the home folder or the main checkout
    assert.ok(agent.filesystem.allowWrite.includes(worktree));
    assert.ok(!agent.filesystem.allowWrite.includes(home));
    assert.ok(!agent.filesystem.allowWrite.includes(repo));
    // Claude Code's Bash tool writes its temp files under /tmp/claude-<uid>, not $TMPDIR
    if (process.getuid) {
      assert.ok(agent.filesystem.allowWrite.some((p: string) => p.endsWith(`/claude-${process.getuid!()}`)));
      assert.ok(!agent.filesystem.allowWrite.some((p: string) => p === "/tmp" || p === "/private/tmp"));
    }
    // Network: the agent reaches Claude; verify and setup commands don't
    for (const host of [...AGENT_DOMAINS, ...REGISTRY_DOMAINS, "npm.example.com"]) {
      assert.ok(agent.network.allowedDomains.includes(host), host);
    }
    assert.ok(!verify.network.allowedDomains.includes("api.anthropic.com"));
    assert.ok(!verify.filesystem.allowRead.includes(join(dir, "claude")));

    assert.deepEqual(box.agent.args, ["--settings", join(dir, "agent.srt.json"), "--"]);
    assert.equal(box.agent.env?.CLAUDE_CONFIG_DIR, join(dir, "claude"));
    assert.equal(box.agent.configDir, join(dir, "claude"));
    assert.deepEqual(box.verify.args, ["--settings", join(dir, "verify.srt.json"), "--"]);
    assert.equal(box.record.mode, "srt");
  });
});

describe("sandboxPreflight", () => {
  const env = { PATH: process.env.PATH, CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x" };

  it("accepts a working srt, the claude engine and an env credential", async () => {
    assert.equal(await sandboxPreflight({ srtPath: "true", engine: "claude" }, env), null);
  });

  it("refuses engines that run tools in Dispatch's own process", async () => {
    assert.match((await sandboxPreflight({ srtPath: "true", engine: "gemini" }, env))!, /claude engine only/);
  });

  it("refuses when srt is missing", async () => {
    assert.match((await sandboxPreflight({ srtPath: "srt-does-not-exist", engine: "claude" }, env))!, /sandbox-runtime/);
  });

  it("refuses without a credential in the environment", async () => {
    const reason = await sandboxPreflight({ srtPath: "true", engine: "claude" }, { PATH: process.env.PATH });
    assert.match(reason!, /claude setup-token/);
  });
});

describe("launchers", () => {
  it("run verify and setup commands through the launcher", async () => {
    // `env NAME=value sh -c ...` stands in for `srt --settings x -- sh -c ...`
    const result = await runCommand('printf "%s" "$LAUNCHED"', tmpdir(), 10_000, { command: "env", args: ["LAUNCHED=yes"] });
    assert.equal(result.exitCode, 0);
    assert.equal(result.output, "yes");
  });
});

describe("claudeEnv", () => {
  it("keeps the subscription token but not other CLAUDE_CODE_* secrets", () => {
    const env = claudeEnv({
      CLAUDE_CODE_OAUTH_TOKEN: "keep",
      CLAUDE_CODE_MESSAGING_TOKEN: "drop",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      ANTHROPIC_API_KEY: "keep",
      GITHUB_TOKEN: "drop",
    });
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "keep");
    assert.equal(env.ANTHROPIC_API_KEY, "keep");
    assert.equal(env.CLAUDE_CODE_ENTRYPOINT, "cli");
    assert.equal(env.CLAUDE_CODE_MESSAGING_TOKEN, undefined);
    assert.equal(env.GITHUB_TOKEN, undefined);
  });
});

describe("git repos", () => {
  let root: string;
  let remote: string;
  let repo: string;
  const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();

  before(async () => {
    root = join(tmpdir(), `dispatch-wt-${randomUUID()}`);
    remote = join(root, "remote.git");
    repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    run(root, "init", "-q", "--bare", "-b", "main", remote);
    run(repo, "init", "-q", "-b", "main");
    run(repo, "config", "user.name", "Test");
    run(repo, "config", "user.email", "test@example.com");
    await writeFile(join(repo, "a.txt"), "a\n");
    run(repo, "add", ".");
    run(repo, "commit", "-qm", "base");
    run(repo, "remote", "add", "origin", remote);
    run(repo, "push", "-q", "origin", "main");
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("finds credential values in the staged diff", async () => {
    await writeFile(join(repo, "leak.js"), 'export const t = "sk-ant-oat01-leaked-value";\n');
    run(repo, "add", "leak.js");
    assert.deepEqual(await secretsInStagedDiff(repo, { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-leaked-value", HOME: "/x" }), [
      "CLAUDE_CODE_OAUTH_TOKEN",
    ]);
    assert.deepEqual(await secretsInStagedDiff(repo, { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-other-value" }), []);
    run(repo, "reset", "-q", "HEAD", "leak.js");
    await rm(join(repo, "leak.js"));
  });

  it("creates worktrees in parallel over branches left from an earlier run", async () => {
    // Branches from a previous run, ahead of main, as Dispatch leaves them after opening PRs
    for (const n of [1, 2, 3]) {
      run(repo, "checkout", "-q", "-b", `dispatch/issue-${n}`);
      await writeFile(join(repo, `old-${n}.txt`), "old\n");
      run(repo, "add", ".");
      run(repo, "commit", "-qm", `old ${n}`);
      run(repo, "checkout", "-q", "main");
    }

    await Promise.all([1, 2, 3].map((n) =>
      createWorktree(join(repo, ".dispatch", "worktrees", `issue-${n}`), `dispatch/issue-${n}`, "main", repo)));

    const main = run(repo, "rev-parse", "origin/main");
    for (const n of [1, 2, 3]) {
      assert.equal(run(repo, "rev-parse", `dispatch/issue-${n}`), main, `issue ${n} reset to origin/main`);
    }
  });

  it("refuses to reset a branch checked out in another worktree, and says where", async () => {
    // e.g. a `dispatch resume` worktree that still holds someone's work
    const resumePath = join(repo, ".dispatch", "resume", "issue-7");
    run(repo, "worktree", "add", "-q", "-b", "dispatch/issue-7", resumePath, "origin/main");
    await assert.rejects(
      createWorktree(join(repo, ".dispatch", "worktrees", "issue-7"), "dispatch/issue-7", "main", repo),
      (err: Error) => err.message.includes("is checked out in") && err.message.includes("issue-7"),
    );
    await removeWorktree(resumePath, repo);
  });
});

describe("schedule --sandbox", () => {
  it("installs sandbox-runtime, uses Node 22 and passes --sandbox", async () => {
    const { generateWorkflow, SRT_VERSION } = await import("../src/commands/schedule.js");
    for (const auth of ["api-key", "claude-code"] as const) {
      const workflow = generateWorkflow("0 2 * * *", 3, false, [], auth, undefined, { sandbox: true });
      assert.match(workflow, /node-version: "22"/, auth);
      assert.match(workflow, /apt-get install -y -qq bubblewrap socat ripgrep/, auth);
      assert.match(workflow, /apparmor_parser -R \/etc\/apparmor\.d\/bwrap-userns-restrict/, auth);
      assert.ok(workflow.includes(`@anthropic-ai/sandbox-runtime@${SRT_VERSION}`), auth);
      assert.match(workflow, /--sandbox \\/, auth);
    }
    const plain = generateWorkflow("0 2 * * *", 3, false, [], "api-key");
    assert.doesNotMatch(plain, /sandbox-runtime|--sandbox/);
    assert.match(plain, /node-version: "20"/);
    assert.match(plain, /Allow GitHub Actions to create and approve pull requests/);
  });
});

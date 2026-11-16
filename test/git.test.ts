import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  isSensitivePath,
  stageChanges,
  stagedDiffStats,
  commitStaged,
  listRemoteBranches,
} from "../src/utils/git.js";

describe("isSensitivePath", () => {
  it("flags files that usually hold secrets", () => {
    for (const path of [".env", "config/.env.production", "certs/server.pem", "id_rsa", "secrets.yaml", "deploy/credentials.json", ".npmrc"]) {
      assert.ok(isSensitivePath(path), path);
    }
  });

  it("does not flag source files or env templates", () => {
    for (const path of ["src/reset-password.ts", "src/credentials-form.tsx", ".env.example", ".env.sample", "docs/secrets.md", "keys.ts"]) {
      assert.ok(!isSensitivePath(path), path);
    }
  });
});

describe("staging and committing", () => {
  let root: string;
  let repo: string;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf-8" }).trim();

  before(async () => {
    root = join(tmpdir(), `dispatch-git-${randomUUID()}`);
    repo = join(root, "repo");
    await mkdir(join(repo, "src"), { recursive: true });
    git("init", "-q", "-b", "main");
    await writeFile(join(repo, "src/a.ts"), "export const a = 1;\n");
    git("add", ".");
    git("-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init");
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("stages changes, holds back secrets and excluded paths, and counts lines", async () => {
    await writeFile(join(repo, "src/a.ts"), "export const a = 2;\nexport const b = 3;\n");
    await writeFile(join(repo, "src/reset-password.ts"), "export {};\n");
    await writeFile(join(repo, ".env"), "TOKEN=x\n");
    await mkdir(join(root, "deps"), { recursive: true });
    await symlink(join(root, "deps"), join(repo, "node_modules"), "dir");

    const { staged, heldBack } = await stageChanges(repo, ["node_modules"]);
    assert.deepEqual(staged.sort(), ["src/a.ts", "src/reset-password.ts"]);
    assert.deepEqual(heldBack, [".env"]);

    const stats = await stagedDiffStats(repo);
    assert.deepEqual(stats.files.sort(), ["src/a.ts", "src/reset-password.ts"]);
    assert.equal(stats.additions, 3);
    assert.equal(stats.deletions, 1);
  });

  it("commits with a fallback identity when git has none configured", async () => {
    const emptyConfig = join(root, "empty-gitconfig");
    await writeFile(emptyConfig, "");
    const saved = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM };
    process.env.GIT_CONFIG_GLOBAL = emptyConfig;
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    try {
      const sha = await commitStaged("fix: thing\n\nDispatch-Session: abc", repo);
      assert.match(sha, /^[0-9a-f]{40}$/);
      assert.equal(git("log", "-1", "--format=%an <%ae>"), "dispatch[bot] <dispatch-bot@users.noreply.github.com>");
      assert.ok(git("log", "-1", "--format=%B").includes("Dispatch-Session: abc"));
    } finally {
      if (saved.global === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = saved.global;
      if (saved.nosystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM; else process.env.GIT_CONFIG_NOSYSTEM = saved.nosystem;
    }
  });

  it("lists matching branches on origin", async () => {
    const origin = join(root, "origin.git");
    execFileSync("git", ["init", "--bare", "-q", origin]);
    git("remote", "add", "origin", origin);
    git("push", "-q", "origin", "main", "main:dispatch/issue-5-x", "main:feature/y");

    assert.deepEqual(await listRemoteBranches("dispatch/issue-*", repo), ["dispatch/issue-5-x"]);
  });
});

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile, readFile, chmod, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { commitStaged, pushBranch, remoteAuthEnv } from "../src/utils/git.js";
import {
  overlappingPairs,
  detectOverlaps,
  overlapComment,
  type BranchChange,
} from "../src/orchestrator/overlap.js";
import { siblingPrompt, reportClassification } from "../src/engine/base.js";
import { selectIssues } from "../src/orchestrator/selection.js";
import { assessResult } from "../src/orchestrator/scorer.js";
import { generateWorkflow, type AuthMethod } from "../src/commands/schedule.js";
import type { Issue } from "../src/engine/types.js";

const exists = (path: string) => access(path).then(() => true, () => false);

describe("remoteAuthEnv", () => {
  it("authenticates github.com with GITHUB_TOKEN only inside GitHub Actions", () => {
    assert.deepEqual(remoteAuthEnv({ GITHUB_TOKEN: "ghs_abc" }), {});
    assert.deepEqual(remoteAuthEnv({ GITHUB_ACTIONS: "true" }), {});

    const env = remoteAuthEnv({ GITHUB_ACTIONS: "true", GITHUB_TOKEN: "ghs_abc" });
    assert.equal(env.GIT_CONFIG_COUNT, "2");
    // The first entry resets any header persisted by an older checkout step
    assert.equal(env.GIT_CONFIG_KEY_0, "http.https://github.com/.extraheader");
    assert.equal(env.GIT_CONFIG_VALUE_0, "");
    assert.equal(env.GIT_CONFIG_KEY_1, "http.https://github.com/.extraheader");
    const basic = env.GIT_CONFIG_VALUE_1!.replace("AUTHORIZATION: basic ", "");
    assert.equal(Buffer.from(basic, "base64").toString(), "x-access-token:ghs_abc");
  });
});

describe("git credentials and hooks", () => {
  let root: string;
  let repo: string;
  let remote: string;
  const savedToken = process.env.GITHUB_TOKEN;
  const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();

  before(async () => {
    root = join(tmpdir(), `dispatch-hardening-${randomUUID()}`);
    repo = join(root, "repo");
    remote = join(root, "remote.git");
    await mkdir(repo, { recursive: true });
    run(root, "init", "-q", "--bare", "-b", "main", remote);
    run(repo, "init", "-q", "-b", "main");
    run(repo, "config", "user.name", "Test");
    run(repo, "config", "user.email", "test@example.com");
    run(repo, "remote", "add", "origin", remote);

    // Hooks an agent could have written: record any token they can see, and that they ran
    const hooks = join(repo, ".git", "hooks");
    for (const hook of ["pre-commit", "pre-push"]) {
      await writeFile(
        join(hooks, hook),
        `#!/bin/sh\necho "ran" > "${join(root, `${hook}.ran`)}"\nprintf '%s' "$GITHUB_TOKEN" > "${join(root, `${hook}.token`)}"\n`,
      );
      await chmod(join(hooks, hook), 0o755);
    }
    process.env.GITHUB_TOKEN = "ghp_should_never_reach_a_hook";
  });

  after(async () => {
    if (savedToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = savedToken;
    await rm(root, { recursive: true, force: true });
  });

  it("runs commit hooks without credentials in the environment", async () => {
    await writeFile(join(repo, "a.txt"), "a\n");
    run(repo, "add", "a.txt");
    await commitStaged("first", repo);
    assert.ok(await exists(join(root, "pre-commit.ran")), "the hook should still run");
    assert.equal(await readFile(join(root, "pre-commit.token"), "utf-8"), "");
  });

  it("pushes with hooks disabled", async () => {
    await pushBranch("main", repo);
    assert.equal(await exists(join(root, "pre-push.ran")), false);
    assert.equal(run(remote, "rev-parse", "main"), run(repo, "rev-parse", "HEAD"));
  });
});

describe("overlap detection", () => {
  let repo: string;
  const run = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf-8" }).trim();
  const lines = (n: number, change?: { at: number; text: string }) =>
    Array.from({ length: n }, (_, i) => (change && change.at === i ? change.text : `line ${i}`)).join("\n") + "\n";

  async function branch(name: string, file: string, content: string) {
    run("checkout", "-q", "-b", name, "main");
    await writeFile(join(repo, file), content);
    run("commit", "-qam", name);
    run("checkout", "-q", "main");
  }

  before(async () => {
    repo = join(tmpdir(), `dispatch-overlap-${randomUUID()}`);
    await mkdir(repo, { recursive: true });
    run("init", "-q", "-b", "main");
    run("config", "user.name", "Test");
    run("config", "user.email", "test@example.com");
    await writeFile(join(repo, "lib.js"), lines(20));
    await writeFile(join(repo, "other.js"), "x\n");
    run("add", ".");
    run("commit", "-qm", "base");
    await branch("fix-top", "lib.js", lines(20, { at: 1, text: "top fix A" }));
    await branch("fix-top-too", "lib.js", lines(20, { at: 1, text: "top fix B" }));
    await branch("fix-bottom", "lib.js", lines(20, { at: 18, text: "bottom fix" }));
    await branch("other-file", "other.js", "y\n");
  });

  after(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  const change = (prNumber: number, branchName: string, files: string[]): BranchChange =>
    ({ issueNumber: prNumber - 10, prNumber, branch: branchName, files });

  it("pairs only changes that share files", () => {
    const pairs = overlappingPairs([
      change(11, "fix-top", ["lib.js", "test.js"]),
      change(12, "fix-bottom", ["lib.js"]),
      change(13, "other-file", ["other.js"]),
    ]);
    assert.equal(pairs.length, 1);
    assert.deepEqual(pairs[0].files, ["lib.js"]);
    assert.deepEqual([pairs[0].a.prNumber, pairs[0].b.prNumber], [11, 12]);
  });

  it("tells clean overlaps from conflicting ones", async () => {
    const overlaps = await detectOverlaps([
      change(11, "fix-top", ["lib.js"]),
      change(12, "fix-top-too", ["lib.js"]),
      change(13, "fix-bottom", ["lib.js"]),
    ], repo);
    const verdict = (a: number, b: number) =>
      overlaps.find((o) => o.a.prNumber === a && o.b.prNumber === b)?.conflicts;
    assert.equal(verdict(11, 12), true);
    assert.equal(verdict(11, 13), false);
    assert.equal(verdict(12, 13), false);
    // Detection must not touch the working tree
    assert.equal(run("status", "--porcelain"), "");
  });

  it("writes a PR comment naming the other PR and what to do", async () => {
    const overlaps = await detectOverlaps([change(11, "fix-top", ["lib.js"]), change(12, "fix-top-too", ["lib.js"])], repo);
    const comment = overlapComment(overlaps, 12)!;
    assert.match(comment, /#11 \(issue #1\) also changes `lib\.js`/);
    assert.match(comment, /merge one, then rebase the other/);
    assert.equal(overlapComment(overlaps, 99), undefined);
  });
});

describe("sibling and report prompts", () => {
  it("lists the other issues in the run and warns about documenting their behaviour", () => {
    assert.equal(siblingPrompt([]), undefined);
    assert.equal(siblingPrompt(undefined), undefined);
    const prompt = siblingPrompt([{ number: 1, title: "capitalize() crashes", classification: "code-fix" }])!;
    assert.match(prompt, /- #1 capitalize\(\) crashes \(code-fix\)/);
    assert.match(prompt, /don't present the current behaviour as intended/);
  });

  it("caps long sibling lists", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ number: i + 1, title: `Issue ${i + 1}` }));
    assert.match(siblingPrompt(many)!, /… and 5 more/);
  });

  it("keeps the documentation and audit prompts for report issues", () => {
    assert.equal(reportClassification("documentation"), "documentation");
    assert.equal(reportClassification("audit"), "audit");
    assert.equal(reportClassification("investigation"), "investigation");
    assert.equal(reportClassification("unknown"), "investigation");
    assert.equal(reportClassification(undefined), "investigation");
  });
});

describe("selection with excluded labels", () => {
  const issue = (number: number, labels: string[]): Issue => ({
    number,
    title: "A descriptive issue title here",
    body: "Steps to reproduce: call `parse()` in src/parser.ts. Expected: no crash. ".repeat(4),
    labels,
    comments: [],
    author: "maintainer",
    authorAssociation: "OWNER",
    url: `https://github.com/o/r/issues/${number}`,
    createdAt: "2026-11-16T00:00:00Z",
    reactions: 0,
  });

  it("reports excluded issues instead of dropping them silently", () => {
    const selection = selectIssues([issue(1, ["bug"]), issue(2, ["wontfix", "bug"])], {
      trustedAuthors: ["OWNER"],
      excludeLabels: ["wontfix", "blocked"],
      readyLabel: "dispatch:ready",
      minReadiness: 3,
      maxIssues: 10,
      dispatched: new Set(),
    });
    assert.deepEqual(selection.selected.map((i) => i.number), [1]);
    assert.equal(selection.skipped.length, 1);
    assert.equal(selection.skipped[0].reason, "excluded-label");
    assert.equal(selection.skipped[0].detail, "labelled wontfix");
  });
});

describe("lane reasons", () => {
  it("explains why a passing PR still needs eyes", () => {
    const assessment = assessResult(
      {
        success: true,
        changedFiles: ["src/a.js", "test/a.test.js"],
        summary: "Fixed it",
        confidence: 10,
        uncertainties: ["Behaviour for max < 3 is unchanged"],
        commitMessage: "fix: a",
      },
      { verify: "passed", verifyCommand: "npm test", diff: { files: ["src/a.js", "test/a.test.js"], additions: 6, deletions: 0 }, classification: "code-fix" },
      { draftThreshold: 5, maxDiffLines: 400 },
    );
    assert.equal(assessment.lane, "review");
    const reason = assessment.signals.find((s) => s.label.startsWith("Needs eyes because"));
    assert.ok(reason);
    assert.match(reason.label, /1 open uncertainty: Behaviour for max < 3 is unchanged/);
  });
});

describe("generated workflows", () => {
  it("keep the checkout token out of .git/config for every auth method", () => {
    for (const auth of ["api-key", "claude-code", "github-models", "gemini"] as AuthMethod[]) {
      const workflow = generateWorkflow("0 2 * * *", 3, false, [], auth);
      assert.match(workflow, /persist-credentials: false/, auth);
      assert.match(workflow, /GITHUB_TOKEN: /, auth);
    }
  });
});

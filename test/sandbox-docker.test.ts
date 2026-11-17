import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { hostAllowed, startProxy } from "../src/sandbox/egress-proxy.js";
import { DockerSandbox, containerArgs, DEFAULT_IMAGE } from "../src/sandbox/docker.js";
import { createSandbox } from "../src/sandbox/index.js";
import { applyCliOverrides, ConfigError, DEFAULT_CONFIG } from "../src/utils/config.js";
import { generateWorkflow } from "../src/commands/schedule.js";

describe("egress proxy allowlist", () => {
  const list = ["api.anthropic.com", "*.npmjs.org"];

  it("allows exact names and subdomains of wildcard entries", () => {
    assert.ok(hostAllowed("api.anthropic.com", list));
    assert.ok(hostAllowed("API.Anthropic.com.", list));
    assert.ok(hostAllowed("registry.npmjs.org", list));
  });

  it("refuses everything else, including look-alikes and IP literals", () => {
    for (const host of ["anthropic.com", "evil-api.anthropic.com.example", "npmjs.org.evil.com", "example.com", "1.1.1.1", "[::1]", ""]) {
      assert.equal(hostAllowed(host, list), false, host);
    }
  });
});

describe("egress proxy server", () => {
  let server: http.Server;
  let port: number;

  before(async () => {
    server = startProxy(0, ["api.anthropic.com"], "test");
    await new Promise((r) => server.once("listening", r));
    port = (server.address() as AddressInfo).port;
  });

  after(() => server.close());

  const connect = (target: string) => new Promise<number>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "CONNECT", path: target });
    req.on("connect", (res, socket) => { socket.destroy(); resolve(res.statusCode ?? 0); });
    req.on("error", reject);
    req.end();
  });

  it("answers 403 for hosts and ports outside the allowlist", async () => {
    assert.equal(await connect("example.com:443"), 403);
    assert.equal(await connect("api.anthropic.com:22"), 403);
    assert.equal(await connect("127.0.0.1:443"), 403);
  });

  it("refuses plain HTTP to unlisted hosts", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path: "http://example.com/", method: "GET" }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(status, 403);
  });
});

describe("containerArgs", () => {
  const args = containerArgs({
    network: "dispatch-net-x",
    sessionId: "s1",
    uid: 501,
    gid: 20,
    mounts: [{ path: "/w/wt", readOnly: false }, { path: "/w/node_modules", readOnly: true }],
    workdir: "/w/wt",
    proxy: "http://dispatch-proxy-x:3128",
    env: { CLAUDE_CONFIG_DIR: "/w/cfg" },
    passEnv: ["CLAUDE_CODE_OAUTH_TOKEN"],
    image: "img:1",
  });
  const joined = args.join(" ");

  it("isolates the container", () => {
    assert.match(joined, /--network dispatch-net-x/);
    assert.match(joined, /--cap-drop ALL/);
    assert.match(joined, /--security-opt no-new-privileges/);
    assert.match(joined, /--user 501:20/);
    assert.match(joined, /--label dispatch\.session=s1/);
  });

  it("mounts at the same paths, dependencies read-only", () => {
    assert.ok(args.includes("type=bind,source=/w/wt,target=/w/wt"));
    assert.ok(args.includes("type=bind,source=/w/node_modules,target=/w/node_modules,readonly"));
  });

  it("routes traffic through the proxy and passes secrets by name only", () => {
    assert.ok(args.includes("HTTPS_PROXY=http://dispatch-proxy-x:3128"));
    assert.ok(args.includes("CLAUDE_CONFIG_DIR=/w/cfg"));
    const i = args.indexOf("CLAUDE_CODE_OAUTH_TOKEN");
    assert.ok(i > 0 && args[i - 1] === "-e", "passed as a bare name");
    assert.equal(args.at(-1), "img:1");
  });
});

describe("DockerSandbox", () => {
  let root: string;

  before(async () => {
    root = join(tmpdir(), `dispatch-docker-${randomUUID()}`);
    await mkdir(join(root, "repo", ".dispatch", "worktrees", "issue-1"), { recursive: true });
    await mkdir(join(root, "repo", "node_modules"), { recursive: true });
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function prepare(credentials?: "gateway" | "env") {
    const repo = join(root, "repo");
    const worktree = join(repo, ".dispatch", "worktrees", "issue-1");
    return new DockerSandbox({ credentials }).prepareIssue({
      sessionId: "s1",
      dir: join(repo, ".dispatch", "sandbox", "s1"),
      worktreePath: worktree,
      repoRoot: repo,
      linkedTargets: [join(repo, "node_modules"), join(repo, "missing")],
    });
  }

  it("by default keeps Claude's real credential out of the agent's container (gateway)", async () => {
    const saved = { key: process.env.ANTHROPIC_API_KEY, oauth: process.env.CLAUDE_CODE_OAUTH_TOKEN };
    delete process.env.ANTHROPIC_API_KEY;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-real";
    try {
      const box = await prepare();
      const agent = box.agent.args.join(" ");
      assert.match(agent, /ANTHROPIC_BASE_URL=http:\/\/dispatch-proxy-\w+:3130\/[a-f0-9]{32}/);
      assert.match(agent, /CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-dispatch-sandbox-placeholder/);
      assert.doesNotMatch(agent, /sk-ant-oat01-real/);
      assert.ok(!box.agent.args.some((a, i) => a === "CLAUDE_CODE_OAUTH_TOKEN" && box.agent.args[i - 1] === "-e"), "real token not passed by name");
      assert.match(agent, /NO_PROXY=dispatch-proxy-/);
      assert.equal(box.record.credentials, "gateway");
      assert.ok(box.record.allowedDomains[0].includes("credential gateway"));
      assert.ok(!box.record.allowedDomains.includes("api.anthropic.com"), "no direct route to the API");
    } finally {
      if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved.key;
      if (saved.oauth === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN; else process.env.CLAUDE_CODE_OAUTH_TOKEN = saved.oauth;
    }
  });

  it("with credentials: env, passes the credential by name; verify never gets it", async () => {
    const box = await prepare("env");
    const agent = box.agent.args.join(" ");
    const verify = box.verify.args.join(" ");
    assert.equal(box.agent.command, "docker");
    assert.match(agent, /CLAUDE_CONFIG_DIR=/);
    assert.match(agent, /-e CLAUDE_CODE_OAUTH_TOKEN/);
    assert.doesNotMatch(agent, /ANTHROPIC_BASE_URL/);
    assert.match(agent, /:3128/);
    assert.doesNotMatch(verify, /CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|CLAUDE_CONFIG_DIR|ANTHROPIC_BASE_URL/);
    assert.match(verify, /:3129/);
    // Only paths that exist are mounted (docker refuses missing sources)
    assert.match(agent, /node_modules,readonly/);
    assert.doesNotMatch(agent, /missing/);
    assert.equal(box.agent.args.at(-1), DEFAULT_IMAGE);
    assert.equal(box.record.mode, "docker");
    assert.equal(typeof box.agent.stop, "function");
  });

  it("fails closed without docker, with another engine, or without a credential", async () => {
    const env = { PATH: process.env.PATH, CLAUDE_CODE_OAUTH_TOKEN: "x" };
    assert.match((await new DockerSandbox({ docker: "docker-does-not-exist" }).preflight("claude", env))!, /running Docker daemon/);
    assert.match((await new DockerSandbox({ docker: "true" }).preflight("gemini", env))!, /claude engine only/);
    assert.match((await new DockerSandbox({ docker: "true" }).preflight("claude", { PATH: process.env.PATH }))!, /claude setup-token/);
    assert.equal(await new DockerSandbox({ docker: "true" }).preflight("claude", env), null);
  });
});

describe("choosing a sandbox", () => {
  it("--sandbox picks srt, --sandbox docker picks docker, anything else is an error", () => {
    assert.equal(applyCliOverrides({ ...DEFAULT_CONFIG }, { sandbox: true }).sandbox, "srt");
    assert.equal(applyCliOverrides({ ...DEFAULT_CONFIG }, { sandbox: "docker" }).sandbox, "docker");
    assert.throws(() => applyCliOverrides({ ...DEFAULT_CONFIG }, { sandbox: "vm" }), ConfigError);
    assert.equal(createSandbox({ ...DEFAULT_CONFIG })?.name, undefined);
    assert.equal(createSandbox({ ...DEFAULT_CONFIG, sandbox: "docker" })?.name, "docker");
    assert.equal(createSandbox({ ...DEFAULT_CONFIG, sandbox: "srt" })?.name, "srt");
  });

  it("schedule --sandbox docker needs no install step", () => {
    const workflow = generateWorkflow("0 2 * * *", 3, false, [], "claude-code", undefined, { sandbox: "docker" });
    assert.match(workflow, /--sandbox docker \\/);
    assert.match(workflow, /node-version: "20"/);
    assert.doesNotMatch(workflow, /sandbox-runtime@|bubblewrap/);
  });
});

describe("sandbox evidence", () => {
  it("traces requests to sessions by registered token, and refuses everything else", async () => {
    const { sessionOf } = await import("../src/sandbox/egress-proxy.js");
    const { writeFile } = await import("node:fs/promises");
    const dir = join(tmpdir(), `dispatch-tokens-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    const token = "0123456789abcdef0123456789abcdef";
    await writeFile(join(dir, token), "sess-1");
    const basic = (user: string) => "Basic " + Buffer.from(`${user}:`).toString("base64");
    try {
      assert.equal(sessionOf(basic(token), dir), "sess-1");
      assert.equal(sessionOf(basic("ffffffffffffffffffffffffffffffff"), dir), null, "unknown token");
      assert.equal(sessionOf(basic("sess-1"), dir), null, "a readable ID is not a token");
      assert.equal(sessionOf(basic("../../etc/passwd"), dir), null, "no path tricks");
      assert.equal(sessionOf(undefined, dir), null, "no header");
      assert.equal(sessionOf(undefined), "-", "no token folder: accepted, untraced");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports a session's blocked hosts, and untraced refusals for every session", async () => {
    const { parseBlocked } = await import("../src/sandbox/docker.js");
    const log = [
      "listening agent on 3128: api.anthropic.com",
      "ALLOWED api.anthropic.com:443 (agent) session=sess-1",
      "BLOCKED example.com:443 (agent) session=sess-1",
      "BLOCKED example.com:443 (verify) session=sess-1",
      "BLOCKED evil.test:443 (agent) session=sess-2",
      "BLOCKED other.test:443 (agent) session=-",
    ].join("\n");
    assert.deepEqual(parseBlocked(log, "sess-1"), ["example.com:443", "other.test:443 (untraced)"]);
    assert.deepEqual(parseBlocked(log, "sess-3"), ["other.test:443 (untraced)"]);
    assert.deepEqual(parseBlocked("ALLOWED a:443 (agent) session=sess-1", "sess-1"), []);
  });

  it("answers 407 to clients without a registered session token", async () => {
    const { writeFile } = await import("node:fs/promises");
    const dir = join(tmpdir(), `dispatch-tokens-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    const token = "abcdef0123456789abcdef0123456789";
    await writeFile(join(dir, token), "sess-1");
    const server = startProxy(0, ["example.com"], "test", dir);
    await new Promise((r) => server.once("listening", r));
    const port = (server.address() as AddressInfo).port;
    const connect = (auth?: string) => new Promise<number>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, method: "CONNECT", path: "not-listed.test:443", headers: auth ? { "Proxy-Authorization": auth } : {} });
      req.on("connect", (res, socket) => { socket.destroy(); resolve(res.statusCode ?? 0); });
      req.on("error", reject);
      req.end();
    });
    try {
      assert.equal(await connect(), 407);
      assert.equal(await connect("Basic " + Buffer.from("ffffffffffffffffffffffffffffffff:").toString("base64")), 407);
      assert.equal(await connect("Basic " + Buffer.from(`${token}:`).toString("base64")), 403, "known session, unlisted host");
    } finally {
      server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps a PR that hit blocked hosts out of the ready lane, and says why", async () => {
    const { assessResult } = await import("../src/orchestrator/scorer.js");
    const result = { success: true, changedFiles: ["src/a.js", "test/a.test.js"], summary: "x", confidence: 10, uncertainties: [], commitMessage: "fix: a" };
    const base = { verify: "passed" as const, verifyCommand: "npm test", diff: { files: ["src/a.js", "test/a.test.js"], additions: 5, deletions: 0 }, classification: "code-fix" as const };
    const opts = { draftThreshold: 5, maxDiffLines: 400 };

    const clean = assessResult(result, { ...base, sandbox: { mode: "docker", hosts: 10, blocked: [] } }, opts);
    assert.equal(clean.lane, "ready");
    assert.ok(clean.signals.some((s) => s.ok === true && /docker sandbox: network limited to 10 hosts, nothing blocked/.test(s.label)));

    const blocked = assessResult(result, { ...base, sandbox: { mode: "docker", hosts: 10, blocked: ["example.com:443"] } }, opts);
    assert.equal(blocked.lane, "review");
    assert.ok(blocked.signals.some((s) => s.ok === false && /Tried to reach 1 host outside the sandbox: example\.com:443/.test(s.label)));
    assert.ok(blocked.signals.some((s) => /blocked network access in the sandbox/.test(s.label)));
  });

  it("shows the sandbox in the PR body", async () => {
    const { buildPRBody } = await import("../src/github/pulls.js");
    const issue = { number: 1, title: "t", body: "", labels: [], comments: [], author: "a", url: "u", createdAt: "c", reactions: 0 };
    const result = { success: true, changedFiles: ["a.js"], summary: "s", confidence: 8, uncertainties: [], commitMessage: "fix: a" };
    const body = buildPRBody(issue, result, "", {
      sandbox: { mode: "docker", image: "img:1", allowedDomains: ["api.anthropic.com"], allowRead: [], allowWrite: [], blocked: ["example.com:443"] },
    });
    assert.match(body, /🔒 Sandbox: docker \(<code>img:1<\/code>\), 1 blocked/);
    assert.match(body, /\*\*Blocked:\*\* `example\.com:443`/);
  });
});

describe("dispatch schedule sandbox default", () => {
  it("uses the Docker sandbox for Claude unless --no-sandbox, and none for Gemini", async () => {
    const { spawnSync, execFileSync } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const { dirname } = await import("node:path");
    const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "dispatch.js");
    const repo = join(tmpdir(), `dispatch-sched-${randomUUID()}`);
    await mkdir(repo, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["remote", "add", "origin", "https://github.com/example/example.git"], { cwd: repo });
    const schedule = (...args: string[]) =>
      spawnSync(process.execPath, [cli, "schedule", "--stdout", ...args], { cwd: repo, encoding: "utf-8" }).stdout;
    try {
      assert.match(schedule("--auth", "claude-code"), /--sandbox docker \\/);
      assert.doesNotMatch(schedule("--auth", "claude-code"), /Install Claude Code/);
      assert.doesNotMatch(schedule("--auth", "claude-code", "--no-sandbox"), /--sandbox/);
      assert.match(schedule("--auth", "claude-code", "--sandbox"), /--sandbox \\[\s\S]*sandbox-runtime|sandbox-runtime[\s\S]*--sandbox \\/);
      assert.doesNotMatch(schedule("--auth", "gemini"), /--sandbox/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe("worktree paths", () => {
  it("are unique per session, so a deleted folder is never reused (Docker Desktop caches it as missing)", async () => {
    const { getWorktreePath } = await import("../src/utils/worktree.js");
    const a = getWorktreePath("/r", ".dispatch", 7, "11111111-aaaa");
    const b = getWorktreePath("/r", ".dispatch", 7, "22222222-bbbb");
    assert.equal(a, "/r/.dispatch/worktrees/issue-7-11111111");
    assert.notEqual(a, b);
    assert.equal(getWorktreePath("/r", ".dispatch", 7), "/r/.dispatch/worktrees/issue-7");
  });
});

describe("credential gateway", () => {
  it("swaps the placeholder for the real credential and drops hop-by-hop headers", async () => {
    const { injectCredentials, SENTINEL_API_KEY, SENTINEL_OAUTH_TOKEN } = await import("../src/sandbox/egress-proxy.js");
    const apiKey = injectCredentials({ "x-api-key": SENTINEL_API_KEY, "Content-Type": "application/json", host: "gw", connection: "keep-alive", "proxy-authorization": "Basic x" }, { apiKey: "real-key" });
    assert.equal(apiKey["x-api-key"], "real-key");
    assert.equal(apiKey["content-type"], "application/json");
    assert.equal(apiKey.host, undefined);
    assert.equal(apiKey.connection, undefined);
    assert.equal(apiKey["proxy-authorization"], undefined);
    const oauth = injectCredentials({ Authorization: `Bearer ${SENTINEL_OAUTH_TOKEN}` }, { oauthToken: "real-token" });
    assert.equal(oauth.authorization, "Bearer real-token");
    // No real credential of that kind: the placeholder is removed, never forwarded
    assert.equal(injectCredentials({ "x-api-key": SENTINEL_API_KEY }, { oauthToken: "t" })["x-api-key"], undefined);
  });

  it("refuses requests without a registered session token", async () => {
    const { startGateway } = await import("../src/sandbox/egress-proxy.js");
    const { writeFile } = await import("node:fs/promises");
    const dir = join(tmpdir(), `dispatch-gw-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "0123456789abcdef0123456789abcdef"), "s1");
    const server = startGateway(0, { apiKey: "k" }, dir, "upstream.invalid");
    await new Promise((r) => server.once("listening", r));
    const port = (server.address() as AddressInfo).port;
    const status = (path: string) => new Promise<number>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path, method: "POST" }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on("error", reject);
      req.end();
    });
    try {
      assert.equal(await status("/v1/messages"), 407);
      assert.equal(await status("/ffffffffffffffffffffffffffffffff/v1/messages"), 407);
      // A known session is forwarded; the fake upstream can't be reached, so 502
      assert.equal(await status("/0123456789abcdef0123456789abcdef/v1/messages"), 502);
    } finally {
      server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

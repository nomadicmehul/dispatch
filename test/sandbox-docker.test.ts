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

  it("gives the agent Claude's config and credentials, and verify neither", async () => {
    const repo = join(root, "repo");
    const worktree = join(repo, ".dispatch", "worktrees", "issue-1");
    const box = await new DockerSandbox({}).prepareIssue({
      sessionId: "s1",
      dir: join(repo, ".dispatch", "sandbox", "s1"),
      worktreePath: worktree,
      repoRoot: repo,
      linkedTargets: [join(repo, "node_modules"), join(repo, "missing")],
    });

    const agent = box.agent.args.join(" ");
    const verify = box.verify.args.join(" ");
    assert.equal(box.agent.command, "docker");
    assert.match(agent, /CLAUDE_CONFIG_DIR=/);
    assert.match(agent, /-e CLAUDE_CODE_OAUTH_TOKEN/);
    assert.match(agent, /:3128/);
    assert.doesNotMatch(verify, /CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|CLAUDE_CONFIG_DIR/);
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

import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Launcher } from "../engine/types.js";
import { log } from "../utils/logger.js";
import {
  AGENT_DOMAINS,
  CLAUDE_CREDENTIAL_VARS,
  CREDENTIAL_HINT,
  REGISTRY_DOMAINS,
  type IssueSandbox,
  type PrepareIssueParams,
  type SandboxBackend,
} from "./types.js";

const exec = promisify(execFile);
const exists = (path: string) => access(path).then(() => true, () => false);

/** Only paths that exist: docker refuses to bind-mount a missing source */
async function existing(paths: string[]): Promise<string[]> {
  const found: string[] = [];
  for (const path of paths) if (await exists(path)) found.push(path);
  return found;
}

/**
 * Docker sandbox: each agent session and each setup/verify command runs in its own
 * throwaway container. The container sees only the worktree, the session's Claude config
 * folder and linked dependencies (mounted at the same paths), runs as the calling user with
 * no capabilities, and sits on an internal network whose only way out is an egress proxy
 * that allows listed hosts. On macOS, Docker Desktop also puts a VM between it and the host.
 */

/** Image built on first use when no `dockerImage` is configured */
export const DEFAULT_IMAGE = "dispatch-sandbox:node22";
const PROXY_IMAGE = "node:22-bookworm-slim";
const AGENT_PORT = 3128;
const VERIFY_PORT = 3129;

/** Dockerfile for the default image: Node, git and Claude Code */
export const DEFAULT_DOCKERFILE = `FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \\
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code && npm cache clean --force
`;

export interface DockerOptions {
  /** Image with node (or your toolchain) and the `claude` CLI; empty = build DEFAULT_IMAGE */
  image?: string;
  /** docker binary */
  docker?: string;
  extraDomains?: string[];
  extraRead?: string[];
  extraWrite?: string[];
}

/** `docker run` arguments shared by the agent and verify containers */
export function containerArgs(params: {
  network: string;
  sessionId: string;
  uid?: number;
  gid?: number;
  mounts: Array<{ path: string; readOnly: boolean }>;
  workdir: string;
  proxy: string;
  env: Record<string, string>;
  passEnv: string[];
  image: string;
}): string[] {
  const args = [
    "run", "--rm", "-i", "--init",
    "--network", params.network,
    "--label", `dispatch.session=${params.sessionId}`,
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", "2048",
  ];
  if (params.uid !== undefined && params.gid !== undefined) args.push("--user", `${params.uid}:${params.gid}`);
  for (const mount of params.mounts) {
    args.push("--mount", `type=bind,source=${mount.path},target=${mount.path}${mount.readOnly ? ",readonly" : ""}`);
  }
  args.push("-w", params.workdir);
  const env = {
    HOME: "/tmp",
    CI: "true",
    HTTPS_PROXY: params.proxy,
    HTTP_PROXY: params.proxy,
    https_proxy: params.proxy,
    http_proxy: params.proxy,
    ...params.env,
  };
  for (const [name, value] of Object.entries(env)) args.push("-e", `${name}=${value}`);
  // Names only: docker copies the value from its own environment, so secrets stay off the command line
  for (const name of params.passEnv) args.push("-e", name);
  args.push(params.image);
  return args;
}

/**
 * Blocked `host:port` entries for one session from the proxy's log. Refusals the proxy
 * couldn't trace to a session (no valid token) count for every session, marked as such:
 * any agent in the run may have made them, so none of them should look clean.
 */
export function parseBlocked(log: string, sessionId: string): string[] {
  const hosts = new Set<string>();
  for (const line of log.split("\n")) {
    const match = line.match(/^BLOCKED (\S+) \(\w+\) session=([\w-]+)$/);
    if (!match) continue;
    if (match[2] === sessionId) hosts.add(match[1]);
    else if (match[2] === "-") hosts.add(`${match[1]} (untraced)`);
  }
  return [...hosts];
}

export class DockerSandbox implements SandboxBackend {
  readonly name = "docker" as const;
  private readonly docker: string;
  private readonly runId = randomBytes(4).toString("hex");
  private readonly network = `dispatch-net-${this.runId}`;
  private readonly proxy = `dispatch-proxy-${this.runId}`;
  private image: string;
  private started = false;
  /** Host folder of session tokens, mounted read-only into the proxy */
  private sessionsDir?: string;

  constructor(private readonly options: DockerOptions) {
    this.docker = options.docker || "docker";
    this.image = options.image || DEFAULT_IMAGE;
  }

  private agentDomains(): string[] {
    return [...new Set([...AGENT_DOMAINS, ...REGISTRY_DOMAINS, ...(this.options.extraDomains ?? [])])];
  }

  private verifyDomains(): string[] {
    return [...new Set([...REGISTRY_DOMAINS, ...(this.options.extraDomains ?? [])])];
  }

  private run(args: string[], timeout = 120_000) {
    return exec(this.docker, args, { timeout, maxBuffer: 16 * 1024 * 1024 });
  }

  async preflight(engine: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
    if (engine !== "claude") {
      return `Sandbox mode supports the claude engine only; "${engine}" runs its tools inside Dispatch's own process.`;
    }
    try {
      await this.run(["version", "--format", "{{.Server.Version}}"], 20_000);
    } catch {
      return `The Docker sandbox needs a running Docker daemon ("${this.docker} version" failed). Start Docker, or use --sandbox srt.`;
    }
    if (!CLAUDE_CREDENTIAL_VARS.some((name) => env[name])) return CREDENTIAL_HINT;
    return null;
  }

  /** Build the default image if it isn't there; a configured image must already exist or be pullable */
  private async ensureImage(): Promise<void> {
    try {
      await this.run(["image", "inspect", this.image], 30_000);
      return;
    } catch {
      // not present yet
    }
    if (this.image !== DEFAULT_IMAGE) {
      log.info(`Pulling sandbox image ${this.image}...`);
      await this.run(["pull", this.image], 15 * 60_000);
      return;
    }
    log.info(`Building the sandbox image ${DEFAULT_IMAGE} (once; Node 22, git, Claude Code)...`);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.docker, ["build", "-t", DEFAULT_IMAGE, "-"], { stdio: ["pipe", "ignore", "pipe"] });
      let err = "";
      child.stderr.on("data", (d) => (err = (err + d).slice(-4000)));
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`docker build failed:\n${err}`))));
      child.stdin.end(DEFAULT_DOCKERFILE);
    });
  }

  async start(): Promise<void> {
    await this.ensureImage();

    // An internal network has no route out; the proxy is the only thing on it that has one
    await this.run(["network", "create", "--internal", "--label", "dispatch=sandbox", this.network]);
    this.started = true;

    // Session tokens: the proxy refuses requests without a registered one
    this.sessionsDir = await realpath(await mkdtemp(join(tmpdir(), "dispatch-sessions-")));

    const proxyDir = dirname(fileURLToPath(import.meta.url));
    await this.run([
      "run", "-d", "--rm", "--init",
      "--name", this.proxy,
      "--label", "dispatch=sandbox",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--user", "node",
      "--mount", `type=bind,source=${proxyDir},target=/proxy,readonly`,
      "--mount", `type=bind,source=${this.sessionsDir},target=/sessions,readonly`,
      "-e", "SESSIONS_DIR=/sessions",
      "-e", `AGENT_PORT=${AGENT_PORT}`,
      "-e", `VERIFY_PORT=${VERIFY_PORT}`,
      "-e", `AGENT_DOMAINS=${this.agentDomains().join(",")}`,
      "-e", `VERIFY_DOMAINS=${this.verifyDomains().join(",")}`,
      PROXY_IMAGE, "node", "/proxy/egress-proxy.js",
    ], 10 * 60_000);
    await this.run(["network", "connect", this.network, this.proxy]);

    // Wait until both listeners are up
    for (let i = 0; i < 50; i++) {
      const { stdout } = await this.run(["logs", this.proxy]).catch(() => ({ stdout: "" }));
      if ((stdout.match(/^listening/gm) ?? []).length >= 2) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("The sandbox egress proxy did not start");
  }

  /**
   * Hosts the proxy refused for one session (its agent and its commands). Connections from
   * clients that don't send the session username can't be attributed and are left out.
   */
  async blockedHosts(sessionId: string): Promise<string[]> {
    if (!this.started) return [];
    const { stdout } = await this.run(["logs", this.proxy]).catch(() => ({ stdout: "" }));
    return parseBlocked(stdout, sessionId);
  }

  async prepareIssue(params: PrepareIssueParams): Promise<IssueSandbox> {
    const configDir = join(params.dir, "claude");
    await mkdir(configDir, { recursive: true });

    // An unguessable token per session, registered with the proxy; it never sees other sessions' tokens
    const token = randomBytes(16).toString("hex");
    if (this.sessionsDir) await writeFile(join(this.sessionsDir, token), params.sessionId, { mode: 0o644 });

    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    const gid = typeof process.getgid === "function" ? process.getgid() : undefined;
    const readOnly = await existing([...(params.linkedTargets ?? []), ...(this.options.extraRead ?? [])]);
    const writable = [params.worktreePath, ...(await existing(this.options.extraWrite ?? []))];
    const stop = async () => {
      const { stdout } = await this.run(["ps", "-q", "--filter", `label=dispatch.session=${params.sessionId}`]).catch(() => ({ stdout: "" }));
      const ids = stdout.split("\n").filter(Boolean);
      if (ids.length > 0) await this.run(["kill", ...ids]).catch(() => {});
    };

    const base = {
      network: this.network,
      sessionId: params.sessionId,
      uid,
      gid,
      workdir: params.worktreePath,
      image: this.image,
    };
    const mounts = (extra: string[] = []) => [
      ...writable.map((path) => ({ path, readOnly: false })),
      ...extra.map((path) => ({ path, readOnly: false })),
      ...readOnly.map((path) => ({ path, readOnly: true })),
    ];

    const agent: Launcher = {
      command: this.docker,
      args: containerArgs({
        ...base,
        mounts: mounts([configDir]),
        proxy: `http://${token}@${this.proxy}:${AGENT_PORT}`,
        env: { CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
        passEnv: CLAUDE_CREDENTIAL_VARS,
      }),
      configDir,
      stop,
    };
    const verify: Launcher = {
      command: this.docker,
      args: containerArgs({
        ...base,
        mounts: mounts(),
        proxy: `http://${token}@${this.proxy}:${VERIFY_PORT}`,
        env: {},
        passEnv: [],
      }),
      stop,
    };

    return {
      agent,
      verify,
      record: {
        mode: "docker",
        image: this.image,
        allowedDomains: this.agentDomains(),
        allowRead: [params.worktreePath, configDir, ...readOnly],
        allowWrite: [params.worktreePath, configDir, ...(this.options.extraWrite ?? [])],
      },
    };
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    await this.run(["rm", "-f", this.proxy]).catch(() => {});
    await this.run(["network", "rm", this.network]).catch(() => {});
    if (this.sessionsDir) await rm(this.sessionsDir, { recursive: true, force: true }).catch(() => {});
  }
}

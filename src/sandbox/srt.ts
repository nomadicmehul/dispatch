import { execFile } from "node:child_process";
import { access, mkdir, realpath, writeFile } from "node:fs/promises";
import { homedir, platform, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import type { Launcher } from "../engine/types.js";

const exec = promisify(execFile);

/**
 * Sandboxing with Anthropic's sandbox-runtime (`srt`): the whole agent process and the
 * verify command run inside an OS-level boundary (Seatbelt on macOS, bubblewrap on Linux).
 * Reads are limited to the worktree and toolchains, writes to the worktree, and the network
 * to an allowlist. Claude Code's own sandbox setting covers only its Bash tool; wrapping the
 * process covers its file tools, hooks and MCP servers too.
 */

/** Hosts an agent session needs: the Claude API plus the common package registries */
export const AGENT_DOMAINS = ["api.anthropic.com"];
export const REGISTRY_DOMAINS = [
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "files.pythonhosted.org",
  "proxy.golang.org",
  "sum.golang.org",
  "index.crates.io",
  "static.crates.io",
  "rubygems.org",
];

/** Toolchain folders under $HOME that commands may need to read (only those that exist are used) */
const TOOLCHAIN_DIRS = [
  ".nvm", ".volta", ".fnm", ".local/share/fnm", ".asdf", ".nodenv", ".bun", ".deno",
  ".pyenv", ".rbenv", ".cargo", ".rustup", "go", ".sdkman", ".npm", ".cache/pip", ".cache/yarn",
];

export interface SandboxOptions {
  /** Path or name of the srt binary */
  srtPath: string;
  /** Extra hosts, files and folders allowed by the user's config */
  extraDomains?: string[];
  extraRead?: string[];
  extraWrite?: string[];
}

/** What a sandboxed issue was allowed, for the session record */
export interface SandboxRecord {
  mode: "srt";
  allowedDomains: string[];
  allowRead: string[];
  allowWrite: string[];
}

export interface IssueSandbox {
  /** Runs `claude` inside the agent policy */
  agent: Launcher;
  /** Runs the setup and verify commands inside the verify policy (no Claude API) */
  verify: Launcher;
  record: SandboxRecord;
}

const exists = (path: string) => access(path).then(() => true, () => false);

/** Absolute, symlink-resolved path of an executable on PATH, or null */
export async function resolveExecutable(name: string, envPath = process.env.PATH ?? ""): Promise<string | null> {
  for (const dir of envPath.split(delimiter).filter(Boolean)) {
    const candidate = join(dir, name);
    if (await exists(candidate)) {
      try {
        return await realpath(candidate);
      } catch {
        return candidate;
      }
    }
  }
  return null;
}

/** srt settings JSON for one policy */
export function buildSrtSettings(
  policy: { allowedDomains: string[]; allowRead: string[]; allowWrite: string[] },
  home = homedir(),
  extraDenyRead: string[] = [],
) {
  return {
    network: {
      allowedDomains: [...new Set(policy.allowedDomains)],
      deniedDomains: [],
    },
    filesystem: {
      // Deny the whole home folder (credentials, other projects, ~/.claude) and the main
      // checkout (its .git/config, other worktrees), then re-open only what the session needs
      denyRead: [...new Set([home, ...extraDenyRead])],
      allowRead: [...new Set(policy.allowRead)],
      allowWrite: [...new Set(policy.allowWrite)],
      denyWrite: [],
    },
  };
}

/**
 * Why sandbox mode can't run here, or null when it can. Checked once before any issue
 * is solved, so a misconfigured run fails closed instead of running unsandboxed.
 */
export async function sandboxPreflight(
  options: { srtPath: string; engine: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  if (platform() === "win32") {
    return "Sandbox mode isn't supported on Windows yet. Run Dispatch in WSL2, or without --sandbox.";
  }
  if (options.engine !== "claude") {
    return `Sandbox mode supports the claude engine only; "${options.engine}" runs its tools inside Dispatch's own process.`;
  }
  try {
    await exec(options.srtPath, ["--version"], { env });
  } catch {
    return (
      `Sandbox mode needs Anthropic's sandbox-runtime ("${options.srtPath}" was not found). ` +
      "Install it with: npm install -g @anthropic-ai/sandbox-runtime (needs Node 22.12+)" +
      (platform() === "linux" ? ", plus bubblewrap, socat and ripgrep." : ".")
    );
  }
  if (!env.CLAUDE_CODE_OAUTH_TOKEN && !env.ANTHROPIC_API_KEY) {
    return (
      "Sandbox mode keeps Claude away from your keychain and ~/.claude, so it needs a credential in the environment. " +
      "Run `claude setup-token` and export CLAUDE_CODE_OAUTH_TOKEN (or set ANTHROPIC_API_KEY)."
    );
  }
  return null;
}

/**
 * Claude Code's Bash tool keeps its temp files in /tmp/claude-<uid>/, not in $TMPDIR, so
 * the agent's own test runs fail with EPERM unless that folder is writable. Only this
 * folder is opened, not all of /tmp. It is created first: bubblewrap binds existing paths.
 */
async function claudeTempDir(): Promise<string | undefined> {
  if (platform() === "win32" || typeof process.getuid !== "function") return undefined;
  const root = await realpath("/tmp").catch(() => "/tmp");
  const dir = join(root, `claude-${process.getuid()}`);
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  } catch {
    return undefined;
  }
}

/** Toolchain folders that exist under home */
async function toolchainDirs(home: string): Promise<string[]> {
  const dirs: string[] = [];
  for (const rel of TOOLCHAIN_DIRS) {
    const path = join(home, rel);
    if (await exists(path)) dirs.push(path);
  }
  return dirs;
}

/**
 * Write the agent and verify policies for one issue and return launchers for them.
 * Policy files live outside the worktree, so nothing inside the sandbox can change them.
 */
export async function prepareIssueSandbox(params: {
  options: SandboxOptions;
  /** Folder for this session's sandbox files, e.g. <stateDir>/sandbox/<sessionId> */
  dir: string;
  worktreePath: string;
  /** The main checkout; denied except for the paths re-opened for this session */
  repoRoot?: string;
  /** Paths the worktree links to outside itself, e.g. the main checkout's node_modules */
  linkedTargets?: string[];
  home?: string;
}): Promise<IssueSandbox> {
  const { options, dir, worktreePath } = params;
  const home = params.home ?? homedir();
  const configDir = join(dir, "claude");
  await mkdir(configDir, { recursive: true });

  const tmp = await realpath(tmpdir()).catch(() => tmpdir());
  const claudeTmp = await claudeTempDir();
  const claudeBin = await resolveExecutable("claude");
  const toolchains = await toolchainDirs(home);
  const extraRead = options.extraRead ?? [];
  const extraWrite = options.extraWrite ?? [];
  const domains = options.extraDomains ?? [];

  const commonRead = [
    worktreePath,
    ...(params.linkedTargets ?? []),
    ...toolchains,
    ...(claudeBin ? [dirname(claudeBin)] : []),
    ...extraRead,
    ...extraWrite,
  ];

  const agentPolicy = {
    allowedDomains: [...AGENT_DOMAINS, ...REGISTRY_DOMAINS, ...domains],
    allowRead: [...commonRead, configDir],
    allowWrite: [worktreePath, configDir, tmp, ...(claudeTmp ? [claudeTmp] : []), ...extraWrite],
  };
  const verifyPolicy = {
    allowedDomains: [...REGISTRY_DOMAINS, ...domains],
    allowRead: commonRead,
    allowWrite: [worktreePath, tmp, ...extraWrite],
  };

  const agentSettings = join(dir, "agent.srt.json");
  const verifySettings = join(dir, "verify.srt.json");
  const deny = params.repoRoot ? [params.repoRoot] : [];
  await writeFile(agentSettings, JSON.stringify(buildSrtSettings(agentPolicy, home, deny), null, 2) + "\n");
  await writeFile(verifySettings, JSON.stringify(buildSrtSettings(verifyPolicy, home, deny), null, 2) + "\n");

  return {
    agent: {
      command: options.srtPath,
      args: ["--settings", agentSettings, "--"],
      env: {
        // A fresh Claude config per issue: no user hooks, MCP servers or memory, and
        // nothing written to the real ~/.claude
        CLAUDE_CONFIG_DIR: configDir,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      },
      configDir,
    },
    verify: {
      command: options.srtPath,
      args: ["--settings", verifySettings, "--"],
    },
    record: {
      mode: "srt",
      allowedDomains: [...new Set(agentPolicy.allowedDomains)],
      allowRead: [...new Set(agentPolicy.allowRead)],
      allowWrite: [...new Set(agentPolicy.allowWrite)],
    },
  };
}

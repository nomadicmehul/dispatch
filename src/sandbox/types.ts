import type { Launcher } from "../engine/types.js";

/** What a sandboxed issue was allowed, for the session record */
export interface SandboxRecord {
  mode: "srt" | "docker";
  /** Container image (docker) */
  image?: string;
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

export interface PrepareIssueParams {
  /** Folder for this session's sandbox files, e.g. <stateDir>/sandbox/<sessionId> */
  dir: string;
  sessionId: string;
  worktreePath: string;
  /** The main checkout; never readable from inside */
  repoRoot: string;
  /** Paths the worktree links to outside itself, e.g. the main checkout's node_modules */
  linkedTargets?: string[];
}

/** One way of isolating agent sessions; the pipeline doesn't care which */
export interface SandboxBackend {
  readonly name: "srt" | "docker";
  /** Why this backend can't run here, or null. Checked before any issue is solved (fail closed) */
  preflight(engine: string, env?: NodeJS.ProcessEnv): Promise<string | null>;
  /** Run-wide setup (e.g. image, network, proxy) */
  start(): Promise<void>;
  prepareIssue(params: PrepareIssueParams): Promise<IssueSandbox>;
  /** Run-wide teardown; safe to call more than once */
  stop(): Promise<void>;
}

/** Credentials Claude may get inside a sandbox, and the hint when none is set */
export const CLAUDE_CREDENTIAL_VARS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"];
export const CREDENTIAL_HINT =
  "Sandbox mode keeps Claude away from your keychain and ~/.claude, so it needs a credential in the environment. " +
  "Run `claude setup-token` and export CLAUDE_CODE_OAUTH_TOKEN (or set ANTHROPIC_API_KEY).";

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

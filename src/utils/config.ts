import { readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { log } from "./logger.js";

export interface DispatchConfig {
  /** AI engine to use: "claude" (default), "github-models", "gemini" */
  engine: string;
  /** Model to use with the engine */
  model: string;
  /** Issue labels to include (empty = all open issues) */
  labels: string[];
  /** Issue labels to exclude */
  exclude: string[];
  /** Max issues to process per run */
  maxIssues: number;
  /** Max agentic turns per issue */
  maxTurnsPerIssue: number;
  /** Branch name prefix */
  branchPrefix: string;
  /** Create draft PRs instead of regular PRs */
  createDraftPRs: boolean;
  /** Auto-label issues with classification */
  autoLabel: boolean;
  /** Base branch to create PRs against */
  baseBranch: string;
  /** Confidence threshold below which PRs are created as drafts */
  draftThreshold: number;
  /** Directory for dispatch state/logs */
  stateDir: string;
  /** Timeout per issue solve in milliseconds (default: 10 minutes) */
  timeoutPerIssue: number;
  /** Number of issues to process in parallel (default: 3) */
  concurrency: number;
  /** GitHub author associations whose issues and comments Dispatch acts on */
  trustedAuthors: string[];
  /** Label a maintainer adds to opt an issue in, whoever wrote it */
  readyLabel: string;
  /** Minimum readiness score (0-10) an issue needs before it is dispatched */
  minReadiness: number;
  /** Command that verifies a change, e.g. "npm test". Empty = auto-detect, "none" = skip */
  verifyCommand: string;
  /** Command run in each worktree before solving, e.g. "npm ci". Empty = link node_modules if present */
  setupCommand: string;
  /** When verification still fails after repairs: open a draft PR, or open no PR */
  onVerifyFail: "draft" | "skip";
  /** Repair attempts after a failed verification (engines that support it) */
  repairAttempts: number;
  /** Diffs with more changed lines than this are flagged and opened as drafts */
  maxDiffLines: number;
  /** Spend cap per issue in USD (0 = no cap) */
  maxCostPerIssue: number;
  /** Spend cap per run in USD (0 = no cap) */
  maxCostPerRun: number;
  /** Where session records go: "local" (.dispatch/sessions), "ref" (also pushed to refs/dispatch/sessions/*), or "off" */
  provenance: "local" | "ref" | "off";
  /** Give every agent session a shared brief of the repository (layout, languages, scripts) */
  repoBrief: boolean;
  /** Enable anonymous telemetry (default: true). Set to false to opt out of remote analytics. */
  telemetry: boolean;
  /** PostHog host URL for self-hosted instances (default: https://app.posthog.com) */
  posthogHost: string;
  /** PostHog project API key (write-only). Required for remote telemetry. */
  posthogApiKey: string;
}

const DEFAULT_CONFIG: DispatchConfig = {
  engine: "claude",
  model: "sonnet",
  labels: [],
  exclude: ["wontfix", "blocked", "duplicate"],
  maxIssues: 10,
  maxTurnsPerIssue: 10,
  branchPrefix: "dispatch/",
  createDraftPRs: false,
  autoLabel: true,
  baseBranch: "main",
  draftThreshold: 5,
  stateDir: ".dispatch",
  timeoutPerIssue: 10 * 60 * 1000, // 10 minutes
  concurrency: 3,
  trustedAuthors: ["OWNER", "MEMBER", "COLLABORATOR"],
  readyLabel: "dispatch:ready",
  minReadiness: 3,
  verifyCommand: "",
  setupCommand: "",
  onVerifyFail: "draft",
  repairAttempts: 1,
  maxDiffLines: 400,
  maxCostPerIssue: 0,
  maxCostPerRun: 0,
  provenance: "local",
  repoBrief: true,
  telemetry: true,
  posthogHost: "https://app.posthog.com",
  // Write-only key — safe to embed. Can only send events, not read data.
  posthogApiKey: "phc_eMa9BWwKBhk6BajxBEvHLXPHH2Tjit4waJPxRf3BNwJ",
};

const CONFIG_FILENAME = ".dispatchrc.json";

export async function loadConfig(cwd: string = process.cwd()): Promise<DispatchConfig> {
  const configPath = join(cwd, CONFIG_FILENAME);

  try {
    await access(configPath);
    const raw = await readFile(configPath, "utf-8");
    const fileConfig = JSON.parse(raw) as Partial<DispatchConfig>;
    const config = { ...DEFAULT_CONFIG, ...fileConfig };
    applyEnvOverrides(config);
    return config;
  } catch (err) {
    // Only warn if the file exists but failed to parse (not if it's simply missing)
    if (err instanceof SyntaxError) {
      log.warn(`Could not parse ${CONFIG_FILENAME}: ${err.message}. Using defaults.`);
    }
    const config = { ...DEFAULT_CONFIG };
    applyEnvOverrides(config);
    return config;
  }
}

export async function saveConfig(config: DispatchConfig, cwd: string = process.cwd()): Promise<string> {
  const configPath = join(cwd, CONFIG_FILENAME);
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  return configPath;
}

/** Apply environment variable overrides for sensitive/telemetry config */
function applyEnvOverrides(config: DispatchConfig): void {
  if (process.env.DISPATCH_NO_TELEMETRY === "1") config.telemetry = false;
  if (process.env.POSTHOG_API_KEY) config.posthogApiKey = process.env.POSTHOG_API_KEY;
  if (process.env.POSTHOG_HOST) config.posthogHost = process.env.POSTHOG_HOST;
}

export function applyCliOverrides(config: DispatchConfig, options: Record<string, unknown>): DispatchConfig {
  const merged = { ...config };

  if (options.engine) merged.engine = String(options.engine);
  if (options.model) merged.model = String(options.model);
  if (options.maxIssues) {
    const val = Number(options.maxIssues);
    if (!Number.isFinite(val) || val < 1) {
      log.warn(`Invalid --max-issues "${options.maxIssues}", using default (${config.maxIssues}).`);
    } else {
      merged.maxIssues = Math.floor(val);
    }
  }
  if (options.maxTurns) {
    const val = Number(options.maxTurns);
    if (!Number.isFinite(val) || val < 1) {
      log.warn(`Invalid --max-turns "${options.maxTurns}", using default (${config.maxTurnsPerIssue}).`);
    } else {
      merged.maxTurnsPerIssue = Math.floor(val);
    }
  }
  if (options.label) merged.labels = Array.isArray(options.label) ? options.label : [String(options.label)];
  if (options.exclude) merged.exclude = Array.isArray(options.exclude) ? options.exclude : [String(options.exclude)];
  if (options.draft !== undefined) merged.createDraftPRs = Boolean(options.draft);
  if (options.baseBranch) merged.baseBranch = String(options.baseBranch);
  if (options.noTelemetry) merged.telemetry = false;
  if (options.concurrency) {
    const val = Number(options.concurrency);
    if (!Number.isFinite(val) || val < 1) {
      log.warn(`Invalid --concurrency "${options.concurrency}", using default (${config.concurrency}).`);
    } else {
      merged.concurrency = Math.floor(val);
    }
  }
  if (options.verifyCommand !== undefined) merged.verifyCommand = String(options.verifyCommand);
  if (options.minReadiness !== undefined) {
    const val = Number(options.minReadiness);
    if (!Number.isFinite(val) || val < 0 || val > 10) {
      log.warn(`Invalid --min-readiness "${options.minReadiness}", using default (${config.minReadiness}).`);
    } else {
      merged.minReadiness = val;
    }
  }
  if (options.maxCost !== undefined) {
    const val = Number(options.maxCost);
    if (!Number.isFinite(val) || val < 0) {
      log.warn(`Invalid --max-cost "${options.maxCost}", using default (${config.maxCostPerRun}).`);
    } else {
      merged.maxCostPerRun = val;
    }
  }
  if (options.maxCostPerIssue !== undefined) {
    const val = Number(options.maxCostPerIssue);
    if (!Number.isFinite(val) || val < 0) {
      log.warn(`Invalid --max-cost-per-issue "${options.maxCostPerIssue}", using default (${config.maxCostPerIssue}).`);
    } else {
      merged.maxCostPerIssue = val;
    }
  }
  // Commander defaults --no-repo-brief to true, so only an explicit false overrides the config file
  if (options.repoBrief === false) merged.repoBrief = false;
  if (options.provenance !== undefined) {
    const val = String(options.provenance);
    if (val === "local" || val === "ref" || val === "off") {
      merged.provenance = val;
    } else {
      log.warn(`Invalid --provenance "${val}", using default (${config.provenance}). Use local, ref, or off.`);
    }
  }

  return merged;
}

export { DEFAULT_CONFIG, CONFIG_FILENAME };

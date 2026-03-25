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
  /** AI provider: "anthropic", "gemini", "github-models", "openai" (default: auto-detect) */
  provider: string;
  /** Model routing strategy: "auto" | "provider-locked" | "pinned" (default: "auto") */
  routingStrategy: string;
  /** Enable codebase context caching (Tier 1 memory) */
  enableCodebaseContext: boolean;
  /** Enable cross-issue learning (Tier 2 memory) */
  enableCrossIssue: boolean;
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
  provider: "auto",
  routingStrategy: "auto",
  enableCodebaseContext: true,
  enableCrossIssue: true,
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

  if (options.provider) merged.provider = String(options.provider);
  if (options.strategy) merged.routingStrategy = String(options.strategy);
  if (options.noMemory) {
    merged.enableCodebaseContext = false;
    merged.enableCrossIssue = false;
  }

  return merged;
}

export { DEFAULT_CONFIG, CONFIG_FILENAME };

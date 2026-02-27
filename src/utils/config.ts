import { readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { log } from "./logger.js";

export interface DispatchConfig {
  /** AI engine to use: "claude" (default), "github-models", future: "gemini" */
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
};

const CONFIG_FILENAME = ".dispatchrc.json";

export async function loadConfig(cwd: string = process.cwd()): Promise<DispatchConfig> {
  const configPath = join(cwd, CONFIG_FILENAME);

  try {
    await access(configPath);
    const raw = await readFile(configPath, "utf-8");
    const fileConfig = JSON.parse(raw) as Partial<DispatchConfig>;
    return { ...DEFAULT_CONFIG, ...fileConfig };
  } catch (err) {
    // Only warn if the file exists but failed to parse (not if it's simply missing)
    if (err instanceof SyntaxError) {
      log.warn(`Could not parse ${CONFIG_FILENAME}: ${err.message}. Using defaults.`);
    }
    return { ...DEFAULT_CONFIG };
  }
}

export async function saveConfig(config: DispatchConfig, cwd: string = process.cwd()): Promise<string> {
  const configPath = join(cwd, CONFIG_FILENAME);
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  return configPath;
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
  if (options.concurrency) {
    const val = Number(options.concurrency);
    if (!Number.isFinite(val) || val < 1) {
      log.warn(`Invalid --concurrency "${options.concurrency}", using default (${config.concurrency}).`);
    } else {
      merged.concurrency = Math.floor(val);
    }
  }

  return merged;
}

export { DEFAULT_CONFIG, CONFIG_FILENAME };

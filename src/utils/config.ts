import { readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";

export interface DispatchConfig {
  /** AI engine to use: "claude" (default), future: "gemini", "openai" */
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
  } catch {
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
  if (options.maxIssues) merged.maxIssues = Number(options.maxIssues);
  if (options.maxTurns) merged.maxTurnsPerIssue = Number(options.maxTurns);
  if (options.label) merged.labels = Array.isArray(options.label) ? options.label : [String(options.label)];
  if (options.exclude) merged.exclude = Array.isArray(options.exclude) ? options.exclude : [String(options.exclude)];
  if (options.draft !== undefined) merged.createDraftPRs = Boolean(options.draft);
  if (options.baseBranch) merged.baseBranch = String(options.baseBranch);
  if (options.concurrency) merged.concurrency = Number(options.concurrency);

  return merged;
}

export { DEFAULT_CONFIG, CONFIG_FILENAME };

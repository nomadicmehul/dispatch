import { spawn } from "node:child_process";
import { access, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { scrubEnv } from "../utils/env.js";
import { redactSecrets } from "../provenance/redact.js";

export type VerifyStatus = "passed" | "failed" | "skipped";

export interface VerifyOutcome {
  command?: string;
  status: VerifyStatus;
  exitCode?: number | null;
  durationMs?: number;
  /** Last part of the command output, redacted */
  outputTail?: string;
  timedOut?: boolean;
  /** Repair attempts made after a failure */
  repairs: number;
}

export interface CommandResult {
  exitCode: number | null;
  output: string;
  durationMs: number;
  timedOut: boolean;
}

const OUTPUT_TAIL_CHARS = 3000;
const MAX_CAPTURE_CHARS = 64 * 1024;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Guess the project's test command from its manifest files */
export async function detectVerifyCommand(cwd: string): Promise<string | null> {
  try {
    const pkg = JSON.parse(await readFile(join(cwd, "package.json"), "utf-8")) as {
      scripts?: Record<string, string>;
    };
    const test = pkg.scripts?.test;
    if (test && !/no test specified/.test(test)) return "npm test";
  } catch {
    // no package.json
  }

  if (await exists(join(cwd, "go.mod"))) return "go test ./...";
  if (await exists(join(cwd, "Cargo.toml"))) return "cargo test";
  if (await exists(join(cwd, "pytest.ini"))) return "pytest";

  try {
    const pyproject = await readFile(join(cwd, "pyproject.toml"), "utf-8");
    if (pyproject.includes("[tool.pytest")) return "pytest";
  } catch {
    // no pyproject.toml
  }

  try {
    const makefile = await readFile(join(cwd, "Makefile"), "utf-8");
    if (/^test:/m.test(makefile)) return "make test";
  } catch {
    // no Makefile
  }

  return null;
}

/** The configured verify command, an auto-detected one, or null for "none" */
export async function resolveVerifyCommand(configured: string, cwd: string): Promise<string | null> {
  const value = configured.trim();
  if (value === "none") return null;
  if (value) return value;
  return detectVerifyCommand(cwd);
}

/**
 * Run a shell command with all credentials removed from its environment.
 * Verification runs code the agent just wrote, so it gets no tokens or API keys.
 * The whole process group is killed on timeout, so test runners can't linger.
 */
export function runCommand(command: string, cwd: string, timeoutMs: number): Promise<CommandResult> {
  const start = Date.now();

  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", command], {
      cwd,
      env: { ...scrubEnv(process.env), CI: process.env.CI ?? "true" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    let output = "";
    const capture = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > MAX_CAPTURE_CHARS) output = output.slice(-MAX_CAPTURE_CHARS);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, output, durationMs: Date.now() - start, timedOut });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitCode: null, output: String(err), durationMs: Date.now() - start, timedOut });
    });
  });
}

/** Run the verify command and summarize the outcome */
export async function runVerify(command: string, cwd: string, timeoutMs: number): Promise<VerifyOutcome> {
  const result = await runCommand(command, cwd, timeoutMs);
  return {
    command,
    status: result.exitCode === 0 && !result.timedOut ? "passed" : "failed",
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    outputTail: redactSecrets(result.output.slice(-OUTPUT_TAIL_CHARS)),
    timedOut: result.timedOut,
    repairs: 0,
  };
}

/**
 * Make a fresh worktree runnable: run the setup command if one is configured,
 * otherwise link the main checkout's node_modules so tests can run without a reinstall.
 * Returns paths that must not be committed.
 */
export async function prepareWorktree(
  worktreePath: string,
  repoRoot: string,
  setupCommand: string,
  timeoutMs: number,
): Promise<{ linked: string[]; setup?: CommandResult }> {
  if (setupCommand.trim()) {
    return { linked: [], setup: await runCommand(setupCommand, worktreePath, timeoutMs) };
  }

  const source = join(repoRoot, "node_modules");
  const target = join(worktreePath, "node_modules");
  if ((await exists(join(worktreePath, "package.json"))) && (await exists(source)) && !(await exists(target))) {
    await symlink(source, target, "dir");
    return { linked: ["node_modules"] };
  }

  return { linked: [] };
}

/** Feedback for the agent after a failed verification */
export function verifyFeedback(outcome: VerifyOutcome): string {
  const reason = outcome.timedOut ? "timed out" : `exited with code ${outcome.exitCode}`;
  return `The verification command \`${outcome.command}\` ${reason}. Output (last part):\n\n\`\`\`\n${outcome.outputTail ?? ""}\n\`\`\``;
}

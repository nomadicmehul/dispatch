import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, relative, dirname } from "node:path";
import type { ToolCallRequest, ToolCallResult, ToolExecutorOptions } from "./types.js";

const exec = promisify(execFile);

/** Max characters returned from any single tool call */
const MAX_OUTPUT_CHARS = 50_000;

/** Bash command prefixes that are allowed */
const ALLOWED_COMMANDS = [
  "npm test", "npm run", "npx ",
  "git diff", "git status", "git log", "git show",
  "ls", "find ", "wc ", "cat ", "head ", "tail ",
  "node --version", "npm --version",
];

/** Patterns that are always blocked even in allowed commands */
const BLOCKED_PATTERNS = /[;&|`]|\$\(|\brm\b|\bsudo\b|\bcurl\b|\bwget\b|\bchmod\b|\bchown\b/;

/**
 * Resolve a path safely within the working directory.
 * Throws if the path escapes the cwd.
 */
export function resolveSafePath(inputPath: string, cwd: string): string {
  const resolved = resolve(cwd, inputPath);
  const rel = relative(cwd, resolved);
  if (rel.startsWith("..") || rel.startsWith("/")) {
    throw new Error(`Path escapes working directory: ${inputPath}`);
  }
  return resolved;
}

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return text.substring(0, MAX_OUTPUT_CHARS) + "\n[truncated]";
}

/** Execute a single tool call and return the result */
export async function executeToolCall(
  call: ToolCallRequest,
  options: ToolExecutorOptions,
): Promise<ToolCallResult> {
  try {
    const args = JSON.parse(call.arguments);
    let result: string;

    switch (call.name) {
      case "read_file":
        result = await executeReadFile(args, options);
        break;
      case "write_file":
        result = await executeWriteFile(args, options);
        break;
      case "edit_file":
        result = await executeEditFile(args, options);
        break;
      case "glob_files":
        result = await executeGlob(args, options);
        break;
      case "grep_search":
        result = await executeGrep(args, options);
        break;
      case "bash_command":
        result = await executeBash(args, options);
        break;
      default:
        return { tool_call_id: call.id, content: `Unknown tool: ${call.name}`, is_error: true };
    }

    return { tool_call_id: call.id, content: truncate(result), is_error: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Return error as content so the model can see it and adapt
    return { tool_call_id: call.id, content: `Error: ${msg}`, is_error: false };
  }
}

async function executeReadFile(
  args: { path: string; limit?: number },
  options: ToolExecutorOptions,
): Promise<string> {
  const filePath = resolveSafePath(args.path, options.cwd);
  const content = await readFile(filePath, "utf-8");

  if (args.limit && args.limit > 0) {
    const lines = content.split("\n");
    return lines.slice(0, args.limit).join("\n");
  }

  return content;
}

async function executeWriteFile(
  args: { path: string; content: string },
  options: ToolExecutorOptions,
): Promise<string> {
  const filePath = resolveSafePath(args.path, options.cwd);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, args.content, "utf-8");
  options.trackedFiles.add(args.path);
  return `File written: ${args.path}`;
}

async function executeEditFile(
  args: { path: string; old_text: string; new_text: string },
  options: ToolExecutorOptions,
): Promise<string> {
  const filePath = resolveSafePath(args.path, options.cwd);
  const content = await readFile(filePath, "utf-8");

  if (!content.includes(args.old_text)) {
    return `Error: Could not find the exact text to replace in ${args.path}. Make sure old_text matches exactly (including whitespace and indentation).`;
  }

  const updated = content.replace(args.old_text, args.new_text);
  await writeFile(filePath, updated, "utf-8");
  options.trackedFiles.add(args.path);
  return `File edited: ${args.path}`;
}

async function executeGlob(
  args: { pattern: string },
  options: ToolExecutorOptions,
): Promise<string> {
  // Use find command for cross-platform glob support
  try {
    const { stdout } = await exec(
      "find", [".", "-type", "f", "-name", args.pattern.replace(/\*\*\//g, "")],
      { cwd: options.cwd, timeout: options.timeout, maxBuffer: 1024 * 1024 },
    );
    const files = stdout.trim().split("\n").filter(Boolean).sort();
    if (files.length === 0) return "No files found matching the pattern.";
    return files.join("\n");
  } catch {
    // Fallback: use git ls-files which handles globs better
    try {
      const { stdout } = await exec(
        "git", ["ls-files", args.pattern],
        { cwd: options.cwd, timeout: options.timeout, maxBuffer: 1024 * 1024 },
      );
      const files = stdout.trim().split("\n").filter(Boolean);
      if (files.length === 0) return "No files found matching the pattern.";
      return files.join("\n");
    } catch {
      return "No files found matching the pattern.";
    }
  }
}

async function executeGrep(
  args: { pattern: string; path?: string; include?: string },
  options: ToolExecutorOptions,
): Promise<string> {
  const grepArgs = ["-rn", "--max-count=50"];

  if (args.include) {
    grepArgs.push(`--include=${args.include}`);
  }

  grepArgs.push(args.pattern);
  grepArgs.push(args.path || ".");

  try {
    const { stdout } = await exec("grep", grepArgs, {
      cwd: options.cwd,
      timeout: options.timeout,
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim() || "No matches found.";
  } catch {
    return "No matches found.";
  }
}

async function executeBash(
  args: { command: string },
  options: ToolExecutorOptions,
): Promise<string> {
  const cmd = args.command.trim();

  const isAllowed = ALLOWED_COMMANDS.some((prefix) => cmd.startsWith(prefix));
  if (!isAllowed) {
    return `Command blocked for safety. Allowed prefixes: ${ALLOWED_COMMANDS.join(", ")}`;
  }

  if (BLOCKED_PATTERNS.test(cmd)) {
    return "Command blocked: contains disallowed operators or patterns.";
  }

  try {
    const { stdout, stderr } = await exec("bash", ["-c", cmd], {
      cwd: options.cwd,
      timeout: options.timeout,
      maxBuffer: 5 * 1024 * 1024,
    });

    let output = stdout.trim();
    if (stderr.trim()) {
      output += `\n[stderr] ${stderr.trim()}`;
    }
    return output || "(no output)";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Command failed: ${msg}`;
  }
}

import type OpenAI from "openai";

type Tool = OpenAI.ChatCompletionTool & { type: "function" };

const readFile: Tool = {
  type: "function",
  function: {
    name: "read_file",
    description: "Read the contents of a file. Returns file content as a string.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to the file from the repo root" },
        limit: { type: "number", description: "Max lines to read (default: entire file)" },
      },
      required: ["path"],
    },
  },
};

const writeFile: Tool = {
  type: "function",
  function: {
    name: "write_file",
    description: "Write content to a file, creating it if it doesn't exist or overwriting if it does.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to the file" },
        content: { type: "string", description: "Full content to write" },
      },
      required: ["path", "content"],
    },
  },
};

const editFile: Tool = {
  type: "function",
  function: {
    name: "edit_file",
    description: "Replace an exact string in a file with new content. The old_text must match exactly (including whitespace).",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to the file" },
        old_text: { type: "string", description: "Exact text to find and replace" },
        new_text: { type: "string", description: "Text to replace it with" },
      },
      required: ["path", "old_text", "new_text"],
    },
  },
};

const globFiles: Tool = {
  type: "function",
  function: {
    name: "glob_files",
    description: "Find files matching a glob pattern. Returns list of matching file paths.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern, e.g. 'src/**/*.ts' or '*.json'" },
      },
      required: ["pattern"],
    },
  },
};

const grepSearch: Tool = {
  type: "function",
  function: {
    name: "grep_search",
    description: "Search file contents using a regex pattern. Returns matching lines with file paths and line numbers.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex pattern to search for" },
        path: { type: "string", description: "Directory or file to search in (default: repo root)" },
        include: { type: "string", description: "Glob filter for files, e.g. '*.ts' (optional)" },
      },
      required: ["pattern"],
    },
  },
};

const bashCommand: Tool = {
  type: "function",
  function: {
    name: "bash_command",
    description: "Execute a shell command. Allowed: npm test/run, git diff/status/log/show, ls, find, wc, cat, head, tail, node --version, npm --version. Other commands are blocked.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to execute" },
      },
      required: ["command"],
    },
  },
};

/** All tools available for solving issues */
export const SOLVE_TOOLS: Tool[] = [
  readFile, writeFile, editFile, globFiles, grepSearch, bashCommand,
];

/** Read-only tools for issue creation (no file writes or bash) */
export const READ_ONLY_TOOLS: Tool[] = [
  readFile, globFiles, grepSearch,
];

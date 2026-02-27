/** A tool call request from the model */
export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: string; // JSON string
}

/** Result of executing a tool locally */
export interface ToolCallResult {
  tool_call_id: string;
  content: string;
  is_error: boolean;
}

/** Options for the tool executor */
export interface ToolExecutorOptions {
  /** Working directory for all file operations (worktree path) */
  cwd: string;
  /** Per-command timeout in milliseconds */
  timeout: number;
  /** Accumulates changed file paths for SolveResult */
  trackedFiles: Set<string>;
}

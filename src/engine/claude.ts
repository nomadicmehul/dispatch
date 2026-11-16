import { spawn } from "node:child_process";
import { access, appendFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  AIEngine,
  Issue,
  IssueClassification,
  RepoContext,
  SolveResult,
  StructuredIssue,
} from "./types.js";
import {
  buildIssuePrompt,
  SYSTEM_PROMPTS,
  CONFIDENCE_PROMPT,
  CLASSIFICATION_PROMPT,
  ISSUE_CREATION_PROMPT,
  SECURITY_PROMPT,
  REPAIR_PROMPT,
} from "./base.js";
import { scrubEnv, secretValues } from "../utils/env.js";
import { redactSecrets } from "../provenance/redact.js";
import { describeToolInput } from "../provenance/transcript.js";
import { log } from "../utils/logger.js";

interface ClaudeOptions {
  model: string;
  maxTurns: number;
}

export interface ClaudeRunOptions {
  /** Text appended to Claude Code's default system prompt */
  appendSystemPrompt?: string;
  cwd?: string;
  maxTurns?: number;
  allowedTools?: string[];
  timeout?: number;
  issueLogFile?: string;
  /** Write every stream-json event (redacted) to this JSONL file */
  transcriptFile?: string;
  /** Start a new session with this UUID */
  sessionId?: string;
  /** Continue an existing session (ID or transcript path) */
  resume?: string;
  maxBudgetUsd?: number;
  /** Keep the session on disk so it can be resumed (default: true) */
  persist?: boolean;
}

/** Outcome of one `claude -p` run, taken from its final `result` event */
export interface ClaudeRun {
  text: string;
  sessionId?: string;
  costUsd?: number;
  turns?: number;
  isError: boolean;
  subtype?: string;
}

/** Result subtypes where the agent stopped early but its edits may still be useful */
const EARLY_STOP_SUBTYPES = new Set(["error_max_turns", "error_max_budget_usd"]);

/** Tools the agent may use while solving, plus the project's verify command */
export function solveTools(allowedCommands: string[] = []): string[] {
  const tools = ["Read", "Edit", "Write", "Glob", "Grep", "Bash(npm test)", "Bash(npm test *)"];
  for (const command of allowedCommands) {
    tools.push(`Bash(${command})`, `Bash(${command} *)`);
  }
  return [...new Set(tools)];
}

/** Tells the agent which shell commands it can run, so it doesn't waste turns on denied ones */
export function shellNote(allowedCommands: string[] = []): string {
  const verify = allowedCommands[0];
  if (!verify) {
    return "Shell commands other than `npm test` are not available.";
  }
  return `To check your work you can run \`${verify}\` (append arguments to narrow it down). Other shell commands are not available. After you finish, Dispatch runs \`${verify}\` itself and sends you any failures.`;
}

/**
 * Environment for the Claude Code CLI: everything except credentials, apart from
 * the ones Claude Code itself needs (Anthropic key or OAuth token, cloud provider
 * credentials when Bedrock or Vertex is selected). GITHUB_TOKEN never reaches the agent.
 */
export function claudeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keep = [/^ANTHROPIC_/, /^CLAUDE_CODE_/];
  if (env.CLAUDE_CODE_USE_BEDROCK) keep.push(/^AWS_/);
  if (env.CLAUDE_CODE_USE_VERTEX) keep.push(/^GOOGLE_APPLICATION_CREDENTIALS$/);

  const result = scrubEnv(env, keep);
  delete result.CLAUDECODE; // Allow nested claude calls
  return result;
}

/** Command-line arguments for a `claude -p` run */
export function buildClaudeArgs(model: string, defaultMaxTurns: number, options: ClaudeRunOptions): string[] {
  const args = [
    "--print",
    "--model", model,
    "--max-turns", String(options.maxTurns ?? defaultMaxTurns),
    "--output-format", "stream-json",
    "--verbose",
  ];

  if (options.appendSystemPrompt) {
    args.push("--append-system-prompt", options.appendSystemPrompt);
  }

  for (const tool of options.allowedTools ?? []) {
    args.push("--allowedTools", tool);
  }

  if (options.resume) {
    args.push("--resume", options.resume);
  } else if (options.sessionId) {
    args.push("--session-id", options.sessionId);
  }

  if (options.maxBudgetUsd && options.maxBudgetUsd > 0) {
    args.push("--max-budget-usd", options.maxBudgetUsd.toFixed(2));
  }

  if (options.persist === false) {
    args.push("--no-session-persistence");
  }

  return args;
}

/** Locate Claude Code's own transcript for a session (~/.claude/projects/<project>/<id>.jsonl) */
export async function findClaudeTranscript(
  sessionId: string,
  configDir: string = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
): Promise<string | null> {
  const projects = join(configDir, "projects");
  let dirs: string[];
  try {
    dirs = await readdir(projects);
  } catch {
    return null;
  }

  for (const dir of dirs) {
    const candidate = join(projects, dir, `${sessionId}.jsonl`);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // not in this project
    }
  }
  return null;
}

/** Parse JSON from a response, handling markdown code blocks */
export function parseJSON<T>(text: string): T {
  // Try direct parse first
  try {
    return JSON.parse(text);
  } catch {
    // Try extracting from markdown code block
    const jsonMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[1].trim());
    }

    // Try finding JSON object in the text
    const objectMatch = text.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      return JSON.parse(objectMatch[0]);
    }

    throw new Error(`Could not parse JSON from response: ${text.substring(0, 200)}`);
  }
}

/** Turn the agent's final message into a SolveResult */
export function parseAssessment(text: string, issueNumber: number): SolveResult {
  try {
    const assessment = parseJSON<{
      confidence: number;
      summary: string;
      uncertainties: string[];
      changedFiles: string[];
      commitMessage: string;
    }>(text);

    const rawConfidence = Number(assessment.confidence);
    const confidence = Number.isFinite(rawConfidence)
      ? Math.min(10, Math.max(1, rawConfidence))
      : 5; // Default to medium if AI returns non-numeric confidence

    return {
      success: confidence >= 3,
      changedFiles: assessment.changedFiles || [],
      summary: assessment.summary || "Changes made to resolve the issue.",
      confidence,
      uncertainties: assessment.uncertainties || [],
      commitMessage: assessment.commitMessage || `fix: resolve issue #${issueNumber}`,
    };
  } catch {
    log.warn(`Could not parse assessment, using defaults`);
    return {
      success: true,
      changedFiles: [],
      summary: "Changes made to resolve the issue. Assessment parsing failed.",
      confidence: 5,
      uncertainties: ["Could not self-assess — manual review recommended"],
      commitMessage: `fix: resolve issue #${issueNumber}`,
    };
  }
}

export class ClaudeEngine implements AIEngine {
  readonly name = "claude";
  private model: string;
  private maxTurns: number;

  constructor(options: ClaudeOptions) {
    this.model = options.model;
    this.maxTurns = options.maxTurns;
  }

  /**
   * Run `claude -p` with stream-json output. Each event is written to the transcript
   * as it arrives, so even a run that times out leaves a record of what happened.
   */
  private async runClaude(prompt: string, options: ClaudeRunOptions = {}): Promise<ClaudeRun> {
    const args = buildClaudeArgs(this.model, this.maxTurns, options);
    const timeout = options.timeout ?? 10 * 60 * 1000; // Default 10 min
    const secrets = secretValues();

    log.debug(`Running claude with ${args.length} args in ${options.cwd || "cwd"}`);
    log.debug(`Prompt length: ${prompt.length} chars (via stdin)`);

    const issueLog = (text: string) => {
      if (options.issueLogFile) appendFile(options.issueLogFile, text).catch(() => {});
    };

    if (options.issueLogFile) {
      const header =
        `--- dispatch: claude ${options.resume ? "resume" : "session"} started at ${new Date().toISOString()} ---\n` +
        `--- model: ${this.model} | maxTurns: ${options.maxTurns ?? this.maxTurns} | timeout: ${Math.round(timeout / 1000)}s ---\n\n`;
      if (options.resume) {
        await appendFile(options.issueLogFile, `\n${header}`);
      } else {
        await writeFile(options.issueLogFile, header);
      }
    }

    return new Promise<ClaudeRun>((resolve, reject) => {
      const child = spawn("claude", args, {
        cwd: options.cwd || process.cwd(),
        env: claudeEnv(),
        stdio: ["pipe", "pipe", "pipe"],
      });

      let settled = false;
      let buffer = "";
      let stderrTail = "";
      let sessionId = options.sessionId;
      let finalRun: ClaudeRun | undefined;
      const texts: string[] = [];

      const handleLine = (line: string) => {
        if (!line.trim()) return;
        if (options.transcriptFile) {
          appendFile(options.transcriptFile, redactSecrets(line, secrets) + "\n").catch(() => {});
        }

        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }

        if (typeof event.session_id === "string") sessionId = event.session_id;

        if (event.type === "assistant" && !event.parent_tool_use_id) {
          const content = (event.message as { content?: unknown })?.content;
          for (const block of Array.isArray(content) ? content : []) {
            if (block.type === "tool_use") {
              const line = `[tool] ${block.name} ${describeToolInput(block.input, options.cwd)}`;
              log.debug(`[claude] ${line}`);
              issueLog(`${line}\n`);
            } else if (block.type === "text" && typeof block.text === "string") {
              texts.push(block.text);
              issueLog(`[assistant] ${block.text.substring(0, 500)}\n`);
            }
          }
        }

        if (event.type === "result") {
          finalRun = {
            text: typeof event.result === "string" ? event.result : texts.join("\n"),
            sessionId: typeof event.session_id === "string" ? event.session_id : sessionId,
            costUsd: typeof event.total_cost_usd === "number" ? event.total_cost_usd : undefined,
            turns: typeof event.num_turns === "number" ? event.num_turns : undefined,
            isError: Boolean(event.is_error),
            subtype: typeof event.subtype === "string" ? event.subtype : undefined,
          };
          issueLog(`\n--- result: ${finalRun.subtype} | turns: ${finalRun.turns} | cost: $${finalRun.costUsd?.toFixed(4) ?? "?"} ---\n`);
        }
      };

      child.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          handleLine(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stderrTail = (stderrTail + text).slice(-2000);
        if (text.trim()) log.debug(`[claude] ${text.trim()}`);
        issueLog(text);
      });

      const timer = setTimeout(() => {
        settled = true;
        child.kill("SIGTERM");
        // Give it a moment, then force-kill if still alive
        setTimeout(() => {
          try { child.kill("SIGKILL"); } catch { /* already dead */ }
        }, 5000);
        reject(new Error(`Claude process timed out after ${Math.round(timeout / 1000)}s`));
      }, timeout);

      child.on("close", (code) => {
        clearTimeout(timer);
        if (buffer.trim()) handleLine(buffer);
        if (settled) return;
        settled = true;

        if (finalRun) {
          resolve(finalRun);
        } else if (code === 0) {
          resolve({ text: texts.join("\n"), sessionId, isError: false });
        } else {
          const lastLine = redactSecrets(stderrTail.trim().split("\n").pop() || "", secrets);
          reject(new Error(`Claude process exited with code ${code}${lastLine ? `: ${lastLine}` : ""}`));
        }
      });

      child.on("error", (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        if (err.code === "ENOENT") {
          reject(new Error("Claude Code CLI not found (spawn claude ENOENT). Install it with: npm install -g @anthropic-ai/claude-code"));
        } else {
          reject(err);
        }
      });

      // Write the prompt to stdin and immediately close the stream.
      // Closing stdin signals to `claude --print` that the input is complete.
      child.stdin.write(prompt);
      child.stdin.end();
    });
  }

  /** Convert a finished run into a SolveResult with session metadata */
  private async toSolveResult(run: ClaudeRun, issueNumber: number, fallbackSessionId?: string): Promise<SolveResult> {
    if (run.isError && !EARLY_STOP_SUBTYPES.has(run.subtype ?? "")) {
      throw new Error(`Claude Code reported an error: ${(run.text || run.subtype || "unknown").substring(0, 300)}`);
    }

    const result = parseAssessment(run.text, issueNumber);
    if (run.isError) {
      result.uncertainties.push(`Agent stopped early (${run.subtype}) — the change may be incomplete`);
      result.confidence = Math.min(result.confidence, 4);
    }

    const sessionId = run.sessionId ?? fallbackSessionId;
    result.session = {
      id: sessionId,
      costUsd: run.costUsd,
      turns: run.turns,
      nativeTranscriptPath: sessionId ? (await findClaudeTranscript(sessionId)) ?? undefined : undefined,
    };
    return result;
  }

  async solve(issue: Issue, context: RepoContext): Promise<SolveResult> {
    const classification = issue.classification || "code-fix";
    const issuePrompt = buildIssuePrompt(issue);

    log.info(`Solving #${issue.number} as "${classification}" with Claude (${this.model})...`);

    // Combined solve + self-assess in a single claude call
    const combinedPrompt = `${issuePrompt}

Please solve this issue. When done, DO NOT commit — just make the file changes.

${shellNote(context.allowedCommands)}

After making all changes, output your self-assessment as a JSON block at the very end of your response.
${CONFIDENCE_PROMPT}`;

    // The repo brief goes first: it is identical for every session in a run, so the
    // shared prefix gives the prompt cache more to reuse
    const systemParts = [context.repoBrief, SECURITY_PROMPT, SYSTEM_PROMPTS[classification]].filter(Boolean);

    const run = await this.runClaude(combinedPrompt, {
      appendSystemPrompt: systemParts.join("\n\n"),
      cwd: context.cwd,
      maxTurns: this.maxTurns,
      timeout: context.timeout,
      issueLogFile: context.issueLogFile,
      transcriptFile: context.transcriptFile,
      sessionId: context.sessionId,
      maxBudgetUsd: context.maxCostUsd,
      allowedTools: solveTools(context.allowedCommands),
    });

    return this.toSolveResult(run, issue.number, context.sessionId);
  }

  async investigate(issue: Issue, context: RepoContext): Promise<SolveResult> {
    // Investigation uses the same flow but with investigation system prompt
    const investigationIssue: Issue = { ...issue, classification: "investigation" as IssueClassification };
    return this.solve(investigationIssue, context);
  }

  /** Resume the solve session with verification feedback */
  async repair(issue: Issue, context: RepoContext, previous: SolveResult, feedback: string): Promise<SolveResult> {
    const sessionId = previous.session?.id;
    if (!sessionId) {
      throw new Error("Cannot repair: the previous run has no Claude session ID");
    }

    log.info(`Repairing #${issue.number} in session ${sessionId.substring(0, 8)}...`);

    const prompt = `${REPAIR_PROMPT.replace("{feedback}", () => feedback)}\n${CONFIDENCE_PROMPT}`;
    const run = await this.runClaude(prompt, {
      cwd: context.cwd,
      maxTurns: this.maxTurns,
      timeout: context.timeout,
      issueLogFile: context.issueLogFile,
      transcriptFile: context.transcriptFile,
      resume: sessionId,
      maxBudgetUsd: context.maxCostUsd,
      allowedTools: solveTools(context.allowedCommands),
    });

    const result = await this.toSolveResult(run, issue.number, sessionId);

    // A resumed run reports the session's cumulative cost; older CLIs report only the new run
    const session = result.session!;
    const previousCost = previous.session?.costUsd ?? 0;
    if (session.costUsd !== undefined && session.costUsd < previousCost) {
      session.costUsd += previousCost;
    }
    if (session.turns !== undefined) {
      session.turns += previous.session?.turns ?? 0;
    }
    return result;
  }

  async createIssue(description: string, context: RepoContext): Promise<StructuredIssue> {
    const prompt = ISSUE_CREATION_PROMPT.replace("{description}", () => description);

    const run = await this.runClaude(prompt, {
      cwd: context.cwd,
      maxTurns: 3,
      allowedTools: ["Read", "Glob", "Grep"],
      persist: false,
    });

    return parseJSON<StructuredIssue>(run.text);
  }

  async classifyIssue(issue: Issue): Promise<IssueClassification> {
    const prompt = CLASSIFICATION_PROMPT
      .replace("{title}", () => issue.title)
      .replace("{body}", () => (issue.body || "").substring(0, 500));

    const run = await this.runClaude(prompt, {
      maxTurns: 1,
      allowedTools: [],
      timeout: 30 * 1000, // 30s — classification is a single-turn task
      persist: false,
    });

    const classification = run.text.trim().toLowerCase().replace(/[^a-z-]/g, "");

    const valid: IssueClassification[] = [
      "code-fix", "feature", "investigation", "documentation", "audit", "refactor",
    ];

    if (valid.includes(classification as IssueClassification)) {
      return classification as IssueClassification;
    }

    // Fuzzy matching
    if (classification.includes("fix") || classification.includes("bug")) return "code-fix";
    if (classification.includes("feat") || classification.includes("enhance")) return "feature";
    if (classification.includes("invest") || classification.includes("research")) return "investigation";
    if (classification.includes("doc")) return "documentation";
    if (classification.includes("audit") || classification.includes("review")) return "audit";
    if (classification.includes("refact")) return "refactor";

    return "unknown";
  }

  async scoreConfidence(
    issue: Issue,
    changedFiles: string[]
  ): Promise<{ score: number; uncertainties: string[] }> {
    // Confidence is scored during solve() via self-assessment, then adjusted with evidence
    // by the orchestrator (see assessResult). This method exists for re-scoring if needed.
    return { score: 5, uncertainties: ["Re-scoring not yet implemented"] };
  }

  /** Find this engine's native transcript for a session, e.g. after a timeout */
  async locateTranscript(sessionId: string): Promise<string | null> {
    return findClaudeTranscript(sessionId);
  }
}

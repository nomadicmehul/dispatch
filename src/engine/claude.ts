import { spawn } from "node:child_process";
import { appendFile, writeFile } from "node:fs/promises";
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
} from "./base.js";
import { log } from "../utils/logger.js";

interface ClaudeOptions {
  model: string;
  maxTurns: number;
}

export class ClaudeEngine implements AIEngine {
  readonly name = "claude";
  private model: string;
  private maxTurns: number;

  constructor(options: ClaudeOptions) {
    this.model = options.model;
    this.maxTurns = options.maxTurns;
  }

  /** Run claude CLI in print mode with streaming stderr output */
  private async runClaude(
    prompt: string,
    options: {
      systemPrompt?: string;
      cwd?: string;
      maxTurns?: number;
      allowedTools?: string[];
      outputFormat?: "text" | "json";
      timeout?: number;
      issueLogFile?: string;
    } = {}
  ): Promise<string> {
    const args: string[] = [
      "--print",
      "--model", this.model,
      "--max-turns", String(options.maxTurns ?? this.maxTurns),
      "--output-format", options.outputFormat ?? "text",
    ];

    if (options.systemPrompt) {
      args.push("--system-prompt", options.systemPrompt);
    }

    if (options.allowedTools && options.allowedTools.length > 0) {
      for (const tool of options.allowedTools) {
        args.push("--allowedTools", tool);
      }
    }

    // Always send the prompt via stdin. The `claude` CLI in --print mode
    // reliably reads from stdin, and this avoids issues with:
    //  - Shell/OS argument length limits on large prompts
    //  - Special characters in prompts confusing argument parsing
    //  - Positional arg placement issues with Commander.js

    log.debug(`Running claude with ${args.length} args in ${options.cwd || "cwd"}`);
    log.debug(`Prompt length: ${prompt.length} chars (via stdin)`);

    const timeout = options.timeout ?? 10 * 60 * 1000; // Default 10 min

    // Create issue log file upfront so it's visible immediately
    if (options.issueLogFile) {
      await writeFile(
        options.issueLogFile,
        `--- dispatch: claude subprocess started at ${new Date().toISOString()} ---\n` +
        `--- model: ${this.model} | maxTurns: ${options.maxTurns ?? this.maxTurns} | timeout: ${Math.round(timeout / 1000)}s ---\n` +
        `--- prompt length: ${prompt.length} chars (via stdin) ---\n\n`,
      );
    }

    return new Promise<string>((resolve, reject) => {
      const env = { ...process.env };
      delete env.CLAUDECODE; // Allow nested claude calls

      const child = spawn("claude", args, {
        cwd: options.cwd || process.cwd(),
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      const stdoutChunks: Buffer[] = [];

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutChunks.push(chunk);
      });

      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString().trim();
        if (text) {
          log.debug(`[claude] ${text}`);
        }
        if (options.issueLogFile) {
          appendFile(options.issueLogFile, chunk.toString()).catch(() => {});
        }
      });

      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        // Give it a moment, then force-kill if still alive
        setTimeout(() => {
          try { child.kill("SIGKILL"); } catch { /* already dead */ }
        }, 5000);
        reject(new Error(`Claude process timed out after ${Math.round(timeout / 1000)}s`));
      }, timeout);

      child.on("close", (code) => {
        clearTimeout(timer);
        const stdout = Buffer.concat(stdoutChunks).toString().trim();

        if (options.issueLogFile && stdout) {
          appendFile(options.issueLogFile, `\n--- stdout ---\n${stdout}\n`).catch(() => {});
        }

        if (code !== 0 && !stdout) {
          reject(new Error(`Claude process exited with code ${code}`));
        } else {
          resolve(stdout);
        }
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });

      // Write the prompt to stdin and immediately close the stream.
      // Closing stdin signals to `claude --print` that the input is complete.
      child.stdin.write(prompt);
      child.stdin.end();
    });
  }

  /** Parse JSON from claude's response, handling markdown code blocks */
  private parseJSON<T>(text: string): T {
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

  async solve(issue: Issue, context: RepoContext): Promise<SolveResult> {
    const classification = issue.classification || "code-fix";
    const systemPrompt = SYSTEM_PROMPTS[classification];
    const issuePrompt = buildIssuePrompt(issue);

    log.info(`Solving #${issue.number} as "${classification}" with Claude (${this.model})...`);

    // Combined solve + self-assess in a single claude call
    const combinedPrompt = `${issuePrompt}

Please solve this issue. When done, DO NOT commit — just make the file changes.

After making all changes, output your self-assessment as a JSON block at the very end of your response.
${CONFIDENCE_PROMPT}`;

    const result = await this.runClaude(combinedPrompt, {
      systemPrompt,
      cwd: context.cwd,
      maxTurns: this.maxTurns,
      timeout: context.timeout,
      issueLogFile: context.issueLogFile,
      allowedTools: [
        "Read", "Edit", "Write", "Glob", "Grep",
        "Bash(npm test *)", "Bash(npm run *)",
      ],
    });

    try {
      const assessment = this.parseJSON<{
        confidence: number;
        summary: string;
        uncertainties: string[];
        changedFiles: string[];
        commitMessage: string;
      }>(result);

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
        commitMessage: assessment.commitMessage || `fix: resolve issue #${issue.number}`,
      };
    } catch (err) {
      log.warn(`Could not parse assessment, using defaults`);
      return {
        success: true,
        changedFiles: [],
        summary: "Changes made to resolve the issue. Assessment parsing failed.",
        confidence: 5,
        uncertainties: ["Could not self-assess — manual review recommended"],
        commitMessage: `fix: resolve issue #${issue.number}`,
      };
    }
  }

  async investigate(issue: Issue, context: RepoContext): Promise<SolveResult> {
    // Investigation uses the same flow but with investigation system prompt
    const investigationIssue: Issue = { ...issue, classification: "investigation" as IssueClassification };
    return this.solve(investigationIssue, context);
  }

  async createIssue(description: string, context: RepoContext): Promise<StructuredIssue> {
    const prompt = ISSUE_CREATION_PROMPT.replace("{description}", () => description);

    const result = await this.runClaude(prompt, {
      cwd: context.cwd,
      maxTurns: 1,
      allowedTools: ["Read", "Glob", "Grep"],
    });

    return this.parseJSON<StructuredIssue>(result);
  }

  async classifyIssue(issue: Issue): Promise<IssueClassification> {
    const prompt = CLASSIFICATION_PROMPT
      .replace("{title}", () => issue.title)
      .replace("{body}", () => (issue.body || "").substring(0, 500));

    const result = await this.runClaude(prompt, {
      maxTurns: 1,
      allowedTools: [],
      timeout: 30 * 1000, // 30s — classification is a single-turn task
    });

    const classification = result.trim().toLowerCase().replace(/[^a-z-]/g, "");

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
    // Confidence is already scored during solve() via self-assessment
    // This method exists for re-scoring if needed
    return { score: 5, uncertainties: ["Re-scoring not yet implemented"] };
  }
}

import OpenAI from "openai";
import { writeFile } from "node:fs/promises";
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
import { SOLVE_TOOLS, READ_ONLY_TOOLS } from "./tools/definitions.js";
import { runAgenticLoop } from "./agentic-loop.js";
import { log } from "../utils/logger.js";

interface OpenAIOptions {
  model: string;
  maxTurns: number;
}

export class OpenAIEngine implements AIEngine {
  readonly name = "openai";
  private client: OpenAI;
  private model: string;
  private maxTurns: number;

  constructor(options: OpenAIOptions) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "OPENAI_API_KEY is required for the openai engine. " +
        "Get an API key at: https://platform.openai.com/api-keys"
      );
    }

    this.client = new OpenAI({
      baseURL: "https://api.openai.com/v1",
      apiKey,
    });

    this.model = options.model;
    this.maxTurns = options.maxTurns;
  }

  /** Parse JSON from a model response, handling markdown code blocks */
  private parseJSON<T>(text: string): T {
    try {
      return JSON.parse(text);
    } catch {
      const jsonMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[1].trim());
      }

      const objectMatch = text.match(/\{[\s\S]*\}/);
      if (objectMatch) {
        return JSON.parse(objectMatch[0]);
      }

      throw new Error(`Could not parse JSON from response: ${text.substring(0, 200)}`);
    }
  }

  /** Parse the self-assessment JSON from a solve response */
  private parseAssessment(
    text: string,
    trackedFiles: string[],
    issueNumber: number,
  ): SolveResult {
    try {
      const assessment = this.parseJSON<{
        confidence: number;
        summary: string;
        uncertainties: string[];
        changedFiles: string[];
        commitMessage: string;
      }>(text);

      const rawConfidence = Number(assessment.confidence);
      const confidence = Number.isFinite(rawConfidence)
        ? Math.min(10, Math.max(1, rawConfidence))
        : 5;

      const allFiles = [...new Set([
        ...(assessment.changedFiles || []),
        ...trackedFiles,
      ])];

      return {
        success: confidence >= 3,
        changedFiles: allFiles,
        summary: assessment.summary || "Changes made to resolve the issue.",
        confidence,
        uncertainties: assessment.uncertainties || [],
        commitMessage: assessment.commitMessage || `fix: resolve issue #${issueNumber}`,
      };
    } catch {
      log.warn("Could not parse assessment from OpenAI response, using defaults");
      return {
        success: true,
        changedFiles: trackedFiles,
        summary: "Changes made to resolve the issue. Assessment parsing failed.",
        confidence: 5,
        uncertainties: ["Could not self-assess — manual review recommended"],
        commitMessage: `fix: resolve issue #${issueNumber}`,
      };
    }
  }

  async solve(issue: Issue, context: RepoContext): Promise<SolveResult> {
    const classification = issue.classification || "code-fix";
    const systemPrompt = SYSTEM_PROMPTS[classification];
    const issuePrompt = buildIssuePrompt(issue, {
      codebaseContext: context.codebaseContext,
      crossIssueInsights: context.crossIssueInsights,
    });

    log.info(`Solving #${issue.number} as "${classification}" with OpenAI (${this.model})...`);

    const combinedPrompt = `${issuePrompt}

Please solve this issue. When done, DO NOT commit — just make the file changes.

After making all changes, output your self-assessment as a JSON block at the very end of your response.
${CONFIDENCE_PROMPT}`;

    const timeout = context.timeout ?? 10 * 60 * 1000;

    if (context.issueLogFile) {
      await writeFile(
        context.issueLogFile,
        `--- dispatch: openai engine started at ${new Date().toISOString()} ---\n` +
        `--- model: ${this.model} | maxTurns: ${this.maxTurns} | timeout: ${Math.round(timeout / 1000)}s ---\n\n`,
      );
    }

    const result = await runAgenticLoop({
      client: this.client,
      model: this.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: combinedPrompt },
      ],
      tools: SOLVE_TOOLS,
      toolOptions: {
        cwd: context.cwd,
        timeout: 30_000,
        trackedFiles: new Set<string>(),
      },
      maxTurns: this.maxTurns,
      timeout,
      issueLogFile: context.issueLogFile,
      logPrefix: "openai",
    });

    log.debug(`[openai] Completed in ${result.totalTurns} turns`);
    return this.parseAssessment(result.finalContent, result.changedFiles, issue.number);
  }

  async investigate(issue: Issue, context: RepoContext): Promise<SolveResult> {
    const investigationIssue: Issue = { ...issue, classification: "investigation" as IssueClassification };
    return this.solve(investigationIssue, context);
  }

  async createIssue(description: string, context: RepoContext): Promise<StructuredIssue> {
    const prompt = ISSUE_CREATION_PROMPT.replace("{description}", () => description);

    const result = await runAgenticLoop({
      client: this.client,
      model: this.model,
      messages: [{ role: "user", content: prompt }],
      tools: READ_ONLY_TOOLS,
      toolOptions: {
        cwd: context.cwd,
        timeout: 15_000,
        trackedFiles: new Set<string>(),
      },
      maxTurns: 3,
      timeout: 60_000,
      logPrefix: "openai",
    });

    return this.parseJSON<StructuredIssue>(result.finalContent);
  }

  async classifyIssue(issue: Issue): Promise<IssueClassification> {
    const prompt = CLASSIFICATION_PROMPT
      .replace("{title}", () => issue.title)
      .replace("{body}", () => (issue.body || "").substring(0, 500));

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: 50,
    });

    const text = response.choices[0]?.message?.content?.trim().toLowerCase().replace(/[^a-z-]/g, "") || "";

    const valid: IssueClassification[] = [
      "code-fix", "feature", "investigation", "documentation", "audit", "refactor",
    ];

    if (valid.includes(text as IssueClassification)) {
      return text as IssueClassification;
    }

    if (text.includes("fix") || text.includes("bug")) return "code-fix";
    if (text.includes("feat") || text.includes("enhance")) return "feature";
    if (text.includes("invest") || text.includes("research")) return "investigation";
    if (text.includes("doc")) return "documentation";
    if (text.includes("audit") || text.includes("review")) return "audit";
    if (text.includes("refact")) return "refactor";

    return "unknown";
  }

  async scoreConfidence(
    issue: Issue,
    changedFiles: string[],
  ): Promise<{ score: number; uncertainties: string[] }> {
    const prompt = `Review this issue and the files that were changed. Rate the likelihood the changes correctly solve the issue.

Issue: #${issue.number} — ${issue.title}
${issue.body ? issue.body.substring(0, 500) : "No description"}

Changed files: ${changedFiles.join(", ")}

Respond in JSON only: { "score": <1-10>, "uncertainties": ["..."] }`;

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
        max_tokens: 200,
      });
      const text = response.choices[0]?.message?.content || "";
      const parsed = this.parseJSON<{ score: number; uncertainties: string[] }>(text);
      return {
        score: Math.min(10, Math.max(1, Number(parsed.score) || 5)),
        uncertainties: parsed.uncertainties || [],
      };
    } catch {
      return { score: 5, uncertainties: ["Scoring failed — manual review recommended"] };
    }
  }
}

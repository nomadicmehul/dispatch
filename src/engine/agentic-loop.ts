import type OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { appendFile } from "node:fs/promises";
import { executeToolCall } from "./tools/executor.js";
import type { ToolExecutorOptions } from "./tools/types.js";
import { log } from "../utils/logger.js";

export interface AgenticLoopOptions {
  client: OpenAI;
  model: string;
  messages: ChatCompletionMessageParam[];
  tools: OpenAI.ChatCompletionTool[];
  toolOptions: ToolExecutorOptions;
  maxTurns: number;
  timeout: number;
  issueLogFile?: string;
  /** Log prefix for debug messages (default: "agentic") */
  logPrefix?: string;
}

export interface AgenticLoopResult {
  /** The last text response from the model */
  finalContent: string;
  /** Total API round-trips used */
  totalTurns: number;
  /** Files that were written or edited */
  changedFiles: string[];
}

/**
 * Multi-turn agentic loop for OpenAI-compatible APIs with tool calling.
 *
 * Sends messages → model responds with tool calls → executes locally →
 * appends results → repeats until model stops calling tools or maxTurns.
 */
export async function runAgenticLoop(options: AgenticLoopOptions): Promise<AgenticLoopResult> {
  const { client, model, messages, tools, toolOptions, maxTurns, timeout, issueLogFile } = options;
  const prefix = options.logPrefix || "agentic";
  const startTime = Date.now();
  let turns = 0;

  while (turns < maxTurns) {
    if (Date.now() - startTime > timeout) {
      throw new Error(`Agentic loop timed out after ${Math.round(timeout / 1000)}s`);
    }

    turns++;
    log.debug(`[${prefix}] Turn ${turns}/${maxTurns}`);

    if (issueLogFile) {
      appendFile(issueLogFile, `\n--- Turn ${turns} ---\n`).catch(() => {});
    }

    const response = await client.chat.completions.create({
      model,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      temperature: 0.2,
      max_tokens: 16384,
    });

    const choice = response.choices[0];
    if (!choice) {
      throw new Error(`No response from ${prefix} API`);
    }

    const assistantMessage = choice.message;
    messages.push(assistantMessage);

    if (issueLogFile && assistantMessage.content) {
      appendFile(issueLogFile, `[assistant] ${assistantMessage.content.substring(0, 500)}\n`).catch(() => {});
    }

    // If no tool calls, the model is done
    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      return {
        finalContent: assistantMessage.content || "",
        totalTurns: turns,
        changedFiles: Array.from(toolOptions.trackedFiles),
      };
    }

    // Execute each tool call and append results
    for (const toolCall of assistantMessage.tool_calls) {
      // Only handle standard function tool calls (skip custom tool types)
      if (toolCall.type !== "function") continue;

      log.debug(`[${prefix}] Tool: ${toolCall.function.name}(${toolCall.function.arguments.substring(0, 100)})`);

      if (issueLogFile) {
        appendFile(issueLogFile, `[tool] ${toolCall.function.name}\n`).catch(() => {});
      }

      const result = await executeToolCall(
        {
          id: toolCall.id,
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        },
        toolOptions,
      );

      messages.push({
        role: "tool" as const,
        tool_call_id: result.tool_call_id,
        content: result.content,
      });
    }
  }

  // Max turns reached — return whatever we have
  log.warn(`[${prefix}] Max turns (${maxTurns}) reached`);
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  return {
    finalContent: (lastAssistant && "content" in lastAssistant && typeof lastAssistant.content === "string" ? lastAssistant.content : "") || "",
    totalTurns: turns,
    changedFiles: Array.from(toolOptions.trackedFiles),
  };
}

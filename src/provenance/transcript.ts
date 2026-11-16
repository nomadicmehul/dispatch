import { appendFile, readFile } from "node:fs/promises";

/**
 * Transcripts are JSONL. Claude Code's `stream-json` events are written as they arrive,
 * and Dispatch adds its own `{ "type": "dispatch", "phase": ... }` markers between agent
 * runs (solve, verify, repair), so one file tells the whole story of an issue.
 */

export type TranscriptEvent = Record<string, unknown>;

export type TimelineEntry =
  | { kind: "phase"; detail: string }
  | { kind: "tool"; tool: string; detail: string; error: boolean }
  | { kind: "text"; detail: string }
  | { kind: "result"; detail: string };

/** Append a Dispatch marker event to a transcript (no-op without a file) */
export async function appendTranscriptEvent(
  file: string | undefined,
  phase: string,
  data: Record<string, unknown> = {},
): Promise<void> {
  if (!file) return;
  const event = { type: "dispatch", phase, timestamp: new Date().toISOString(), ...data };
  await appendFile(file, JSON.stringify(event) + "\n").catch(() => {});
}

/** Read a JSONL transcript, skipping lines that don't parse */
export async function readTranscript(file: string): Promise<TranscriptEvent[]> {
  const raw = await readFile(file, "utf-8");
  const events: TranscriptEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as TranscriptEvent);
    } catch {
      // partial line from an interrupted run
    }
  }
  return events;
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.substring(0, max - 1) + "…" : flat;
}

/** Make absolute paths inside the agent's working directory relative */
export function relativize(text: string, workdir?: string): string {
  if (!workdir) return text;
  const prefix = workdir.endsWith("/") ? workdir : `${workdir}/`;
  return text.split(prefix).join("").split(workdir).join(".");
}

/** One-line description of a tool call's input, with paths relative to `workdir` */
export function describeToolInput(input: unknown, workdir?: string): string {
  if (!input || typeof input !== "object") return "";
  const fields = input as Record<string, unknown>;
  for (const key of ["command", "file_path", "path", "pattern", "url", "description"]) {
    if (typeof fields[key] === "string") return truncate(relativize(fields[key] as string, workdir), 100);
  }
  return truncate(relativize(JSON.stringify(input), workdir), 100);
}

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  id?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
}

function contentBlocks(event: TranscriptEvent): ContentBlock[] {
  const message = event.message as { content?: unknown } | undefined;
  return Array.isArray(message?.content) ? (message.content as ContentBlock[]) : [];
}

function describePhase(event: TranscriptEvent): string {
  const phase = String(event.phase);
  if (phase === "verify") {
    const seconds = typeof event.durationMs === "number" ? `, ${Math.round(event.durationMs / 1000)}s` : "";
    return `verify ${event.status}: ${event.command} (exit ${event.exitCode ?? "?"}${seconds})`;
  }
  if (phase === "repair") return `repair attempt ${event.attempt ?? ""}`.trim();
  if (phase === "solve") return `solve started (${event.engine ?? "?"} ${event.model ?? ""})`.trim();
  return phase;
}

/** Condense a transcript into a readable timeline of what the agent did */
export function buildTimeline(events: TranscriptEvent[], options: { workdir?: string } = {}): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  const toolEntries = new Map<string, Extract<TimelineEntry, { kind: "tool" }>>();

  for (const event of events) {
    if (event.type === "dispatch") {
      entries.push({ kind: "phase", detail: describePhase(event) });
      continue;
    }

    // Subagent messages carry a parent tool ID; the main timeline skips them
    if (event.parent_tool_use_id) continue;

    if (event.type === "assistant") {
      for (const block of contentBlocks(event)) {
        if (block.type === "text" && block.text?.trim()) {
          entries.push({ kind: "text", detail: truncate(block.text, 160) });
        } else if (block.type === "tool_use" && block.name) {
          const entry = { kind: "tool" as const, tool: block.name, detail: describeToolInput(block.input, options.workdir), error: false };
          entries.push(entry);
          if (block.id) toolEntries.set(block.id, entry);
        }
      }
    } else if (event.type === "user") {
      for (const block of contentBlocks(event)) {
        if (block.type === "tool_result" && block.is_error && block.tool_use_id) {
          const entry = toolEntries.get(block.tool_use_id);
          if (entry) entry.error = true;
        }
      }
    } else if (event.type === "result") {
      const cost = typeof event.total_cost_usd === "number" ? `, $${event.total_cost_usd.toFixed(2)}` : "";
      entries.push({ kind: "result", detail: `${event.subtype ?? "done"} after ${event.num_turns ?? "?"} turns${cost}` });
    }
  }

  return entries;
}

import { Command } from "commander";
import chalk from "chalk";
import { join } from "node:path";
import { loadConfig } from "../utils/config.js";
import { log } from "../utils/logger.js";
import { findSession, sessionDir, TRANSCRIPT_FILE, type SessionRecord } from "../provenance/store.js";
import { buildTimeline, readTranscript, describeToolInput, relativize, type TimelineEntry, type TranscriptEvent } from "../provenance/transcript.js";
import { LANE_LABELS } from "../orchestrator/scorer.js";
import { formatCost } from "../reporter/summary.js";

const TIMELINE_LIMIT = 40;

export function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function row(label: string, value: string) {
  console.log(`  ${chalk.gray(label.padEnd(10))} ${value}`);
}

function signalIcon(ok: boolean | null): string {
  if (ok === true) return chalk.green("✓");
  if (ok === false) return chalk.yellow("!");
  return chalk.gray("·");
}

function printTimelineEntry(entry: TimelineEntry, index: number) {
  const n = chalk.gray(String(index + 1).padStart(3));
  if (entry.kind === "tool") {
    const mark = entry.error ? chalk.red(" ✗") : "";
    console.log(`  ${n} ${chalk.cyan(entry.tool)} ${entry.detail}${mark}`);
  } else if (entry.kind === "text") {
    console.log(`  ${n} ${chalk.gray(`💬 ${entry.detail}`)}`);
  } else if (entry.kind === "phase") {
    console.log(`  ${n} ${chalk.yellow(`▸ ${entry.detail}`)}`);
  } else {
    console.log(`  ${n} ${chalk.bold(`■ ${entry.detail}`)}`);
  }
}

/** Print a session record with its evidence and a condensed agent timeline */
function printExplanation(record: SessionRecord, timeline: TimelineEntry[], dir: string) {
  const statusColor = record.status === "solved" ? chalk.green : record.status === "failed" ? chalk.red : chalk.gray;

  console.log();
  console.log(`  ${chalk.bold("Dispatch session")} ${chalk.cyan(record.id)}  ${statusColor(record.status)}`);
  console.log();
  row("Issue", `#${record.issueNumber} ${record.issueTitle}`);
  if (record.prNumber) row("PR", `#${record.prNumber} ${chalk.gray(record.prUrl ?? "")}`);
  row("Repo", `${record.repo} · ${record.branch} → ${record.baseBranch}`);

  const usage = [
    `${record.engine} (${record.model})`,
    record.turns !== undefined ? `${record.turns} turns` : null,
    record.costUsd !== undefined ? formatCost(record.costUsd) : null,
    formatDuration(record.durationMs),
  ].filter(Boolean).join(" · ");
  row("Agent", usage);
  row("When", `${record.startedAt} on ${record.hostname}`);

  if (record.readiness) {
    row("Readiness", `${record.readiness.score}/10${record.readiness.reasons.length ? chalk.gray(` (${record.readiness.reasons.join(", ")})`) : ""}`);
  }

  if (record.assessment) {
    const { lane, confidence, selfConfidence } = record.assessment;
    row("Lane", `${LANE_LABELS[lane]} · confidence ${confidence}/10 ${chalk.gray(`(agent said ${selfConfidence}/10)`)}`);
  }

  if (record.verify?.command) {
    const v = record.verify;
    const repairs = v.repairs ? ` after ${v.repairs} repair${v.repairs === 1 ? "" : "s"}` : "";
    const timing = v.durationMs !== undefined ? `, ${formatDuration(v.durationMs)}` : "";
    const verdict = v.status === "passed" ? chalk.green("passed") : chalk.red("failed");
    row("Verify", `${v.command} — ${verdict}${repairs} ${chalk.gray(`(exit ${v.exitCode ?? "?"}${timing})`)}`);
  }

  if (record.diff) {
    row("Diff", `${record.diff.files.length} files, +${record.diff.additions} −${record.diff.deletions}`);
  }

  if (record.repoBrief) {
    row("Brief", `repo brief from ${record.repoBrief.ref} (${record.repoBrief.chars} chars)`);
  }

  if (record.error) row("Error", chalk.red(record.error));

  if (record.assessment?.signals.length) {
    console.log();
    console.log(`  ${chalk.bold("Evidence")}`);
    for (const signal of record.assessment.signals) {
      console.log(`    ${signalIcon(signal.ok)} ${signal.label}`);
    }
  }

  if (record.summary) {
    console.log();
    console.log(`  ${chalk.bold("Summary")}`);
    console.log(`    ${record.summary}`);
  }

  if (record.uncertainties?.length) {
    console.log();
    console.log(`  ${chalk.bold("Uncertainties")}`);
    for (const u of record.uncertainties) console.log(`    - ${u}`);
  }

  if (record.diff?.files.length) {
    console.log();
    console.log(`  ${chalk.bold("Files")}`);
    for (const f of record.diff.files) console.log(`    ${f}`);
  }

  if (record.heldBack?.length) {
    console.log();
    console.log(`  ${chalk.bold("Held back (possible secrets)")}`);
    for (const f of record.heldBack) console.log(`    ${f}`);
  }

  if (timeline.length > 0) {
    console.log();
    console.log(`  ${chalk.bold("Timeline")}`);
    timeline.slice(0, TIMELINE_LIMIT).forEach(printTimelineEntry);
    if (timeline.length > TIMELINE_LIMIT) {
      console.log(chalk.gray(`      … ${timeline.length - TIMELINE_LIMIT} more steps (see --transcript)`));
    }
  }

  console.log();
  row("Records", chalk.gray(dir));
  row("Resume", chalk.yellow(`dispatch resume ${record.issueNumber}`));
  console.log();
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => (typeof c?.text === "string" ? c.text : "")).join("\n");
  }
  return "";
}

/** Print the transcript in readable form: messages, tool calls, results */
function printTranscript(events: TranscriptEvent[], workdir?: string) {
  for (const event of events) {
    if (event.type === "dispatch") {
      console.log(chalk.yellow(`\n── ${event.phase} ${JSON.stringify({ ...event, type: undefined, phase: undefined, timestamp: undefined })}`));
      continue;
    }
    if (event.parent_tool_use_id) continue;

    const content = (event.message as { content?: unknown })?.content;
    const blocks = Array.isArray(content) ? content : [];

    if (event.type === "assistant") {
      for (const block of blocks) {
        if (block.type === "text") console.log(`\n${block.text}`);
        if (block.type === "tool_use") console.log(chalk.cyan(`\n→ ${block.name} ${describeToolInput(block.input, workdir)}`));
      }
    } else if (event.type === "user") {
      for (const block of blocks) {
        if (block.type !== "tool_result") continue;
        const text = relativize(toolResultText(block.content), workdir).trim();
        const shown = text.length > 500 ? `${text.substring(0, 500)}…` : text;
        console.log((block.is_error ? chalk.red : chalk.gray)(`← ${shown}`));
      }
    } else if (event.type === "result") {
      console.log(chalk.bold(`\n■ ${event.subtype} · ${event.num_turns} turns · $${Number(event.total_cost_usd ?? 0).toFixed(2)}`));
    }
  }
  console.log();
}

export function registerExplainCommand(program: Command) {
  program
    .command("explain <target>")
    .description("Show how a Dispatch PR was made: evidence, cost, and what the agent did (issue #, PR #, or session ID)")
    .option("--transcript", "Print the full agent transcript")
    .option("--json", "Output the session record as JSON")
    .action(async (target: string, options) => {
      try {
        const cwd = process.cwd();
        const config = await loadConfig(cwd);

        const record = await findSession(target, cwd, config.stateDir);
        if (!record) {
          log.error(`No Dispatch session found for "${target}".`);
          log.info(`Sessions are kept in ${config.stateDir}/sessions/, and in refs/dispatch/sessions/* with provenance "ref".`);
          process.exit(1);
        }

        if (options.json) {
          console.log(JSON.stringify(record, null, 2));
          return;
        }

        const dir = sessionDir(cwd, config.stateDir, record.id);
        let events: TranscriptEvent[] = [];
        try {
          events = await readTranscript(join(dir, TRANSCRIPT_FILE));
        } catch {
          // no transcript for this session
        }

        if (options.transcript) {
          printTranscript(events, record.workdir);
          return;
        }

        printExplanation(record, buildTimeline(events, { workdir: record.workdir }), dir);
      } catch (err) {
        log.error(`Explain failed: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });
}

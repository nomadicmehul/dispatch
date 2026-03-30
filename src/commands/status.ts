import { Command } from "commander";
import chalk from "chalk";
import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../utils/config.js";
import { loadLastSummary, formatMorningSummary } from "../reporter/summary.js";
import { log } from "../utils/logger.js";

export function registerStatusCommand(program: Command) {
  program
    .command("status")
    .description("View the results of the last dispatch run")
    .option("--json", "Output as JSON")
    .option("--memory", "Show memory system details")
    .action(async (options) => {
      try {
        const cwd = process.cwd();
        const config = await loadConfig(cwd);

        const summary = await loadLastSummary(cwd, config.stateDir);

        if (!summary) {
          log.info("No previous dispatch run found.");
          log.info(`Run ${chalk.yellow("dispatch run")} to solve some issues first.`);
          return;
        }

        if (options.json) {
          console.log(JSON.stringify(summary, null, 2));
          return;
        }

        // Pretty print the morning summary
        console.log();
        console.log(formatMorningSummary(summary));

        // Show memory details if requested or if there's interesting memory state
        if (options.memory || summary.memoryStats) {
          await showMemoryDetails(cwd, config.stateDir);
        }

        // Show provider info
        await showProviderInfo(config);
      } catch (err) {
        log.error(`Status failed: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });
}

async function showMemoryDetails(cwd: string, stateDir: string): Promise<void> {
  console.log(chalk.bold("  Memory System:"));

  // Check codebase context cache
  try {
    const contextPath = join(cwd, stateDir, "memory", "context.json");
    await access(contextPath);
    const raw = await readFile(contextPath, "utf-8");
    const ctx = JSON.parse(raw) as { generatedAt: string; commitHash: string; tokenEstimate: number };
    const age = Date.now() - new Date(ctx.generatedAt).getTime();
    const ageMinutes = Math.round(age / 1000 / 60);
    const ageStr = ageMinutes < 60
      ? `${ageMinutes}m ago`
      : ageMinutes < 1440
        ? `${Math.round(ageMinutes / 60)}h ago`
        : `${Math.round(ageMinutes / 1440)}d ago`;

    console.log(`    ${chalk.green("+")} Codebase context: cached (${ageStr}, ~${ctx.tokenEstimate} tokens, commit ${ctx.commitHash.substring(0, 7)})`);
  } catch {
    console.log(`    ${chalk.gray("-")} Codebase context: not cached`);
  }

  // Check lessons
  try {
    const lessonsPath = join(cwd, stateDir, "memory", "lessons.json");
    await access(lessonsPath);
    const raw = await readFile(lessonsPath, "utf-8");
    const store = JSON.parse(raw) as { lessons: unknown[]; lastScanAt: string };
    console.log(`    ${chalk.green("+")} Lessons: ${store.lessons.length} learned (last scan: ${store.lastScanAt || "never"})`);
  } catch {
    console.log(`    ${chalk.gray("-")} Lessons: none (run ${chalk.yellow("dispatch learn")} to scan PRs)`);
  }

  // Check checkpoint
  try {
    const cpPath = join(cwd, stateDir, "checkpoint.json");
    await access(cpPath);
    const raw = await readFile(cpPath, "utf-8");
    const cp = JSON.parse(raw) as { processedIssues: number[]; timestamp: string };
    console.log(`    ${chalk.yellow("!")} Checkpoint: ${cp.processedIssues.length} issues processed (${cp.timestamp})`);
    console.log(`      ${chalk.gray(`Use ${chalk.yellow("dispatch run --resume")} to continue`)}`);
  } catch {
    // No checkpoint — that's normal
  }

  console.log();
}

async function showProviderInfo(config: { provider: string; routingStrategy: string }): Promise<void> {
  console.log(chalk.bold("  Configuration:"));
  console.log(`    Provider: ${config.provider === "auto" ? "auto-detect" : config.provider}`);
  console.log(`    Strategy: ${config.routingStrategy}`);
  console.log();
}

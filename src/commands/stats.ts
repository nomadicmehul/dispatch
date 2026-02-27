import { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../utils/config.js";
import { loadStats, type AggregateStats } from "../telemetry/store.js";
import { log } from "../utils/logger.js";

export function registerStatsCommand(program: Command) {
  program
    .command("stats")
    .description("View historical dispatch statistics across all runs")
    .option("--json", "Output as JSON")
    .option("--recent <n>", "Show last N runs", parseInt)
    .action(async (options) => {
      try {
        const cwd = process.cwd();
        const config = await loadConfig(cwd);
        const stats = await loadStats(cwd, config.stateDir);

        if (stats.totalRuns === 0) {
          log.info("No dispatch runs recorded yet.");
          log.info(`Run ${chalk.yellow("dispatch run")} to get started.`);
          return;
        }

        if (options.json) {
          console.log(JSON.stringify(stats, null, 2));
          return;
        }

        printStats(stats, options.recent);
      } catch (err) {
        log.error(`Stats failed: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.round(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

function makeBar(value: number, max: number, width: number = 20): string {
  const filled = max > 0 ? Math.round((value / max) * width) : 0;
  return "\u2588".repeat(filled) + "\u2591".repeat(width - filled);
}

function printStats(stats: AggregateStats, recentCount?: number) {
  console.log();
  console.log(chalk.bold.cyan("  Dispatch Statistics"));
  console.log(chalk.gray("  " + "\u2501".repeat(40)));
  console.log();

  // Date range
  const first = stats.firstRunAt ? stats.firstRunAt.split("T")[0] : "—";
  const last = stats.lastRunAt ? stats.lastRunAt.split("T")[0] : "—";
  console.log(chalk.gray(`  ${stats.totalRuns} runs from ${first} to ${last}`));
  console.log();

  // Totals
  console.log(chalk.bold("  Totals"));
  console.log(`    Issues checked:     ${chalk.white(String(stats.totalIssuesChecked))}`);
  console.log(`    Issues processed:   ${chalk.white(String(stats.totalIssuesProcessed))}`);
  console.log(`    Issues solved:      ${chalk.green(String(stats.totalIssuesSolved))}`);
  console.log(`    Issues failed:      ${chalk.red(String(stats.totalIssuesFailed))}`);
  console.log(`    PRs created:        ${chalk.cyan(String(stats.totalPRsCreated))}`);
  console.log(`    Total time:         ${chalk.gray(formatDuration(stats.totalDurationMs))}`);

  if (stats.totalIssuesProcessed > 0) {
    const successRate = ((stats.totalIssuesSolved / stats.totalIssuesProcessed) * 100).toFixed(1);
    console.log(`    Success rate:       ${chalk.yellow(successRate + "%")}`);
  }
  if (stats.avgSolveTimeMs > 0) {
    console.log(`    Avg solve time:     ${chalk.gray(formatDuration(stats.avgSolveTimeMs))}`);
  }
  console.log();

  // Classification breakdown
  const classEntries = Object.entries(stats.classificationBreakdown).sort((a, b) => b[1] - a[1]);
  if (classEntries.length > 0) {
    console.log(chalk.bold("  Classification Breakdown"));
    const maxCount = Math.max(...classEntries.map(([, v]) => v));
    for (const [cls, count] of classEntries) {
      const bar = makeBar(count, maxCount, 20);
      const pct = ((count / stats.totalIssuesProcessed) * 100).toFixed(1);
      console.log(`    ${cls.padEnd(16)} ${chalk.cyan(bar)} ${count} (${pct}%)`);
    }
    console.log();
  }

  // Confidence distribution
  const confEntries = Object.entries(stats.confidenceHistogram)
    .map(([k, v]) => [Number(k), v] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  if (confEntries.length > 0) {
    console.log(chalk.bold("  Confidence Distribution"));
    const maxConf = Math.max(...confEntries.map(([, v]) => v));
    for (const [score, count] of confEntries) {
      const bar = makeBar(count, maxConf, 20);
      console.log(`    ${String(score).padStart(2)}/10  ${chalk.green(bar)} ${count}`);
    }
    console.log();
  }

  // Engine usage
  const engineEntries = Object.entries(stats.engineUsage).sort((a, b) => b[1] - a[1]);
  if (engineEntries.length > 0) {
    console.log(chalk.bold("  Engine Usage"));
    const maxEngine = Math.max(...engineEntries.map(([, v]) => v));
    for (const [eng, count] of engineEntries) {
      const bar = makeBar(count, maxEngine, 20);
      console.log(`    ${eng.padEnd(16)} ${chalk.yellow(bar)} ${count} runs`);
    }
    console.log();
  }

  // Failure categories
  const failEntries = Object.entries(stats.failureCategoryBreakdown).sort((a, b) => b[1] - a[1]);
  if (failEntries.length > 0) {
    console.log(chalk.bold("  Failure Categories"));
    const totalFailures = failEntries.reduce((sum, [, v]) => sum + v, 0);
    for (const [cat, count] of failEntries) {
      const pct = ((count / totalFailures) * 100).toFixed(1);
      console.log(`    ${chalk.red(cat.padEnd(20))} ${count} (${pct}%)`);
    }
    console.log();
  }

  // Recent runs
  const recentLimit = recentCount || 10;
  const recentRuns = stats.recentRuns.slice(-recentLimit).reverse();
  if (recentRuns.length > 0) {
    console.log(chalk.bold(`  Recent Runs (last ${recentRuns.length})`));
    for (const run of recentRuns) {
      const date = run.timestamp.split("T")[0];
      const duration = formatDuration(run.durationMs);
      console.log(
        `    ${chalk.gray(date)}  ` +
        `${run.issuesProcessed} processed, ` +
        `${chalk.green(String(run.issuesSolved))} solved, ` +
        `${chalk.cyan(String(run.prsCreated))} PRs  ` +
        chalk.gray(`(${duration})`)
      );
    }
    console.log();
  }
}

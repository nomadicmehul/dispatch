import { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../utils/config.js";
import { loadLastSummary, formatMorningSummary } from "../reporter/summary.js";
import { log } from "../utils/logger.js";

export function registerStatusCommand(program: Command) {
  program
    .command("status")
    .description("View the results of the last dispatch run")
    .option("--json", "Output as JSON")
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
      } catch (err) {
        log.error(`Status failed: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });
}

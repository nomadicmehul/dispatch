#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Command } from "commander";
import chalk from "chalk";
import { registerRunCommand } from "../src/commands/run.js";
import { registerCreateCommand } from "../src/commands/create.js";
import { registerStatusCommand } from "../src/commands/status.js";
import { registerInitCommand } from "../src/commands/init.js";
import { registerScheduleCommand } from "../src/commands/schedule.js";
import { registerStatsCommand } from "../src/commands/stats.js";
import { registerExplainCommand } from "../src/commands/explain.js";
import { registerResumeCommand } from "../src/commands/resume.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf-8"));

const program = new Command();

program
  .name("dispatch")
  .description(
    chalk.bold("Dispatch") +
    " — Dispatch your GitHub issues. Receive pull requests.\n\n" +
    "  AI-powered batch issue solver that turns your open issues into\n" +
    "  pull requests while you sleep."
  )
  .version(pkg.version);

// Register subcommands
registerRunCommand(program);
registerCreateCommand(program);
registerStatusCommand(program);
registerInitCommand(program);
registerScheduleCommand(program);
registerStatsCommand(program);
registerExplainCommand(program);
registerResumeCommand(program);

// Default action (no subcommand)
program.action(() => {
  console.log();
  console.log(
    chalk.bold.cyan("  ⚡ dispatch") +
    chalk.gray(" — AI-powered issue solver") +
    "  " +
    chalk.bgYellow.black(" BETA ")
  );
  console.log();
  console.log(chalk.gray("  Dispatch your issues. Receive pull requests."));
  console.log();
  console.log(`  ${chalk.yellow("dispatch run")}        Solve open issues and create PRs`);
  console.log(`  ${chalk.yellow("dispatch create")}     Create well-structured issues`);
  console.log(`  ${chalk.yellow("dispatch status")}     View last run's review queue`);
  console.log(`  ${chalk.yellow("dispatch explain")}    See how a PR was made (evidence, cost, timeline)`);
  console.log(`  ${chalk.yellow("dispatch resume")}     Pick up a session in Claude Code`);
  console.log(`  ${chalk.yellow("dispatch init")}       Initialize config for this repo`);
  console.log(`  ${chalk.yellow("dispatch schedule")}   Set up nightly scheduled runs`);
  console.log(`  ${chalk.yellow("dispatch stats")}      View historical run statistics`);
  console.log();
  console.log(chalk.gray("  Run dispatch --help for full options."));
  console.log();
});

program.parse();

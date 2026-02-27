import { Command } from "commander";
import chalk from "chalk";
import inquirer from "inquirer";
import { saveConfig, DEFAULT_CONFIG, type DispatchConfig } from "../utils/config.js";
import { getRepoInfo } from "../utils/git.js";
import { log } from "../utils/logger.js";

export function registerInitCommand(program: Command) {
  program
    .command("init")
    .description("Initialize dispatch configuration for this repository")
    .option("-y, --yes", "Use default config without prompting")
    .action(async (options) => {
      try {
        log.header("Dispatch Init");

        // Verify we're in a git repo with a GitHub remote
        try {
          const { owner, repo } = await getRepoInfo();
          log.success(`Detected repository: ${chalk.bold(`${owner}/${repo}`)}`);
        } catch {
          log.error("Not in a Git repository with a GitHub remote.");
          log.info("Run this command from the root of your GitHub repository.");
          process.exit(1);
        }

        let config: DispatchConfig;

        if (options.yes) {
          config = { ...DEFAULT_CONFIG };
        } else {
          const answers = await inquirer.prompt([
            {
              type: "list",
              name: "engine",
              message: "AI engine:",
              choices: [
                { name: "Claude Code (recommended)", value: "claude" },
                { name: "Gemini CLI (coming soon)", value: "gemini", disabled: true },
              ],
              default: "claude",
            },
            {
              type: "list",
              name: "model",
              message: "Model to use:",
              choices: ["sonnet", "opus", "haiku"],
              default: "sonnet",
            },
            {
              type: "input",
              name: "labels",
              message: "Issue labels to include (comma-separated, empty = all):",
              default: "",
              filter: (val: string) => val ? val.split(",").map((s: string) => s.trim()) : [],
            },
            {
              type: "number",
              name: "maxIssues",
              message: "Max issues per run:",
              default: 10,
            },
            {
              type: "number",
              name: "maxTurnsPerIssue",
              message: "Max AI turns per issue:",
              default: DEFAULT_CONFIG.maxTurnsPerIssue,
            },
            {
              type: "input",
              name: "baseBranch",
              message: "Base branch for PRs:",
              default: "main",
            },
            {
              type: "confirm",
              name: "createDraftPRs",
              message: "Create draft PRs by default?",
              default: false,
            },
          ]);

          config = {
            ...DEFAULT_CONFIG,
            ...answers,
          };
        }

        const path = await saveConfig(config);
        console.log();
        log.success(`Config saved to ${chalk.bold(path)}`);
        console.log();
        log.info(`Next steps:`);
        console.log(chalk.gray(`  1. Set your GitHub token:  ${chalk.yellow("export GITHUB_TOKEN=ghp_...")}  (or ${chalk.yellow("gh auth login")})`));
        console.log(chalk.gray(`  2. Ensure Claude Code is installed:  ${chalk.yellow("claude --version")}`));
        console.log(chalk.gray(`  3. Run dispatch:  ${chalk.yellow("dispatch run")}`));
        console.log();
        console.log(chalk.dim(`  Want nightly CI runs? Use ${chalk.yellow("dispatch schedule")} to set up GitHub Actions.`));
        console.log(chalk.dim(`  Enterprise account (no API key)?  ${chalk.yellow("dispatch schedule --auth claude-code")}`));
        console.log();
      } catch (err) {
        log.error(`Init failed: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });
}

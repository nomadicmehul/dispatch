import { Command } from "commander";
import chalk from "chalk";
import inquirer from "inquirer";
import { saveConfig, DEFAULT_CONFIG, type DispatchConfig } from "../utils/config.js";
import { getRepoInfo } from "../utils/git.js";
import { log } from "../utils/logger.js";
import { GitHubClient } from "../github/client.js";
import { DISPATCH_LABEL } from "../github/labels.js";

/** Resolve, or reject after `ms` so init never hangs on the network */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timed out")), ms);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Mark the repository: create the ⚡ label every Dispatch PR carries. Best effort. */
async function createDispatchLabel(owner: string, repo: string): Promise<void> {
  try {
    const github = await withTimeout(GitHubClient.create(owner, repo), 10_000);
    const created = await withTimeout(github.ensureLabel(DISPATCH_LABEL), 10_000);
    log.success(
      created
        ? `Created the ${chalk.bold(DISPATCH_LABEL.name)} label in ${owner}/${repo}. Dispatch's PRs will carry it`
        : `${owner}/${repo} already has the ${chalk.bold(DISPATCH_LABEL.name)} label`
    );
  } catch {
    log.info(`Couldn't create the ${DISPATCH_LABEL.name} label now (no GitHub token, or no write access to ${owner}/${repo}). Dispatch creates it with its first PR.`);
  }
}

export function registerInitCommand(program: Command) {
  program
    .command("init")
    .description("Initialize dispatch configuration for this repository")
    .option("-y, --yes", "Use default config without prompting")
    .action(async (options) => {
      try {
        log.header("Dispatch Init");

        // Verify we're in a git repo with a GitHub remote
        let owner: string, repo: string;
        try {
          ({ owner, repo } = await getRepoInfo());
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
                { name: "Gemini (Google AI — uses GEMINI_API_KEY)", value: "gemini" },
              ],
              default: "claude",
            },
            {
              type: "list",
              name: "model",
              message: "Model to use:",
              choices: (answers: { engine: string }) => {
                if (answers.engine === "github-models") {
                  return [
                    { name: "openai/gpt-4o (recommended)", value: "openai/gpt-4o" },
                    { name: "anthropic/claude-sonnet-4", value: "anthropic/claude-sonnet-4" },
                    { name: "google/gemini-2.5-pro", value: "google/gemini-2.5-pro" },
                    { name: "meta/llama-4-scout", value: "meta/llama-4-scout" },
                  ];
                }
                if (answers.engine === "gemini") {
                  return [
                    { name: "gemini-2.5-pro (recommended)", value: "gemini-2.5-pro" },
                    { name: "gemini-2.5-flash (faster, cheaper)", value: "gemini-2.5-flash" },
                    { name: "gemini-3-flash-preview (next-gen fast)", value: "gemini-3-flash-preview" },
                    { name: "gemini-3-pro-preview (next-gen capable)", value: "gemini-3-pro-preview" },
                  ];
                }
                return ["sonnet", "opus", "haiku"];
              },
              default: (answers: { engine: string }) => {
                if (answers.engine === "github-models") return "openai/gpt-4o";
                if (answers.engine === "gemini") return "gemini-2.5-pro";
                return "sonnet";
              },
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
        await createDispatchLabel(owner, repo);
        console.log();
        log.info(`Next steps:`);
        console.log(chalk.gray(`  1. Set your GitHub token:  ${chalk.yellow("export GITHUB_TOKEN=ghp_...")}  (or ${chalk.yellow("gh auth login")})`));
        if (config.engine === "github-models") {
          console.log(chalk.gray(`  2. Ensure GITHUB_TOKEN has models:read scope`));
        } else if (config.engine === "gemini") {
          console.log(chalk.gray(`  2. Set your Gemini API key:  ${chalk.yellow("export GEMINI_API_KEY=...")}`));
          console.log(chalk.gray(`     Get one at: ${chalk.yellow("https://aistudio.google.com/apikey")}`));
        } else {
          console.log(chalk.gray(`  2. Ensure Claude Code is installed:  ${chalk.yellow("claude --version")}`));
        }
        console.log(chalk.gray(`  3. Run dispatch:  ${chalk.yellow("dispatch run")}`));
        console.log();
        console.log(chalk.dim(`  Want nightly CI runs? Use ${chalk.yellow("dispatch schedule")} to set up GitHub Actions.`));
        console.log(chalk.dim(`  Claude Pro/Max subscription (no API key)?  ${chalk.yellow("dispatch schedule --auth claude-code")}`));
        console.log(chalk.dim(`  Preview what would be picked, and why:  ${chalk.yellow("dispatch run --dry-run")}`));
        console.log();
      } catch (err) {
        log.error(`Init failed: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });
}

import { Command } from "commander";
import chalk from "chalk";
import { loadConfig, applyCliOverrides } from "../utils/config.js";
import { getRepoInfo } from "../utils/git.js";
import { GitHubClient } from "../github/client.js";
import { ClaudeEngine } from "../engine/claude.js";
import { GitHubModelsEngine } from "../engine/github-models.js";
import { GeminiEngine } from "../engine/gemini.js";
import { runPipeline } from "../orchestrator/pipeline.js";
import { log } from "../utils/logger.js";

export function registerRunCommand(program: Command) {
  program
    .command("run")
    .description("Solve open GitHub issues and create pull requests")
    .option("--dry-run", "Preview which issues would be processed without making changes")
    .option("--engine <engine>", "AI engine to use (default: claude)")
    .option("--model <model>", "Model to use (default: sonnet)")
    .option("--label <labels...>", "Only process issues with these labels")
    .option("--exclude <labels...>", "Skip issues with these labels")
    .option("--max-issues <n>", "Max issues to process", parseInt)
    .option("--max-turns <n>", "Max AI turns per issue", parseInt)
    .option("--draft", "Create all PRs as drafts")
    .option("--base-branch <branch>", "Base branch for PRs (default: main)")
    .option("--concurrency <n>", "Number of issues to process in parallel", parseInt)
    .option("--no-telemetry", "Disable anonymous telemetry for this run")
    .action(async (options) => {
      try {
        const cwd = process.cwd();

        // Load config
        let config = await loadConfig(cwd);
        config = applyCliOverrides(config, options);

        // Detect repo
        const { owner, repo } = await getRepoInfo(cwd);
        log.info(`Repository: ${chalk.bold(`${owner}/${repo}`)}`);
        log.info(`Engine: ${chalk.bold(config.engine)} (${config.model})`);
        log.info(`Max issues: ${config.maxIssues} | Max turns: ${config.maxTurnsPerIssue} | Concurrency: ${config.concurrency}`);

        if (config.labels.length > 0) {
          log.info(`Filtering: ${config.labels.join(", ")}`);
        }

        // Create engine
        let engine;
        if (config.engine === "claude") {
          engine = new ClaudeEngine({
            model: config.model,
            maxTurns: config.maxTurnsPerIssue,
          });
        } else if (config.engine === "github-models") {
          engine = new GitHubModelsEngine({
            model: config.model,
            maxTurns: config.maxTurnsPerIssue,
          });
        } else if (config.engine === "gemini") {
          engine = new GeminiEngine({
            model: config.model === "sonnet" ? "gemini-2.5-pro" : config.model,
            maxTurns: config.maxTurnsPerIssue,
          });
        } else {
          log.error(`Engine "${config.engine}" is not supported. Use "claude", "github-models", or "gemini".`);
          process.exit(1);
        }

        // Create GitHub client
        const github = await GitHubClient.create(owner, repo);

        // Run the pipeline
        const summary = await runPipeline({
          config,
          engine,
          github,
          cwd,
          dryRun: options.dryRun,
        });

        // Exit with appropriate code
        if (summary.totalFailed > 0 && summary.totalSolved === 0) {
          process.exit(1);
        }
      } catch (err) {
        log.error(`Run failed: ${err instanceof Error ? err.message : err}`);
        if (process.env.DEBUG) {
          console.error(err);
        }
        process.exit(1);
      }
    });
}

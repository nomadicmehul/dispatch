import { Command } from "commander";
import chalk from "chalk";
import inquirer from "inquirer";
import { loadConfig } from "../utils/config.js";
import { getRepoInfo } from "../utils/git.js";
import { GitHubClient } from "../github/client.js";
import { ClaudeEngine } from "../engine/claude.js";
import { GitHubModelsEngine } from "../engine/github-models.js";
import type { AIEngine } from "../engine/types.js";
import { log } from "../utils/logger.js";

export function registerCreateCommand(program: Command) {
  program
    .command("create [description]")
    .description("Create a well-structured GitHub issue from a description or interactive interview")
    .option("-i, --interactive", "Use interactive interview mode")
    .option("--no-post", "Generate the issue but don't post it to GitHub")
    .option("--engine <engine>", "AI engine to use")
    .option("--model <model>", "Model to use")
    .action(async (description: string | undefined, options) => {
      try {
        const cwd = process.cwd();
        const config = await loadConfig(cwd);
        const { owner, repo } = await getRepoInfo(cwd);

        // Get description from interactive mode or argument
        let finalDescription: string;

        if (options.interactive || !description) {
          finalDescription = await interactiveInterview();
        } else {
          finalDescription = description;
        }

        if (!finalDescription.trim()) {
          log.error("No description provided.");
          process.exit(1);
        }

        log.info("Generating structured issue with AI...\n");

        // Use AI to structure the issue
        const engineName = options.engine || config.engine;
        let engine: AIEngine;
        if (engineName === "github-models") {
          engine = new GitHubModelsEngine({
            model: options.model || config.model,
            maxTurns: 3,
          });
        } else {
          engine = new ClaudeEngine({
            model: options.model || config.model,
            maxTurns: 3,
          });
        }

        const structured = await engine.createIssue(finalDescription, {
          owner,
          repo,
          baseBranch: config.baseBranch,
          cwd,
        });

        // Preview
        console.log(chalk.bold.cyan("\n━━━ Issue Preview ━━━\n"));
        console.log(chalk.bold(`Title: ${structured.title}`));
        console.log(chalk.gray(`Labels: ${structured.labels.join(", ")}`));
        console.log(chalk.gray("─".repeat(50)));
        console.log(structured.body);
        console.log(chalk.gray("─".repeat(50)));

        if (options.post === false) {
          log.info("Issue generated (not posted — use without --no-post to publish).");
          return;
        }

        // Confirm before posting
        const { confirm } = await inquirer.prompt([
          {
            type: "confirm",
            name: "confirm",
            message: "Post this issue to GitHub?",
            default: true,
          },
        ]);

        if (!confirm) {
          log.info("Issue not posted.");
          return;
        }

        // Post to GitHub
        const github = await GitHubClient.create(owner, repo);
        const issue = await github.createIssue({
          title: structured.title,
          body: structured.body,
          labels: structured.labels,
        });

        console.log();
        log.success(`Issue #${issue.number} created: ${chalk.underline(issue.url)}`);
      } catch (err) {
        log.error(`Create failed: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });
}

async function interactiveInterview(): Promise<string> {
  console.log(chalk.bold.cyan("\n━━━ Issue Interview ━━━\n"));
  console.log(chalk.gray("Answer a few questions and I'll create a well-structured issue.\n"));

  const answers = await inquirer.prompt([
    {
      type: "list",
      name: "type",
      message: "What kind of task is this?",
      choices: [
        { name: "🐛 Bug fix — something is broken", value: "bug" },
        { name: "✨ Feature — add new functionality", value: "feature" },
        { name: "🔍 Investigation — research or figure something out", value: "investigation" },
        { name: "📝 Documentation — write or update docs", value: "documentation" },
        { name: "🔒 Audit — review codebase for issues", value: "audit" },
        { name: "♻️ Refactor — restructure without behavior change", value: "refactor" },
      ],
    },
    {
      type: "input",
      name: "what",
      message: "What needs to be done? (describe in your own words)",
      validate: (input: string) => input.trim().length > 0 || "Please provide a description",
    },
    {
      type: "input",
      name: "where",
      message: "Where in the codebase? (files, modules, or 'not sure')",
      default: "not sure",
    },
    {
      type: "input",
      name: "why",
      message: "Why is this needed? (context, impact, urgency)",
      default: "",
    },
    {
      type: "input",
      name: "acceptance",
      message: "How will we know it's done? (acceptance criteria, or leave blank)",
      default: "",
    },
    {
      type: "list",
      name: "priority",
      message: "Priority?",
      choices: [
        { name: "🔴 Critical (P0)", value: "P0" },
        { name: "🟠 High (P1)", value: "P1" },
        { name: "🟡 Medium (P2)", value: "P2" },
        { name: "🟢 Low (P3)", value: "P3" },
      ],
      default: "P2",
    },
  ]);

  // Compose a description for AI to structure
  let description = `Type: ${answers.type}\n`;
  description += `Task: ${answers.what}\n`;
  if (answers.where !== "not sure") {
    description += `Location in codebase: ${answers.where}\n`;
  }
  if (answers.why) {
    description += `Context/Why: ${answers.why}\n`;
  }
  if (answers.acceptance) {
    description += `Acceptance criteria: ${answers.acceptance}\n`;
  }
  description += `Priority: ${answers.priority}`;

  return description;
}

import { Command } from "commander";
import chalk from "chalk";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../utils/config.js";
import { getRepoInfo } from "../utils/git.js";
import { GitHubClient } from "../github/client.js";
import { log } from "../utils/logger.js";

interface Lesson {
  source: string;
  prNumber: number;
  issueNumber: number | null;
  lesson: string;
  category: "style" | "correctness" | "approach" | "general";
  learnedAt: string;
  decayScore: number;
}

interface LessonsStore {
  version: number;
  lessons: Lesson[];
  lastScanAt: string;
}

const LESSONS_FILE = "memory/lessons.json";
const HALF_LIFE_DAYS = 30;

export function registerLearnCommand(program: Command) {
  program
    .command("learn")
    .description("Scan Dispatch PRs for review feedback and extract lessons")
    .option("--max-prs <n>", "Max PRs to scan", parseInt)
    .option("--show", "Just show current lessons without scanning")
    .action(async (options) => {
      try {
        const cwd = process.cwd();
        const config = await loadConfig(cwd);
        const { owner, repo } = await getRepoInfo(cwd);

        const lessonsPath = join(cwd, config.stateDir, LESSONS_FILE);

        // Load existing lessons
        let store = await loadLessons(lessonsPath);

        if (options.show) {
          printLessons(store);
          return;
        }

        const github = await GitHubClient.create(owner, repo);

        log.info(`Scanning PRs in ${chalk.bold(`${owner}/${repo}`)} for Dispatch feedback...`);

        // Fetch PRs created by Dispatch
        const prs = await github.listDispatchPRs({
          branchPrefix: config.branchPrefix,
          state: "all",
          maxPRs: options.maxPrs || 50,
        });

        if (prs.length === 0) {
          log.info("No Dispatch PRs found. Run `dispatch run` first to create some PRs.");
          return;
        }

        log.info(`Found ${prs.length} Dispatch PRs to analyze`);

        let newLessonsCount = 0;

        for (const pr of prs) {
          // Skip PRs we've already scanned (by checking existing lessons)
          if (store.lessons.some((l) => l.prNumber === pr.number)) {
            continue;
          }

          // Only learn from PRs with feedback
          if (pr.state === "open") continue;

          // Extract issue number from branch name
          const issueMatch = pr.headBranch.match(/issue-(\d+)/);
          const issueNumber = issueMatch ? parseInt(issueMatch[1], 10) : null;

          // Fetch review comments
          const reviewComments = await github.fetchPRReviewComments(pr.number);
          const issueComments = await github.fetchPRIssueComments(pr.number);
          const allComments = [...reviewComments, ...issueComments];

          // Filter out bot comments and the PR author's own comments
          const humanFeedback = allComments.filter((c) =>
            c.author !== "github-actions[bot]" &&
            !c.body.includes("Created by Dispatch") &&
            c.body.trim().length > 10
          );

          if (humanFeedback.length === 0 && pr.merged) {
            // Merged with no feedback = good, but nothing to learn
            continue;
          }

          if (pr.merged && humanFeedback.length > 0) {
            // Merged with review comments — extract lessons
            for (const comment of humanFeedback) {
              const lesson = extractLesson(comment.body, pr.title);
              if (lesson) {
                store.lessons.push({
                  source: `PR #${pr.number} review by ${comment.author}`,
                  prNumber: pr.number,
                  issueNumber,
                  lesson,
                  category: categorizeLesson(lesson),
                  learnedAt: new Date().toISOString(),
                  decayScore: 1.0,
                });
                newLessonsCount++;
              }
            }
          }

          if (!pr.merged && pr.state === "closed") {
            // Closed without merge — the approach was wrong
            const rejectionComment = humanFeedback[0];
            const reason = rejectionComment
              ? extractLesson(rejectionComment.body, pr.title)
              : `PR "${pr.title}" was rejected without merge`;

            if (reason) {
              store.lessons.push({
                source: `PR #${pr.number} (rejected)`,
                prNumber: pr.number,
                issueNumber,
                lesson: reason,
                category: "approach",
                learnedAt: new Date().toISOString(),
                decayScore: 1.0,
              });
              newLessonsCount++;
            }
          }
        }

        // Apply decay to existing lessons
        applyDecay(store);

        // Deduplicate similar lessons
        deduplicateLessons(store);

        // Save
        store.lastScanAt = new Date().toISOString();
        await saveLessons(lessonsPath, store);

        // Print results
        console.log();
        if (newLessonsCount > 0) {
          log.success(`Learned ${newLessonsCount} new lesson(s) from PR reviews`);
        } else {
          log.info("No new lessons found from PR reviews");
        }

        printLessons(store);
      } catch (err) {
        log.error(`Learn failed: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });
}

function extractLesson(commentBody: string, prTitle: string): string | null {
  // Clean up the comment
  const cleaned = commentBody
    .replace(/```[\s\S]*?```/g, "") // Remove code blocks
    .replace(/<!--[\s\S]*?-->/g, "") // Remove HTML comments
    .trim();

  if (cleaned.length < 15) return null;
  if (cleaned.length > 500) return cleaned.substring(0, 500);

  return cleaned;
}

function categorizeLesson(lesson: string): Lesson["category"] {
  const lower = lesson.toLowerCase();
  if (lower.includes("style") || lower.includes("naming") || lower.includes("format")) return "style";
  if (lower.includes("bug") || lower.includes("error") || lower.includes("null") || lower.includes("check")) return "correctness";
  if (lower.includes("approach") || lower.includes("instead") || lower.includes("better") || lower.includes("should")) return "approach";
  return "general";
}

function applyDecay(store: LessonsStore): void {
  const now = Date.now();
  for (const lesson of store.lessons) {
    const ageMs = now - new Date(lesson.learnedAt).getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    lesson.decayScore = Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
  }

  // Remove lessons with very low decay scores
  store.lessons = store.lessons.filter((l) => l.decayScore > 0.1);
}

function deduplicateLessons(store: LessonsStore): void {
  const seen = new Set<string>();
  store.lessons = store.lessons.filter((l) => {
    const key = l.lesson.substring(0, 100).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function loadLessons(path: string): Promise<LessonsStore> {
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as LessonsStore;
  } catch {
    return { version: 1, lessons: [], lastScanAt: "" };
  }
}

async function saveLessons(path: string, store: LessonsStore): Promise<void> {
  const { dirname } = await import("node:path");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(store, null, 2), "utf-8");
}

function printLessons(store: LessonsStore): void {
  if (store.lessons.length === 0) {
    console.log(chalk.gray("\n  No lessons learned yet."));
    console.log(chalk.gray("  Create some PRs with `dispatch run`, get them reviewed, then run `dispatch learn`."));
    console.log();
    return;
  }

  console.log();
  console.log(chalk.bold(`  Lessons Learned (${store.lessons.length}):`));
  console.log();

  // Sort by decay score (most relevant first)
  const sorted = [...store.lessons].sort((a, b) => b.decayScore - a.decayScore);

  for (const lesson of sorted.slice(0, 15)) {
    const relevance = lesson.decayScore > 0.8
      ? chalk.green("HIGH")
      : lesson.decayScore > 0.5
        ? chalk.yellow("MED")
        : chalk.gray("LOW");

    const source = chalk.gray(lesson.source);
    const category = chalk.cyan(`[${lesson.category}]`);

    console.log(`    ${relevance} ${category} ${source}`);
    console.log(`         ${lesson.lesson.substring(0, 120)}`);
    console.log();
  }

  if (sorted.length > 15) {
    console.log(chalk.gray(`    ... and ${sorted.length - 15} more lessons`));
    console.log();
  }

  if (store.lastScanAt) {
    console.log(chalk.gray(`  Last scanned: ${store.lastScanAt}`));
    console.log();
  }
}

/** Load lessons for injection into solve prompts */
export async function loadLessonsForPrompt(cwd: string, stateDir: string): Promise<string> {
  const path = join(cwd, stateDir, LESSONS_FILE);
  const store = await loadLessons(path);

  if (store.lessons.length === 0) return "";

  applyDecay(store);

  // Get top lessons by relevance
  const topLessons = store.lessons
    .filter((l) => l.decayScore > 0.3)
    .sort((a, b) => b.decayScore - a.decayScore)
    .slice(0, 10);

  if (topLessons.length === 0) return "";

  const lines = [
    "## Lessons from Previous PR Reviews",
    "",
    "These are patterns learned from human code review of Dispatch's past PRs:",
    "",
  ];

  for (const lesson of topLessons) {
    lines.push(`- [${lesson.category}] ${lesson.lesson.substring(0, 200)}`);
  }

  return lines.join("\n");
}

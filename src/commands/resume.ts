import { Command } from "commander";
import chalk from "chalk";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../utils/config.js";
import { log } from "../utils/logger.js";
import { createWorktree, createWorktreeFromBranch } from "../utils/worktree.js";
import { findSession, sessionDir, NATIVE_TRANSCRIPT_FILE, type SessionRecord } from "../provenance/store.js";

/** Starting prompt when there is no Claude Code transcript to resume */
export function buildHandoffPrompt(record: SessionRecord): string {
  const lines = [
    `You are picking up work that Dispatch started on GitHub issue #${record.issueNumber}: ${record.issueTitle} (${record.issueUrl}).`,
    `This directory has the branch ${record.branch} checked out.`,
  ];
  if (record.summary) lines.push(`\nThe previous attempt summarized its work as: ${record.summary}`);
  if (record.uncertainties?.length) {
    lines.push(`\nIt was unsure about:\n${record.uncertainties.map((u) => `- ${u}`).join("\n")}`);
  }
  if (record.verify?.status === "failed") {
    lines.push(`\nVerification (\`${record.verify.command}\`) failed with:\n\`\`\`\n${record.verify.outputTail ?? ""}\n\`\`\``);
  }
  if (record.error) lines.push(`\nThe run ended with an error: ${record.error}`);
  lines.push(`\nStart by reviewing the current state of the branch, then tell me what you think is left to do.`);
  return lines.join("\n");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function registerResumeCommand(program: Command) {
  program
    .command("resume <target>")
    .description("Continue a Dispatch session interactively in Claude Code, on its PR branch (issue #, PR #, or session ID)")
    .action(async (target: string) => {
      try {
        const cwd = process.cwd();
        const config = await loadConfig(cwd);

        const record = await findSession(target, cwd, config.stateDir);
        if (!record) {
          log.error(`No Dispatch session found for "${target}".`);
          process.exit(1);
        }

        // Kept outside .dispatch/worktrees, which `dispatch run` clears on start
        const worktreePath = join(cwd, config.stateDir, "resume", `issue-${record.issueNumber}`);
        try {
          await createWorktreeFromBranch(worktreePath, record.branch, cwd);
          log.info(`Checked out ${chalk.cyan(record.branch)} in ${worktreePath}`);
        } catch {
          log.warn(`Branch ${record.branch} is not on origin (no PR was opened) — starting from ${record.baseBranch}.`);
          await createWorktree(worktreePath, record.branch, record.baseBranch, cwd);
        }

        const native = join(sessionDir(cwd, config.stateDir, record.id), NATIVE_TRANSCRIPT_FILE);
        const resumable = await exists(native);
        const args = resumable ? ["--resume", native] : [buildHandoffPrompt(record)];
        log.info(resumable
          ? `Resuming Claude Code session ${record.id.substring(0, 8)} with its full history...`
          : "No Claude Code transcript for this session — starting a new session with a handoff summary...");

        const env = { ...process.env };
        delete env.CLAUDECODE; // Allow nested claude calls

        const code = await new Promise<number | null>((resolve, reject) => {
          const child = spawn("claude", args, { cwd: worktreePath, stdio: "inherit", env });
          child.on("close", resolve);
          child.on("error", reject);
        });

        console.log();
        log.info(`Session ended${code ? ` (exit ${code})` : ""}. Your work is in ${chalk.bold(worktreePath)}.`);
        console.log(chalk.gray(`  Update the PR:   cd ${worktreePath} && git add -A && git commit && git push`));
        console.log(chalk.gray(`  Clean up after:  git worktree remove ${worktreePath}`));
        console.log();
      } catch (err) {
        const missing = (err as NodeJS.ErrnoException)?.code === "ENOENT";
        log.error(missing
          ? "Claude Code CLI not found. Install it with: npm install -g @anthropic-ai/claude-code"
          : `Resume failed: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });
}

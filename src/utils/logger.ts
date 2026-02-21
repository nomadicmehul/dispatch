import chalk from "chalk";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  SILENT = 4,
}

let currentLevel = LogLevel.INFO;

export function setLogLevel(level: LogLevel) {
  currentLevel = level;
}

function timestamp(): string {
  return new Date().toLocaleTimeString("en-US", { hour12: false });
}

function isoTimestamp(): string {
  return new Date().toISOString();
}

/** Strip ANSI escape codes for plain-text log files */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

// --- File logging state ---
let logDir: string | null = null;
let accessLogPath: string | null = null;
let errorLogPath: string | null = null;

/** Initialize file-based logging. Creates .dispatch/logs/ directory. */
export async function initFileLogging(stateDir: string, cwd: string): Promise<void> {
  logDir = join(cwd, stateDir, "logs");
  await mkdir(logDir, { recursive: true });
  accessLogPath = join(logDir, "access.log");
  errorLogPath = join(logDir, "error.log");
}

/** Get the log directory path (for computing per-issue log paths). */
export function getLogDir(): string | null {
  return logDir;
}

/** Fire-and-forget write to log files. */
function writeToLogFiles(level: LogLevel, msg: string): void {
  if (!accessLogPath || !errorLogPath) return;

  const plain = stripAnsi(msg);
  const line = `[${isoTimestamp()}] ${plain}\n`;

  // access.log gets INFO+ messages
  if (level >= LogLevel.INFO) {
    appendFile(accessLogPath, line).catch(() => {});
  }

  // error.log gets WARN+ messages
  if (level >= LogLevel.WARN) {
    appendFile(errorLogPath, line).catch(() => {});
  }
}

export const log = {
  debug(msg: string, ...args: unknown[]) {
    if (currentLevel <= LogLevel.DEBUG) {
      console.log(chalk.gray(`[${timestamp()}] ${msg}`), ...args);
    }
  },

  info(msg: string, ...args: unknown[]) {
    if (currentLevel <= LogLevel.INFO) {
      console.log(chalk.blue(`[${timestamp()}]`) + ` ${msg}`, ...args);
    }
    writeToLogFiles(LogLevel.INFO, msg);
  },

  success(msg: string, ...args: unknown[]) {
    if (currentLevel <= LogLevel.INFO) {
      console.log(chalk.green(`✓ ${msg}`), ...args);
    }
    writeToLogFiles(LogLevel.INFO, `SUCCESS: ${msg}`);
  },

  warn(msg: string, ...args: unknown[]) {
    if (currentLevel <= LogLevel.WARN) {
      console.log(chalk.yellow(`⚠ ${msg}`), ...args);
    }
    writeToLogFiles(LogLevel.WARN, `WARN: ${msg}`);
  },

  error(msg: string, ...args: unknown[]) {
    if (currentLevel <= LogLevel.ERROR) {
      console.error(chalk.red(`✗ ${msg}`), ...args);
    }
    writeToLogFiles(LogLevel.ERROR, `ERROR: ${msg}`);
  },

  header(msg: string) {
    if (currentLevel <= LogLevel.INFO) {
      console.log();
      console.log(chalk.bold.cyan(`━━━ ${msg} ━━━`));
      console.log();
    }
    writeToLogFiles(LogLevel.INFO, `--- ${msg} ---`);
  },

  issue(number: number, title: string, status: string) {
    if (currentLevel <= LogLevel.INFO) {
      const badge = status === "solving"
        ? chalk.yellow("⏳")
        : status === "solved"
          ? chalk.green("✓")
          : status === "failed"
            ? chalk.red("✗")
            : chalk.gray("○");
      console.log(`  ${badge} #${number} ${chalk.white(title)}`);
    }
    writeToLogFiles(LogLevel.INFO, `#${number} ${title} [${status}]`);
  },
};

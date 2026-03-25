import { readFile, writeFile, access, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CodebaseContext } from "./types.js";
import { log } from "../utils/logger.js";

const exec = promisify(execFile);

const CACHE_FILE = "memory/context.json";

/**
 * Load or generate codebase context.
 * Returns cached version if fresh, regenerates if stale.
 */
export async function getCodebaseContext(
  cwd: string,
  stateDir: string,
  maxAgeMs: number,
): Promise<CodebaseContext> {
  const cachePath = join(cwd, stateDir, CACHE_FILE);

  // Try loading cache
  try {
    await access(cachePath);
    const raw = await readFile(cachePath, "utf-8");
    const cached = JSON.parse(raw) as CodebaseContext;

    const age = Date.now() - new Date(cached.generatedAt).getTime();
    if (age < maxAgeMs) {
      // Check if commit hash still matches HEAD
      const currentHash = await getCurrentCommitHash(cwd);
      if (currentHash === cached.commitHash) {
        log.debug("Using cached codebase context");
        return cached;
      }
    }
  } catch {
    // No cache or invalid — regenerate
  }

  log.info("Generating codebase context...");
  const context = await generateCodebaseContext(cwd);

  // Save cache
  try {
    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(cachePath, JSON.stringify(context, null, 2), "utf-8");
    log.debug("Codebase context cached");
  } catch (err) {
    log.debug(`Failed to cache context: ${err}`);
  }

  return context;
}

async function getCurrentCommitHash(cwd: string): Promise<string> {
  try {
    const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd, timeout: 5000 });
    return stdout.trim();
  } catch {
    return "unknown";
  }
}

async function generateCodebaseContext(cwd: string): Promise<CodebaseContext> {
  const commitHash = await getCurrentCommitHash(cwd);

  // Generate file tree (depth-limited)
  const fileTree = await generateFileTree(cwd, 3);

  // Detect patterns from package.json, config files
  const patterns = await detectPatterns(cwd);

  // Find key files
  const keyFiles = await findKeyFiles(cwd);

  // Get dependencies
  const dependencies = await getDependencies(cwd);

  // Build structure summary
  const structure = buildStructureSummary(fileTree, patterns, keyFiles);

  // Rough token estimate (4 chars ≈ 1 token)
  const totalText = structure + fileTree + JSON.stringify(patterns) + keyFiles.join("\n");
  const tokenEstimate = Math.ceil(totalText.length / 4);

  return {
    generatedAt: new Date().toISOString(),
    commitHash,
    structure,
    patterns,
    keyFiles,
    dependencies,
    fileTree,
    tokenEstimate,
  };
}

async function generateFileTree(cwd: string, maxDepth: number): Promise<string> {
  try {
    const { stdout } = await exec(
      "find", [".", "-maxdepth", String(maxDepth), "-type", "f",
        "-not", "-path", "*/node_modules/*",
        "-not", "-path", "*/.git/*",
        "-not", "-path", "*/dist/*",
      ],
      { cwd, timeout: 10_000, maxBuffer: 512 * 1024 },
    );
    return stdout.trim();
  } catch {
    return "(could not generate file tree)";
  }
}

async function detectPatterns(cwd: string): Promise<CodebaseContext["patterns"]> {
  const patterns: CodebaseContext["patterns"] = {
    testFramework: null,
    moduleSystem: "unknown",
    buildTool: null,
    linter: null,
    language: "unknown",
    packageManager: "npm",
  };

  try {
    const pkgRaw = await readFile(join(cwd, "package.json"), "utf-8");
    const pkg = JSON.parse(pkgRaw);

    // Detect module system
    patterns.moduleSystem = pkg.type === "module" ? "ESM" : "CommonJS";

    // Detect language
    if (pkg.devDependencies?.typescript || pkg.dependencies?.typescript) {
      patterns.language = "TypeScript";
    } else {
      patterns.language = "JavaScript";
    }

    // Detect test framework
    const scripts = pkg.scripts || {};
    if (scripts.test?.includes("node --test")) patterns.testFramework = "node:test";
    else if (scripts.test?.includes("jest")) patterns.testFramework = "jest";
    else if (scripts.test?.includes("vitest")) patterns.testFramework = "vitest";
    else if (scripts.test?.includes("mocha")) patterns.testFramework = "mocha";

    // Detect build tool
    if (scripts.build?.includes("tsc")) patterns.buildTool = "tsc";
    else if (scripts.build?.includes("esbuild")) patterns.buildTool = "esbuild";
    else if (scripts.build?.includes("vite")) patterns.buildTool = "vite";

    // Detect linter
    if (scripts.lint?.includes("eslint")) patterns.linter = "eslint";
    else if (scripts.lint?.includes("tsc")) patterns.linter = "tsc --noEmit";

    // Detect package manager
    try {
      await access(join(cwd, "pnpm-lock.yaml"));
      patterns.packageManager = "pnpm";
    } catch {
      try {
        await access(join(cwd, "yarn.lock"));
        patterns.packageManager = "yarn";
      } catch {
        patterns.packageManager = "npm";
      }
    }
  } catch {
    // No package.json
  }

  return patterns;
}

async function findKeyFiles(cwd: string): Promise<string[]> {
  const keyPatterns = [
    "package.json", "tsconfig.json", ".eslintrc*", ".prettierrc*",
    "README.md", "CLAUDE.md", "CONTRIBUTING.md",
    "src/index.ts", "src/index.js", "src/main.ts", "src/main.js",
    "src/app.ts", "src/app.js",
  ];

  const found: string[] = [];
  for (const pattern of keyPatterns) {
    try {
      await access(join(cwd, pattern));
      found.push(pattern);
    } catch {
      // not found
    }
  }
  return found;
}

async function getDependencies(cwd: string): Promise<string[]> {
  try {
    const pkgRaw = await readFile(join(cwd, "package.json"), "utf-8");
    const pkg = JSON.parse(pkgRaw);
    return Object.keys(pkg.dependencies || {});
  } catch {
    return [];
  }
}

function buildStructureSummary(
  fileTree: string,
  patterns: CodebaseContext["patterns"],
  keyFiles: string[],
): string {
  const lines = [
    `Language: ${patterns.language}`,
    `Module system: ${patterns.moduleSystem}`,
    patterns.buildTool ? `Build: ${patterns.buildTool}` : null,
    patterns.testFramework ? `Tests: ${patterns.testFramework}` : null,
    patterns.linter ? `Linter: ${patterns.linter}` : null,
    `Package manager: ${patterns.packageManager}`,
    `Key files: ${keyFiles.join(", ")}`,
    "",
    "Directory structure:",
    fileTree,
  ].filter(Boolean);

  return lines.join("\n");
}

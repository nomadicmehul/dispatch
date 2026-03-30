import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadLessonsForPrompt } from "../src/commands/learn.js";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("Learn — loadLessonsForPrompt", () => {
  it("returns empty string when no lessons file exists", async () => {
    const result = await loadLessonsForPrompt("/tmp/nonexistent-dispatch-test", ".dispatch");
    assert.equal(result, "");
  });

  it("returns formatted lessons when file exists", async () => {
    const testDir = join(tmpdir(), `dispatch-test-${Date.now()}`);
    const memoryDir = join(testDir, ".dispatch", "memory");
    await mkdir(memoryDir, { recursive: true });

    const store = {
      version: 1,
      lessons: [
        {
          source: "PR #1 review",
          prNumber: 1,
          issueNumber: 42,
          lesson: "Always add null checks on optional parameters",
          category: "correctness",
          learnedAt: new Date().toISOString(),
          decayScore: 0.9,
        },
        {
          source: "PR #2 (rejected)",
          prNumber: 2,
          issueNumber: 43,
          lesson: "Do not modify migration files directly",
          category: "approach",
          learnedAt: new Date().toISOString(),
          decayScore: 0.8,
        },
      ],
      lastScanAt: new Date().toISOString(),
    };

    await writeFile(join(memoryDir, "lessons.json"), JSON.stringify(store), "utf-8");

    const result = await loadLessonsForPrompt(testDir, ".dispatch");
    assert.ok(result.includes("Lessons from Previous PR Reviews"));
    assert.ok(result.includes("null checks"));
    assert.ok(result.includes("migration files"));

    // Cleanup
    await rm(testDir, { recursive: true, force: true });
  });

  it("filters out low-relevance lessons", async () => {
    const testDir = join(tmpdir(), `dispatch-test-${Date.now()}`);
    const memoryDir = join(testDir, ".dispatch", "memory");
    await mkdir(memoryDir, { recursive: true });

    const store = {
      version: 1,
      lessons: [
        {
          source: "PR #1",
          prNumber: 1,
          issueNumber: 1,
          lesson: "Old lesson with low decay",
          category: "general",
          learnedAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(), // 90 days ago
          decayScore: 0.1,
        },
      ],
      lastScanAt: new Date().toISOString(),
    };

    await writeFile(join(memoryDir, "lessons.json"), JSON.stringify(store), "utf-8");

    const result = await loadLessonsForPrompt(testDir, ".dispatch");
    // Very old lessons should be filtered out
    assert.equal(result, "");

    await rm(testDir, { recursive: true, force: true });
  });
});

describe("Learn — lesson categorization", () => {
  // These are tested indirectly through the learn command behavior
  it("placeholder for learn integration tests", () => {
    // Integration tests would require a mock GitHub API
    assert.ok(true);
  });
});

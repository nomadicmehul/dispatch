import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadCheckpoint } from "../src/orchestrator/pipeline.js";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("Checkpoint System", () => {
  it("returns empty array when no checkpoint exists", async () => {
    const result = await loadCheckpoint("/tmp/nonexistent-dispatch-test", ".dispatch");
    assert.deepStrictEqual(result, []);
  });

  it("loads checkpoint with processed issues", async () => {
    const testDir = join(tmpdir(), `dispatch-checkpoint-test-${Date.now()}`);
    const stateDir = join(testDir, ".dispatch");
    await mkdir(stateDir, { recursive: true });

    const checkpoint = {
      processedIssues: [1, 3, 7],
      timestamp: new Date().toISOString(),
    };
    await writeFile(join(stateDir, "checkpoint.json"), JSON.stringify(checkpoint), "utf-8");

    const result = await loadCheckpoint(testDir, ".dispatch");
    assert.deepStrictEqual(result, [1, 3, 7]);

    await rm(testDir, { recursive: true, force: true });
  });

  it("handles malformed checkpoint gracefully", async () => {
    const testDir = join(tmpdir(), `dispatch-checkpoint-test-${Date.now()}`);
    const stateDir = join(testDir, ".dispatch");
    await mkdir(stateDir, { recursive: true });

    await writeFile(join(stateDir, "checkpoint.json"), "not-valid-json", "utf-8");

    const result = await loadCheckpoint(testDir, ".dispatch");
    assert.deepStrictEqual(result, []);

    await rm(testDir, { recursive: true, force: true });
  });
});

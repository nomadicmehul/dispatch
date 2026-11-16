import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyCliOverrides, DEFAULT_CONFIG } from "../src/utils/config.js";

describe("applyCliOverrides", () => {
  it("overrides engine", () => {
    const config = applyCliOverrides({ ...DEFAULT_CONFIG }, { engine: "gemini" });
    assert.equal(config.engine, "gemini");
  });

  it("overrides model", () => {
    const config = applyCliOverrides({ ...DEFAULT_CONFIG }, { model: "opus" });
    assert.equal(config.model, "opus");
  });

  it("overrides maxIssues", () => {
    const config = applyCliOverrides({ ...DEFAULT_CONFIG }, { maxIssues: 5 });
    assert.equal(config.maxIssues, 5);
  });

  it("overrides maxTurns to maxTurnsPerIssue", () => {
    const config = applyCliOverrides({ ...DEFAULT_CONFIG }, { maxTurns: 50 });
    assert.equal(config.maxTurnsPerIssue, 50);
  });

  it("overrides single label", () => {
    const config = applyCliOverrides({ ...DEFAULT_CONFIG }, { label: "bug" });
    assert.deepEqual(config.labels, ["bug"]);
  });

  it("overrides label array", () => {
    const config = applyCliOverrides({ ...DEFAULT_CONFIG }, { label: ["bug", "enhancement"] });
    assert.deepEqual(config.labels, ["bug", "enhancement"]);
  });

  it("overrides exclude", () => {
    const config = applyCliOverrides({ ...DEFAULT_CONFIG }, { exclude: "wontfix" });
    assert.deepEqual(config.exclude, ["wontfix"]);
  });

  it("overrides draft flag", () => {
    const config = applyCliOverrides({ ...DEFAULT_CONFIG }, { draft: true });
    assert.equal(config.createDraftPRs, true);
  });

  it("overrides baseBranch", () => {
    const config = applyCliOverrides({ ...DEFAULT_CONFIG }, { baseBranch: "develop" });
    assert.equal(config.baseBranch, "develop");
  });

  it("overrides concurrency", () => {
    const config = applyCliOverrides({ ...DEFAULT_CONFIG }, { concurrency: 5 });
    assert.equal(config.concurrency, 5);
  });

  it("preserves defaults when no overrides given", () => {
    const config = applyCliOverrides({ ...DEFAULT_CONFIG }, {});
    assert.deepEqual(config, DEFAULT_CONFIG);
  });

  it("does not modify original config", () => {
    const original = { ...DEFAULT_CONFIG };
    applyCliOverrides(original, { model: "opus" });
    assert.equal(original.model, DEFAULT_CONFIG.model);
  });
});

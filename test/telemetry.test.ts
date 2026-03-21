import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TelemetryCollector, categorizeFailure } from "../src/telemetry/collector.js";

describe("TelemetryCollector", () => {
  it("records issues checked count", () => {
    const collector = new TelemetryCollector();
    collector.recordIssuesChecked(15);

    const event = collector.buildEvent({
      anonymousId: "test-id",
      startedAt: "2026-01-01T00:00:00.000Z",
      durationMs: 1000,
      repoOwner: "owner",
      repoName: "repo",
      engine: "claude",
      model: "sonnet",
      concurrency: 3,
      maxIssues: 10,
      maxTurnsPerIssue: 10,
      draftThreshold: 5,
      createDraftPRs: false,
      prsCreated: 0,
    });

    assert.equal(event.issuesChecked, 15);
  });

  it("records and aggregates issue telemetry", () => {
    const collector = new TelemetryCollector();
    collector.recordIssuesChecked(3);

    collector.recordIssue({
      issueNumber: 1,
      classification: "code-fix",
      confidence: 8,
      solveTimeMs: 5000,
      status: "solved",
      changedFileCount: 2,
      isInvestigation: false,
    });

    collector.recordIssue({
      issueNumber: 2,
      classification: "feature",
      confidence: 6,
      solveTimeMs: 8000,
      status: "solved",
      changedFileCount: 5,
      isInvestigation: false,
    });

    collector.recordIssue({
      issueNumber: 3,
      classification: "code-fix",
      confidence: null,
      solveTimeMs: 2000,
      status: "failed",
      failureReason: "timeout exceeded",
      changedFileCount: 0,
      isInvestigation: false,
    });

    const event = collector.buildEvent({
      anonymousId: "test-id",
      startedAt: "2026-01-01T00:00:00.000Z",
      durationMs: 15000,
      repoOwner: "owner",
      repoName: "repo",
      engine: "claude",
      model: "sonnet",
      concurrency: 3,
      maxIssues: 10,
      maxTurnsPerIssue: 10,
      draftThreshold: 5,
      createDraftPRs: false,
      prsCreated: 2,
    });

    assert.equal(event.issuesProcessed, 3);
    assert.equal(event.issuesSolved, 2);
    assert.equal(event.issuesFailed, 1);
    assert.equal(event.issuesNoChanges, 0);
    assert.equal(event.prsCreated, 2);
    assert.deepEqual(event.classificationBreakdown, { "code-fix": 2, feature: 1 });
    assert.deepEqual(event.confidenceScores, [8, 6]);
    assert.deepEqual(event.solveTimes, [5000, 8000, 2000]);
    assert.deepEqual(event.failureCategories, ["timeout"]);
    assert.equal(event.avgChangedFiles, 7 / 3);
    assert.equal(event.investigationCount, 0);
  });

  it("tracks investigation count", () => {
    const collector = new TelemetryCollector();
    collector.recordIssuesChecked(2);

    collector.recordIssue({
      issueNumber: 1,
      classification: "investigation",
      confidence: 5,
      solveTimeMs: 3000,
      status: "solved",
      changedFileCount: 1,
      isInvestigation: true,
    });

    collector.recordIssue({
      issueNumber: 2,
      classification: "code-fix",
      confidence: 7,
      solveTimeMs: 4000,
      status: "solved",
      changedFileCount: 3,
      isInvestigation: false,
    });

    const event = collector.buildEvent({
      anonymousId: "test-id",
      startedAt: "2026-01-01T00:00:00.000Z",
      durationMs: 7000,
      repoOwner: "owner",
      repoName: "repo",
      engine: "claude",
      model: "sonnet",
      concurrency: 3,
      maxIssues: 10,
      maxTurnsPerIssue: 10,
      draftThreshold: 5,
      createDraftPRs: false,
      prsCreated: 2,
    });

    assert.equal(event.investigationCount, 1);
  });

  it("handles empty collector", () => {
    const collector = new TelemetryCollector();
    collector.recordIssuesChecked(0);

    const event = collector.buildEvent({
      anonymousId: "test-id",
      startedAt: "2026-01-01T00:00:00.000Z",
      durationMs: 100,
      repoOwner: "owner",
      repoName: "repo",
      engine: "claude",
      model: "sonnet",
      concurrency: 3,
      maxIssues: 10,
      maxTurnsPerIssue: 10,
      draftThreshold: 5,
      createDraftPRs: false,
      prsCreated: 0,
    });

    assert.equal(event.issuesChecked, 0);
    assert.equal(event.issuesProcessed, 0);
    assert.equal(event.avgChangedFiles, 0);
    assert.deepEqual(event.classificationBreakdown, {});
  });

  it("tracks solve start times", () => {
    const collector = new TelemetryCollector();
    collector.startSolve(42);
    const startTime = collector.getSolveStartTime(42);
    assert.ok(startTime !== undefined);
    assert.ok(startTime <= Date.now());
  });
});

describe("categorizeFailure", () => {
  it("maps timeout errors", () => {
    assert.equal(categorizeFailure("Operation timeout exceeded"), "timeout");
  });

  it("maps rate limit errors", () => {
    assert.equal(categorizeFailure("GitHub rate limit reached"), "rate-limit");
    assert.equal(categorizeFailure("API ratelimit exceeded"), "rate-limit");
  });

  it("maps auth errors", () => {
    assert.equal(categorizeFailure("Bad token: unauthorized"), "auth-error");
    assert.equal(categorizeFailure("Authentication failed"), "auth-error");
  });

  it("maps parse errors", () => {
    assert.equal(categorizeFailure("JSON parse error"), "parse-error");
    assert.equal(categorizeFailure("Failed to parse response"), "parse-error");
  });

  it("maps engine-not-found errors", () => {
    assert.equal(categorizeFailure("spawn ENOENT"), "engine-not-found");
    assert.equal(categorizeFailure("Could not spawn process"), "engine-not-found");
  });

  it("maps network errors", () => {
    assert.equal(categorizeFailure("Network error: connection refused"), "network-error");
    assert.equal(categorizeFailure("fetch failed"), "network-error");
  });

  it("returns unknown-error for unmatched", () => {
    assert.equal(categorizeFailure("something unexpected happened"), "unknown-error");
  });
});

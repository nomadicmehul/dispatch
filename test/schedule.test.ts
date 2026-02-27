import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateWorkflow, parseCronTime } from "../src/commands/schedule.js";
import type { AuthMethod } from "../src/commands/schedule.js";

// ---------------------------------------------------------------------------
// parseCronTime
// ---------------------------------------------------------------------------
describe("parseCronTime", () => {
  it("parses 'midnight' to 0 0 * * *", () => {
    assert.equal(parseCronTime("midnight"), "0 0 * * *");
  });

  it("parses 'noon' to 0 12 * * *", () => {
    assert.equal(parseCronTime("noon"), "0 12 * * *");
  });

  it("parses '2am' to 0 2 * * *", () => {
    assert.equal(parseCronTime("2am"), "0 2 * * *");
  });

  it("parses '3 pm' to 0 15 * * *", () => {
    assert.equal(parseCronTime("3 pm"), "0 15 * * *");
  });

  it("parses '12am' to 0 0 * * * (midnight)", () => {
    assert.equal(parseCronTime("12am"), "0 0 * * *");
  });

  it("parses '12pm' to 0 12 * * * (noon)", () => {
    assert.equal(parseCronTime("12pm"), "0 12 * * *");
  });

  it("parses HH:MM format '14:30'", () => {
    assert.equal(parseCronTime("14:30"), "30 14 * * *");
  });

  it("parses '0:00' as midnight", () => {
    assert.equal(parseCronTime("0:00"), "0 0 * * *");
  });

  it("returns null for invalid input", () => {
    assert.equal(parseCronTime("not-a-time"), null);
  });

  it("returns null for out-of-range time", () => {
    assert.equal(parseCronTime("25:99"), null);
  });
});

// ---------------------------------------------------------------------------
// generateWorkflow — api-key (personal)
// ---------------------------------------------------------------------------
describe("generateWorkflow (api-key)", () => {
  const yaml = generateWorkflow("0 2 * * *", 10, false, [], "api-key");

  it("contains the cron schedule", () => {
    assert.ok(yaml.includes('cron: "0 2 * * *"'));
  });

  it("includes ANTHROPIC_API_KEY secret", () => {
    assert.ok(yaml.includes("ANTHROPIC_API_KEY"));
  });

  it("installs dispatch-ai@beta", () => {
    assert.ok(yaml.includes("dispatch-ai@beta"));
  });

  it("installs claude code CLI", () => {
    assert.ok(yaml.includes("@anthropic-ai/claude-code"));
  });

  it("does NOT include id-token permission", () => {
    assert.ok(!yaml.includes("id-token"));
  });

  it("does NOT reference claude-code-action", () => {
    assert.ok(!yaml.includes("anthropic/claude-code-action"));
  });

  it("includes --draft flag when draft is true", () => {
    const draftYaml = generateWorkflow("0 2 * * *", 5, true, [], "api-key");
    assert.ok(draftYaml.includes("--draft"));
  });

  it("includes --label flag when labels are provided", () => {
    const labelYaml = generateWorkflow("0 2 * * *", 10, false, ["bug", "p0"], "api-key");
    assert.ok(labelYaml.includes("--label bug p0"));
  });

  it("uses the provided max-issues value", () => {
    const customYaml = generateWorkflow("0 6 * * 1", 3, false, [], "api-key");
    assert.ok(customYaml.includes("'3'"));
  });
});

// ---------------------------------------------------------------------------
// generateWorkflow — claude-code (enterprise)
// ---------------------------------------------------------------------------
describe("generateWorkflow (claude-code)", () => {
  const yaml = generateWorkflow("0 2 * * *", 10, false, [], "claude-code");

  it("contains the cron schedule", () => {
    assert.ok(yaml.includes('cron: "0 2 * * *"'));
  });

  it("does NOT include ANTHROPIC_API_KEY", () => {
    assert.ok(!yaml.includes("ANTHROPIC_API_KEY"));
  });

  it("includes id-token write permission for OIDC", () => {
    assert.ok(yaml.includes("id-token: write"));
  });

  it("uses anthropic/claude-code-action", () => {
    assert.ok(yaml.includes("anthropic/claude-code-action@v1"));
  });

  it("installs dispatch-ai@beta", () => {
    assert.ok(yaml.includes("dispatch-ai@beta"));
  });

  it("does NOT install claude code CLI separately (action handles it)", () => {
    assert.ok(!yaml.includes("@anthropic-ai/claude-code"));
  });

  it("includes --draft flag when draft is true", () => {
    const draftYaml = generateWorkflow("0 2 * * *", 5, true, [], "claude-code");
    assert.ok(draftYaml.includes("--draft"));
  });

  it("includes --label flag when labels are provided", () => {
    const labelYaml = generateWorkflow("0 2 * * *", 10, false, ["bug"], "claude-code");
    assert.ok(labelYaml.includes("--label bug"));
  });
});

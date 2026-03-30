import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

describe("OpenAIEngine", () => {
  const originalKey = process.env.OPENAI_API_KEY;

  afterEach(() => {
    if (originalKey) {
      process.env.OPENAI_API_KEY = originalKey;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("throws if OPENAI_API_KEY is not set", async () => {
    delete process.env.OPENAI_API_KEY;
    const { OpenAIEngine } = await import("../src/engine/openai.js");
    assert.throws(
      () => new OpenAIEngine({ model: "gpt-4.1", maxTurns: 5 }),
      /OPENAI_API_KEY/
    );
  });

  it("creates engine when OPENAI_API_KEY is set", async () => {
    process.env.OPENAI_API_KEY = "sk-test-key";
    const { OpenAIEngine } = await import("../src/engine/openai.js");
    const engine = new OpenAIEngine({ model: "gpt-4.1", maxTurns: 5 });
    assert.equal(engine.name, "openai");
  });
});

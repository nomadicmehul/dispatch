import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { GeminiEngine } from "../src/engine/gemini.js";

// ─── GeminiEngine constructor ────────────────────────────────────────

describe("GeminiEngine", () => {
  const originalGeminiKey = process.env.GEMINI_API_KEY;
  const originalGoogleKey = process.env.GOOGLE_API_KEY;

  afterEach(() => {
    if (originalGeminiKey !== undefined) {
      process.env.GEMINI_API_KEY = originalGeminiKey;
    } else {
      delete process.env.GEMINI_API_KEY;
    }
    if (originalGoogleKey !== undefined) {
      process.env.GOOGLE_API_KEY = originalGoogleKey;
    } else {
      delete process.env.GOOGLE_API_KEY;
    }
  });

  it("throws if neither GEMINI_API_KEY nor GOOGLE_API_KEY is set", () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;

    assert.throws(
      () => new GeminiEngine({ model: "gemini-2.5-pro", maxTurns: 5 }),
      /GEMINI_API_KEY or GOOGLE_API_KEY is required/,
    );
  });

  it("creates engine when GEMINI_API_KEY is set", () => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    delete process.env.GOOGLE_API_KEY;

    const engine = new GeminiEngine({ model: "gemini-2.5-pro", maxTurns: 5 });
    assert.equal(engine.name, "gemini");
  });

  it("creates engine when GOOGLE_API_KEY is set (fallback)", () => {
    delete process.env.GEMINI_API_KEY;
    process.env.GOOGLE_API_KEY = "test-google-key";

    const engine = new GeminiEngine({ model: "gemini-2.5-pro", maxTurns: 5 });
    assert.equal(engine.name, "gemini");
  });

  it("prefers GEMINI_API_KEY over GOOGLE_API_KEY", () => {
    process.env.GEMINI_API_KEY = "gemini-key";
    process.env.GOOGLE_API_KEY = "google-key";

    const engine = new GeminiEngine({ model: "gemini-2.5-pro", maxTurns: 5 });
    assert.equal(engine.name, "gemini");
  });

  it("engine name is correct", () => {
    process.env.GEMINI_API_KEY = "test-key";
    const engine = new GeminiEngine({ model: "gemini-2.5-flash", maxTurns: 10 });
    assert.equal(engine.name, "gemini");
  });
});

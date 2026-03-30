import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AIProvider } from "./types.js";

const exec = promisify(execFile);

interface DetectedProvider {
  provider: AIProvider;
  available: boolean;
  reason?: string;
}

/**
 * Detect which AI providers are available in the current environment.
 * Checks API keys and installed CLI tools.
 */
export async function detectProviders(): Promise<DetectedProvider[]> {
  const results: DetectedProvider[] = [];

  // Anthropic: check for ANTHROPIC_API_KEY or claude CLI
  const hasAnthropicKey = !!process.env.ANTHROPIC_API_KEY;
  let hasClaudeCli = false;
  try {
    await exec("claude", ["--version"], { timeout: 5000 });
    hasClaudeCli = true;
  } catch {
    // not installed
  }
  results.push({
    provider: "anthropic",
    available: hasAnthropicKey || hasClaudeCli,
    reason: hasAnthropicKey
      ? "ANTHROPIC_API_KEY set"
      : hasClaudeCli
        ? "claude CLI installed"
        : "No ANTHROPIC_API_KEY and claude CLI not found",
  });

  // Gemini: check for GEMINI_API_KEY or GOOGLE_API_KEY
  const hasGeminiKey = !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
  results.push({
    provider: "gemini",
    available: hasGeminiKey,
    reason: hasGeminiKey ? "API key set" : "No GEMINI_API_KEY or GOOGLE_API_KEY",
  });

  // GitHub Models: check for GITHUB_TOKEN (also used for repo access)
  const hasGHToken = !!process.env.GITHUB_TOKEN;
  results.push({
    provider: "github-models",
    available: hasGHToken,
    reason: hasGHToken ? "GITHUB_TOKEN set" : "No GITHUB_TOKEN",
  });

  // OpenAI: check for OPENAI_API_KEY
  const hasOpenAIKey = !!process.env.OPENAI_API_KEY;
  results.push({
    provider: "openai",
    available: hasOpenAIKey,
    reason: hasOpenAIKey ? "OPENAI_API_KEY set" : "No OPENAI_API_KEY",
  });

  return results;
}

/** Get all detected providers with their status */
export function getDetectedProvidersSummary(): DetectedProvider[] {
  // Sync version for display purposes
  const results: DetectedProvider[] = [];
  const hasAnthropicKey = !!process.env.ANTHROPIC_API_KEY;
  results.push({
    provider: "anthropic",
    available: hasAnthropicKey,
    reason: hasAnthropicKey ? "ANTHROPIC_API_KEY set" : "No ANTHROPIC_API_KEY",
  });
  const hasGeminiKey = !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
  results.push({
    provider: "gemini",
    available: hasGeminiKey,
    reason: hasGeminiKey ? "API key set" : "No GEMINI_API_KEY or GOOGLE_API_KEY",
  });
  const hasGHToken = !!process.env.GITHUB_TOKEN;
  results.push({
    provider: "github-models",
    available: hasGHToken,
    reason: hasGHToken ? "GITHUB_TOKEN set" : "No GITHUB_TOKEN",
  });
  const hasOpenAIKey = !!process.env.OPENAI_API_KEY;
  results.push({
    provider: "openai",
    available: hasOpenAIKey,
    reason: hasOpenAIKey ? "OPENAI_API_KEY set" : "No OPENAI_API_KEY",
  });
  return results;
}

/** Get the first available provider, preferring in order: anthropic > gemini > github-models > openai */
export async function getDefaultProvider(): Promise<AIProvider | null> {
  const providers = await detectProviders();
  const preferred: AIProvider[] = ["anthropic", "gemini", "github-models", "openai"];
  for (const p of preferred) {
    const match = providers.find((d) => d.provider === p && d.available);
    if (match) return match.provider;
  }
  return null;
}

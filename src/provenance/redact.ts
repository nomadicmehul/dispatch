import { secretValues } from "../utils/env.js";

const REDACTED = "[REDACTED]";

/** Well-known credential formats */
const SECRET_PATTERNS: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,                       // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,                      // GitHub fine-grained PATs
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g,                           // Anthropic keys and OAuth tokens
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,                     // OpenAI keys
  /\bAKIA[0-9A-Z]{16}\b/g,                                  // AWS access key IDs
  /\bAIza[0-9A-Za-z_-]{35}\b/g,                             // Google API keys
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,                        // Slack tokens
  /\bnpm_[A-Za-z0-9]{36}\b/g,                               // npm tokens
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Best-effort secret redaction for transcripts and logs.
 * Removes well-known token formats plus the literal values of credential-looking
 * environment variables. Redaction keeps JSON valid: the replacement has no quotes.
 */
export function redactSecrets(text: string, values: string[] = secretValues()): string {
  let result = text;
  for (const value of values) {
    result = result.replace(new RegExp(escapeRegExp(value), "g"), REDACTED);
  }
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, REDACTED);
  }
  return result;
}

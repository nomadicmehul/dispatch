/**
 * Git commit trailers that link a commit back to the Dispatch session that wrote it.
 * Trailers survive rebases and cherry-picks, and GitHub keeps them in squash-merge
 * bodies by default, so `dispatch explain` can find the session from any copy of the commit.
 */

export const SESSION_TRAILER = "Dispatch-Session";

/** Append trailers as the final paragraph of a commit message */
export function appendTrailers(message: string, trailers: Record<string, string | undefined>): string {
  const lines = Object.entries(trailers)
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([key, value]) => `${key}: ${value.replace(/\s*\n\s*/g, " ")}`);

  if (lines.length === 0) return message;
  return `${message.trimEnd()}\n\n${lines.join("\n")}`;
}

/** Parse `Key: value` trailers from the last paragraph of a commit message */
export function parseTrailers(message: string): Record<string, string> {
  const paragraphs = message.trim().split(/\n\s*\n/);
  const last = paragraphs[paragraphs.length - 1] ?? "";
  const trailers: Record<string, string> = {};

  for (const line of last.split("\n")) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9-]*):\s*(.+)$/);
    if (match) trailers[match[1]] = match[2].trim();
  }

  return trailers;
}

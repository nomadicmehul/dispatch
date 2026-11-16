/** Environment variable names that look like credentials */
const SECRET_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|API_KEY|ACCESS_KEY|_PAT$/i;

/** True if an environment variable name looks like it holds a credential */
export function isSecretName(name: string): boolean {
  return SECRET_NAME.test(name);
}

/**
 * Copy an environment without credential-looking variables.
 * Names matching any `keep` pattern survive, so an engine can keep the one
 * credential it needs (e.g. ANTHROPIC_API_KEY) while GITHUB_TOKEN and the rest are dropped.
 */
export function scrubEnv(env: NodeJS.ProcessEnv, keep: RegExp[] = []): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (isSecretName(name) && !keep.some((pattern) => pattern.test(name))) continue;
    result[name] = value;
  }
  return result;
}

/** Values of credential-looking variables, for redacting them from transcripts and logs */
export function secretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.entries(env)
    .filter(([name, value]) => isSecretName(name) && typeof value === "string" && value.length >= 8)
    .map(([, value]) => value as string);
}

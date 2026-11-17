import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SENTINEL_API_KEY, SENTINEL_OAUTH_TOKEN, vertexHost, type GatewayProvider } from "./gateway.js";
import { CLAUDE_CREDENTIAL_VARS, CREDENTIAL_HINT } from "./types.js";

/**
 * Where a sandboxed Claude gets its model: the Anthropic API, or Claude on Amazon Bedrock,
 * Google Cloud Vertex AI or Microsoft Foundry, chosen with Claude Code's own variables
 * (CLAUDE_CODE_USE_BEDROCK, CLAUDE_CODE_USE_VERTEX, CLAUDE_CODE_USE_FOUNDRY). For each, this
 * says which hosts Claude calls, which variables hold the credential, and how the gateway
 * stands in for it.
 */
export type ClaudeProvider = GatewayProvider;

export const PROVIDER_LABELS: Record<ClaudeProvider, string> = {
  anthropic: "Anthropic API",
  bedrock: "Amazon Bedrock",
  vertex: "Google Cloud Vertex AI",
  foundry: "Microsoft Foundry",
};

const enabled = (value: string | undefined) => !!value && !/^(0|false)$/i.test(value);

const USE_FLAGS: Array<[string, ClaudeProvider]> = [
  ["CLAUDE_CODE_USE_BEDROCK", "bedrock"],
  ["CLAUDE_CODE_USE_VERTEX", "vertex"],
  ["CLAUDE_CODE_USE_FOUNDRY", "foundry"],
];

/** The provider Claude Code would use with this environment */
export function claudeProvider(env: NodeJS.ProcessEnv = process.env): ClaudeProvider {
  return USE_FLAGS.find(([name]) => enabled(env[name]))?.[1] ?? "anthropic";
}

/**
 * Non-secret Claude Code settings passed into the agent's container when set: model pins
 * (on the cloud providers the `sonnet`/`opus` aliases resolve through them) and options.
 */
const SETTING_VARS = [
  /^ANTHROPIC_DEFAULT_[A-Z0-9_]+$/,
  /^ANTHROPIC_MODEL$/,
  /^ANTHROPIC_SMALL_FAST_MODEL$/,
  /^ANTHROPIC_BEDROCK_REGION_PREFIX$/,
  /^ANTHROPIC_BEDROCK_SERVICE_TIER$/,
  /^VERTEX_REGION_CLAUDE_[A-Z0-9_]+$/,
  /^CLAUDE_CODE_DISABLE_1M_CONTEXT$/,
  /^DISABLE_PROMPT_CACHING$/,
  /^ENABLE_PROMPT_CACHING_1H$/,
];

export function settingVars(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(env).filter((name) => env[name] && SETTING_VARS.some((pattern) => pattern.test(name))).sort();
}

export interface ProviderPlan {
  provider: ClaudeProvider;
  label: string;
  /** Hosts Claude calls when it holds the credential itself (srt, docker with credentials: env) */
  directHosts: string[];
  /** Hosts the gateway calls for it, for the session record */
  gatewayHosts: string[];
  /** Variables holding the credential that are set: passed by name, never by value */
  credentialVars: string[];
  /** A credential file to make readable (Vertex Application Default Credentials) */
  credentialFile?: string;
  /** Non-secret provider variables Claude needs when it holds the credential itself */
  directVars: string[];
  /** The agent's environment behind the gateway, given the gateway's base URL */
  gatewayAgentEnv(baseUrl: string): Record<string, string>;
  /** The gateway's non-secret settings, for the proxy container */
  gatewayEnv: Record<string, string>;
}

const isSet = (env: NodeJS.ProcessEnv, names: string[]) => names.filter((name) => env[name]);
const hostOf = (url: string | undefined) => {
  try {
    return url ? new URL(url).hostname : undefined;
  } catch {
    return undefined;
  }
};

/** The Application Default Credentials file Google's libraries would use, if there is one */
export function googleCredentialsFile(env: NodeJS.ProcessEnv = process.env, home = homedir()): string | undefined {
  if (env.GOOGLE_APPLICATION_CREDENTIALS) return env.GOOGLE_APPLICATION_CREDENTIALS;
  const adc = join(env.CLOUDSDK_CONFIG || join(home, ".config", "gcloud"), "application_default_credentials.json");
  return existsSync(adc) ? adc : undefined;
}

function googleCredentialType(file: string | undefined): string | undefined {
  if (!file) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf-8")).type;
  } catch {
    return "unreadable";
  }
}

const BEDROCK_CREDENTIAL_VARS = ["AWS_BEARER_TOKEN_BEDROCK", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"];
const FOUNDRY_CREDENTIAL_VARS = ["ANTHROPIC_FOUNDRY_AUTH_TOKEN", "ANTHROPIC_FOUNDRY_API_KEY"];

export function providerPlan(env: NodeJS.ProcessEnv = process.env, home = homedir()): ProviderPlan {
  const provider = claudeProvider(env);
  const label = PROVIDER_LABELS[provider];

  if (provider === "bedrock") {
    const region = env.AWS_REGION || env.AWS_DEFAULT_REGION || "us-east-1";
    const fastRegion = env.ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION;
    const custom = hostOf(env.ANTHROPIC_BEDROCK_BASE_URL);
    const regions = [...new Set([region, ...(fastRegion ? [fastRegion] : [])])];
    return {
      provider,
      label,
      directHosts: custom ? [custom] : regions.flatMap((r) => [`bedrock-runtime.${r}.amazonaws.com`, `bedrock.${r}.amazonaws.com`]),
      gatewayHosts: [`bedrock-runtime.${region}.amazonaws.com`, `bedrock.${region}.amazonaws.com`],
      // With a Bedrock API key Claude Code ignores the AWS credentials, so only it is passed
      credentialVars: env.AWS_BEARER_TOKEN_BEDROCK ? ["AWS_BEARER_TOKEN_BEDROCK"] : isSet(env, BEDROCK_CREDENTIAL_VARS),
      directVars: isSet(env, ["CLAUDE_CODE_USE_BEDROCK", "AWS_REGION", "AWS_DEFAULT_REGION", "ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION", "ANTHROPIC_BEDROCK_BASE_URL"]),
      gatewayAgentEnv: (baseUrl) => ({
        CLAUDE_CODE_USE_BEDROCK: "1",
        CLAUDE_CODE_SKIP_BEDROCK_AUTH: "1",
        ANTHROPIC_BEDROCK_BASE_URL: baseUrl,
        AWS_REGION: region,
      }),
      gatewayEnv: { GATEWAY_PROVIDER: "bedrock", GATEWAY_REGION: region },
    };
  }

  if (provider === "vertex") {
    const project = env.ANTHROPIC_VERTEX_PROJECT_ID ?? "";
    const region = env.CLOUD_ML_REGION || "us-east5";
    const locations = [...new Set([
      region,
      ...Object.keys(env).filter((name) => /^VERTEX_REGION_CLAUDE_/.test(name)).map((name) => env[name] ?? ""),
    ])].filter((loc) => /^[a-z0-9-]+$/.test(loc));
    const file = googleCredentialsFile(env, home);
    const custom = hostOf(env.ANTHROPIC_VERTEX_BASE_URL);
    // Claude refreshes Google credentials itself when it holds them
    const tokenHosts = googleCredentialType(file) === "external_account"
      ? ["oauth2.googleapis.com", "sts.googleapis.com", "iamcredentials.googleapis.com"]
      : ["oauth2.googleapis.com"];
    return {
      provider,
      label,
      directHosts: [...(custom ? [custom] : locations.map(vertexHost)), ...tokenHosts],
      gatewayHosts: locations.map(vertexHost),
      credentialVars: isSet(env, ["GOOGLE_OAUTH_ACCESS_TOKEN"]),
      credentialFile: file,
      directVars: isSet(env, ["CLAUDE_CODE_USE_VERTEX", "ANTHROPIC_VERTEX_PROJECT_ID", "CLOUD_ML_REGION", "ANTHROPIC_VERTEX_BASE_URL"]),
      gatewayAgentEnv: (baseUrl) => ({
        CLAUDE_CODE_USE_VERTEX: "1",
        CLAUDE_CODE_SKIP_VERTEX_AUTH: "1",
        // Claude Code appends /projects/... to the base URL; Vertex's API lives under /v1
        ANTHROPIC_VERTEX_BASE_URL: `${baseUrl}/v1`,
        ANTHROPIC_VERTEX_PROJECT_ID: project,
        CLOUD_ML_REGION: region,
      }),
      gatewayEnv: { GATEWAY_PROVIDER: "vertex", GATEWAY_PROJECT: project, GATEWAY_LOCATIONS: locations.join(",") },
    };
  }

  if (provider === "foundry") {
    let host = env.ANTHROPIC_FOUNDRY_RESOURCE ? `${env.ANTHROPIC_FOUNDRY_RESOURCE}.services.ai.azure.com` : "";
    let basePath = "/anthropic";
    if (env.ANTHROPIC_FOUNDRY_BASE_URL) {
      try {
        const url = new URL(env.ANTHROPIC_FOUNDRY_BASE_URL);
        host = url.hostname;
        basePath = url.pathname.replace(/\/+$/, "") || "";
      } catch {
        // reported by providerProblem
      }
    }
    const bearer = !!env.ANTHROPIC_FOUNDRY_AUTH_TOKEN;
    return {
      provider,
      label,
      directHosts: host ? [host] : [],
      gatewayHosts: host ? [host] : [],
      credentialVars: isSet(env, FOUNDRY_CREDENTIAL_VARS),
      directVars: isSet(env, ["CLAUDE_CODE_USE_FOUNDRY", "ANTHROPIC_FOUNDRY_RESOURCE", "ANTHROPIC_FOUNDRY_BASE_URL"]),
      gatewayAgentEnv: (baseUrl) => ({
        CLAUDE_CODE_USE_FOUNDRY: "1",
        ANTHROPIC_FOUNDRY_BASE_URL: baseUrl,
        // A placeholder of the same kind as the real credential; the gateway swaps it
        ...(bearer ? { ANTHROPIC_FOUNDRY_AUTH_TOKEN: SENTINEL_OAUTH_TOKEN } : { ANTHROPIC_FOUNDRY_API_KEY: SENTINEL_API_KEY }),
      }),
      gatewayEnv: { GATEWAY_PROVIDER: "foundry", GATEWAY_HOST: host, GATEWAY_BASE_PATH: basePath },
    };
  }

  return {
    provider,
    label,
    directHosts: ["api.anthropic.com"],
    gatewayHosts: ["api.anthropic.com"],
    credentialVars: isSet(env, CLAUDE_CREDENTIAL_VARS),
    directVars: [],
    gatewayAgentEnv: (baseUrl) => ({
      ANTHROPIC_BASE_URL: baseUrl,
      ...(env.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: SENTINEL_API_KEY } : { CLAUDE_CODE_OAUTH_TOKEN: SENTINEL_OAUTH_TOKEN }),
    }),
    gatewayEnv: { GATEWAY_PROVIDER: "anthropic" },
  };
}

/**
 * Why a sandboxed Claude can't reach its model provider with this environment, or null.
 * `gateway`: the credential stays outside (docker default); `direct`: Claude holds it (srt,
 * or docker with credentials: env). Either way the sandbox hides ~/.aws, ~/.azure and the
 * keychain, so credentials must come from the environment (or, for Vertex, a key file).
 */
export function providerProblem(env: NodeJS.ProcessEnv, mode: "gateway" | "direct", home = homedir()): string | null {
  const on = USE_FLAGS.filter(([name]) => enabled(env[name])).map(([name]) => name);
  if (on.length > 1) return `Set only one of ${on.join(", ")}.`;
  if (enabled(env.CLAUDE_CODE_USE_MANTLE)) return "Sandbox mode doesn't support the Bedrock Mantle endpoint yet. Unset CLAUDE_CODE_USE_MANTLE.";

  const plan = providerPlan(env, home);
  const ownGateway = mode === "gateway" && (
    (plan.provider === "bedrock" && (env.ANTHROPIC_BEDROCK_BASE_URL || enabled(env.CLAUDE_CODE_SKIP_BEDROCK_AUTH))) ||
    (plan.provider === "vertex" && (env.ANTHROPIC_VERTEX_BASE_URL || enabled(env.CLAUDE_CODE_SKIP_VERTEX_AUTH))) ||
    (plan.provider === "foundry" && enabled(env.CLAUDE_CODE_SKIP_FOUNDRY_AUTH))
  );
  if (ownGateway) {
    return `Your ${plan.label} settings route Claude through your own gateway, which Dispatch's credential gateway can't stand in for. Set sandboxCredentials to "env" in .dispatchrc.json.`;
  }

  switch (plan.provider) {
    case "bedrock":
      if (env.AWS_BEARER_TOKEN_BEDROCK || (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY)) return null;
      return (
        "Sandbox mode can't read ~/.aws, so Bedrock credentials must be in the environment. " +
        "Set AWS_BEARER_TOKEN_BEDROCK (a Bedrock API key), or export your profile's credentials " +
        "(works for SSO profiles too): eval \"$(aws configure export-credentials --format env)\""
      );
    case "vertex": {
      if (!env.ANTHROPIC_VERTEX_PROJECT_ID) return "Set ANTHROPIC_VERTEX_PROJECT_ID to your Google Cloud project.";
      const type = googleCredentialType(plan.credentialFile);
      if (mode === "gateway") {
        if (env.GOOGLE_OAUTH_ACCESS_TOKEN || type === "service_account" || type === "authorized_user") return null;
        if (type) {
          return (
            `The gateway can't use a "${type}" credential file (${plan.credentialFile}). Use a service account key or ` +
            "`gcloud auth application-default login`, or set GOOGLE_OAUTH_ACCESS_TOKEN " +
            "(in GitHub Actions: google-github-actions/auth with token_format: access_token)."
          );
        }
      } else if (type && type !== "unreadable") {
        return null;
      }
      return (
        "No Google credentials found. Run `gcloud auth application-default login`, or set " +
        "GOOGLE_APPLICATION_CREDENTIALS to a service account key file" +
        (mode === "gateway" ? ", or set GOOGLE_OAUTH_ACCESS_TOKEN." : ".")
      );
    }
    case "foundry":
      if (!plan.gatewayHosts.length) return "Set ANTHROPIC_FOUNDRY_RESOURCE to your Foundry resource name (or ANTHROPIC_FOUNDRY_BASE_URL).";
      if (plan.credentialVars.length) return null;
      return (
        "Sandbox mode can't use your az login, so set ANTHROPIC_FOUNDRY_API_KEY, or an Entra ID access " +
        "token for your Foundry resource in ANTHROPIC_FOUNDRY_AUTH_TOKEN."
      );
    default:
      return plan.credentialVars.length ? null : CREDENTIAL_HINT;
  }
}

/**
 * The model-provider side of the credential gateway: where a sandboxed Claude's request
 * goes, and the credential added to it on the way. Claude in the agent container sends its
 * requests to the gateway without a real credential (a placeholder, or no auth at all for
 * the cloud providers); the gateway runs in the proxy container, which holds the credential.
 *
 * Standalone on purpose: Node built-ins only, so it runs from a plain node image next to
 * egress-proxy.js.
 */
import { createHash, createHmac, createSign } from "node:crypto";
import { readFileSync } from "node:fs";

export type GatewayProvider = "anthropic" | "bedrock" | "vertex" | "foundry";

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface GatewayConfig {
  provider: GatewayProvider;
  /** Anthropic or Foundry API key (x-api-key) */
  apiKey?: string;
  /** Anthropic subscription token, Foundry Entra ID token or Bedrock API key (Authorization: Bearer) */
  bearerToken?: string;
  /** Foundry: the resource host, e.g. my-resource.services.ai.azure.com, and its API path */
  host?: string;
  basePath?: string;
  /** Bedrock: region and AWS credentials (used when there is no Bedrock API key) */
  region?: string;
  aws?: AwsCredentials;
  /** Vertex: the only project and locations requests may address, and where tokens come from */
  project?: string;
  locations?: string[];
  google?: GoogleToken;
  /** Tests only: send every request to this URL instead of the provider (the Host header stays) */
  upstream?: string;
}

export interface GatewayRoute {
  host: string;
  path: string;
}

/** Vertex AI host for a location: global, multi-region (us, eu) or a region */
export function vertexHost(location: string): string {
  if (location === "global") return "aiplatform.googleapis.com";
  if (location === "us" || location === "eu") return `aiplatform.${location}.rep.googleapis.com`;
  return `${location}-aiplatform.googleapis.com`;
}

/** RFC 3986 encoding, as AWS Signature Version 4 requires */
export function awsEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * A request path with each segment encoded the way the AWS SDK sends it. Claude Code sends
 * model IDs with a bare ":" (e.g. ...-v1:0); the SDK sends %3A, and the signature covers it.
 */
export function normalizeAwsPath(path: string): string {
  const [pathname, query] = path.split(/\?(.*)/s);
  const encoded = pathname.split("/").map((segment) => {
    try {
      return awsEncode(decodeURIComponent(segment));
    } catch {
      return awsEncode(segment);
    }
  }).join("/");
  return query === undefined ? encoded : `${encoded}?${query}`;
}

/**
 * Where a request from the agent goes, or null when the gateway won't send it anywhere.
 * Each provider gets only its model API: the gateway holds a real credential, so it must
 * not become a way to call the provider's other APIs with it.
 */
export function gatewayRoute(cfg: GatewayConfig, method: string, path: string): GatewayRoute | null {
  switch (cfg.provider) {
    case "anthropic":
      return { host: "api.anthropic.com", path };
    case "foundry":
      if (!cfg.host || !path.startsWith("/v1/")) return null;
      return { host: cfg.host, path: `${cfg.basePath ?? "/anthropic"}${path}` };
    case "bedrock": {
      if (!cfg.region) return null;
      if (method === "POST" && /^\/model\/[^/?]+\/[\w-]+(\?.*)?$/.test(path)) {
        return { host: `bedrock-runtime.${cfg.region}.amazonaws.com`, path: normalizeAwsPath(path) };
      }
      // Model discovery: Claude Code lists inference profiles to pick model IDs
      if (method === "GET" && /^\/inference-profiles(\/[^/?]+)?(\?.*)?$/.test(path)) {
        return { host: `bedrock.${cfg.region}.amazonaws.com`, path: normalizeAwsPath(path) };
      }
      return null;
    }
    case "vertex": {
      const match = path.match(/^\/v1\/projects\/([^/]+)\/locations\/([a-z0-9-]+)\/publishers\/anthropic\/models\/[^/?]+(\?.*)?$/);
      if (!match || match[1] !== cfg.project || !(cfg.locations ?? []).includes(match[2])) return null;
      return { host: vertexHost(match[2]), path };
    }
  }
  return null;
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest();

/**
 * AWS Signature Version 4 headers for one request. `path` is the path as sent on the wire
 * (already encoded); `headers` are extra headers to sign besides host and x-amz-date.
 */
export function signAwsV4(input: {
  method: string;
  host: string;
  path: string;
  headers?: Record<string, string>;
  body?: Buffer | string;
  region: string;
  service: string;
  credentials: AwsCredentials;
  date?: Date;
}): Record<string, string> {
  const amzDate = (input.date ?? new Date()).toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const [pathname, query = ""] = input.path.split(/\?(.*)/s);

  const signed: Record<string, string> = {
    ...Object.fromEntries(Object.entries(input.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v.trim()])),
    host: input.host,
    "x-amz-date": amzDate,
  };
  if (input.credentials.sessionToken) signed["x-amz-security-token"] = input.credentials.sessionToken;
  const names = Object.keys(signed).sort();

  // Services other than S3 encode the (already encoded) path once more
  const canonicalPath = pathname.split("/").map(awsEncode).join("/") || "/";
  const canonicalQuery = query
    .split("&")
    .filter(Boolean)
    .map((pair) => {
      const [k, v = ""] = pair.split(/=(.*)/s);
      const decode = (s: string) => decodeURIComponent(s.replace(/\+/g, " "));
      return [awsEncode(decode(k)), awsEncode(decode(v))];
    })
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonicalRequest = [
    input.method,
    canonicalPath,
    canonicalQuery,
    names.map((n) => `${n}:${signed[n]}\n`).join(""),
    names.join(";"),
    sha256(input.body ?? ""),
  ].join("\n");

  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${input.credentials.secretAccessKey}`, day), input.region), input.service), "aws4_request");
  const signature = createHmac("sha256", key).update(stringToSign).digest("hex");

  const out: Record<string, string> = {
    "x-amz-date": amzDate,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`,
  };
  if (input.credentials.sessionToken) out["x-amz-security-token"] = input.credentials.sessionToken;
  return out;
}

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const base64url = (data: string | Buffer) => Buffer.from(data).toString("base64url");

/**
 * Google access tokens for Vertex AI: a fixed token, or minted from an Application Default
 * Credentials file (a service account key, or the user credentials `gcloud auth
 * application-default login` writes) and refreshed before they expire.
 */
export class GoogleToken {
  private cached?: { token: string; expires: number };
  private pending?: Promise<string>;

  constructor(private readonly source: { accessToken?: string; credentialsFile?: string }) {}

  async token(): Promise<string> {
    if (this.source.accessToken) return this.source.accessToken;
    if (this.cached && this.cached.expires - 5 * 60_000 > Date.now()) return this.cached.token;
    this.pending ??= this.fetchToken().finally(() => (this.pending = undefined));
    return this.pending;
  }

  private async fetchToken(): Promise<string> {
    if (!this.source.credentialsFile) throw new Error("no Google credentials");
    const creds = JSON.parse(readFileSync(this.source.credentialsFile, "utf-8"));
    let url = GOOGLE_TOKEN_URL;
    let form: Record<string, string>;
    if (creds.type === "service_account") {
      url = creds.token_uri || GOOGLE_TOKEN_URL;
      const now = Math.floor(Date.now() / 1000);
      const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(
        JSON.stringify({ iss: creds.client_email, scope: CLOUD_PLATFORM_SCOPE, aud: url, iat: now, exp: now + 3600 }),
      )}`;
      const signature = createSign("RSA-SHA256").update(unsigned).sign(creds.private_key);
      form = { grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${base64url(signature)}` };
    } else if (creds.type === "authorized_user") {
      form = {
        grant_type: "refresh_token",
        client_id: creds.client_id,
        client_secret: creds.client_secret,
        refresh_token: creds.refresh_token,
      };
    } else {
      throw new Error(`unsupported Google credential type "${creds.type}"`);
    }
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    });
    if (!res.ok) throw new Error(`Google token endpoint answered ${res.status}`);
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new Error("Google token endpoint returned no access_token");
    this.cached = { token: json.access_token, expires: Date.now() + (json.expires_in ?? 3600) * 1000 };
    return json.access_token;
  }
}

/** The placeholder credentials sandboxed agents get; the gateway swaps in the real ones */
export const SENTINEL_API_KEY = "sk-ant-api03-dispatch-sandbox-placeholder-not-a-real-key";
export const SENTINEL_OAUTH_TOKEN = "sk-ant-oat01-dispatch-sandbox-placeholder-not-a-real-token";

const DROP_HEADERS = new Set([
  "host", "connection", "proxy-authorization", "proxy-connection", "keep-alive", "transfer-encoding", "content-length",
]);

/** Request headers worth forwarding: no hop-by-hop headers, lower-cased names */
export function forwardHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (!DROP_HEADERS.has(lower)) out[lower] = value;
  }
  return out;
}

/**
 * Request headers with the placeholder credential replaced by the real one of the same kind
 * (x-api-key or Authorization: Bearer). A placeholder with no real credential of its kind
 * is dropped, never forwarded.
 */
export function injectCredentials(
  headers: Record<string, string | string[] | undefined>,
  creds: { apiKey?: string; oauthToken?: string },
): Record<string, string | string[]> {
  const out = forwardHeaders(headers);
  if (out["x-api-key"] !== undefined) {
    if (creds.apiKey) out["x-api-key"] = creds.apiKey;
    else delete out["x-api-key"];
  }
  if (typeof out["authorization"] === "string" && /^Bearer\s/i.test(out["authorization"])) {
    if (creds.oauthToken) out["authorization"] = `Bearer ${creds.oauthToken}`;
    else delete out["authorization"];
  }
  return out;
}

/** Headers for the upstream request, with the provider's credential added */
export async function authorizeRequest(
  cfg: GatewayConfig,
  route: GatewayRoute,
  method: string,
  headers: Record<string, string | string[] | undefined>,
  body: Buffer,
): Promise<Record<string, string | string[]>> {
  if (cfg.provider === "anthropic" || cfg.provider === "foundry") {
    return { ...injectCredentials(headers, { apiKey: cfg.apiKey, oauthToken: cfg.bearerToken }), host: route.host };
  }

  // Cloud providers: whatever auth the agent sent is dropped, the gateway adds its own
  const out = forwardHeaders(headers);
  for (const name of Object.keys(out)) {
    if (name === "authorization" || name === "x-api-key" || name.startsWith("x-amz-security") || name === "x-amz-date" || name === "x-amz-content-sha256") {
      delete out[name];
    }
  }
  out.host = route.host;

  if (cfg.provider === "vertex") {
    if (!cfg.google) throw new Error("no Google credentials");
    out.authorization = `Bearer ${await cfg.google.token()}`;
    return out;
  }

  // Bedrock: a Bedrock API key, or AWS credentials signed into the request
  if (cfg.bearerToken) {
    out.authorization = `Bearer ${cfg.bearerToken}`;
    return out;
  }
  if (!cfg.aws || !cfg.region) throw new Error("no AWS credentials");
  return {
    ...out,
    ...signAwsV4({ method, host: route.host, path: route.path, body, region: cfg.region, service: "bedrock", credentials: cfg.aws }),
  };
}

/** Gateway settings from the proxy container's environment */
export function gatewayConfigFromEnv(env: NodeJS.ProcessEnv): GatewayConfig {
  const provider = (env.GATEWAY_PROVIDER || "anthropic") as GatewayProvider;
  const upstream = env.GATEWAY_UPSTREAM || undefined;
  const value = (name: string) => env[name] || undefined;
  switch (provider) {
    case "foundry":
      return {
        provider,
        upstream,
        host: value("GATEWAY_HOST"),
        basePath: value("GATEWAY_BASE_PATH"),
        apiKey: value("ANTHROPIC_FOUNDRY_API_KEY"),
        bearerToken: value("ANTHROPIC_FOUNDRY_AUTH_TOKEN"),
      };
    case "bedrock":
      return {
        provider,
        upstream,
        region: value("GATEWAY_REGION"),
        bearerToken: value("AWS_BEARER_TOKEN_BEDROCK"),
        aws: env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
          ? { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, sessionToken: value("AWS_SESSION_TOKEN") }
          : undefined,
      };
    case "vertex":
      return {
        provider,
        upstream,
        project: value("GATEWAY_PROJECT"),
        locations: (env.GATEWAY_LOCATIONS ?? "").split(",").filter(Boolean),
        google: new GoogleToken({ accessToken: value("GOOGLE_OAUTH_ACCESS_TOKEN"), credentialsFile: value("GOOGLE_APPLICATION_CREDENTIALS") }),
      };
    default:
      return { provider: "anthropic", upstream, apiKey: value("ANTHROPIC_API_KEY"), bearerToken: value("CLAUDE_CODE_OAUTH_TOKEN") };
  }
}

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateKeyPairSync, createVerify, randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  GoogleToken,
  gatewayRoute,
  normalizeAwsPath,
  signAwsV4,
  vertexHost,
  type GatewayConfig,
} from "../src/sandbox/gateway.js";
import { startGateway } from "../src/sandbox/egress-proxy.js";
import { claudeProvider, providerPlan, providerProblem, settingVars } from "../src/sandbox/providers.js";
import { DockerSandbox } from "../src/sandbox/docker.js";

const AWS_EXAMPLE = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };
const DATE = new Date("2015-08-30T12:36:00Z");

/** Run `fn` with these variables set (undefined = unset), then restore the environment */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const name of Object.keys(vars)) saved[name] = process.env[name];
  const clear = ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"];
  for (const name of clear) if (!(name in vars)) { saved[name] = process.env[name]; delete process.env[name]; }
  for (const [name, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

describe("AWS Signature Version 4", () => {
  it("matches AWS's published test vector (get-vanilla)", () => {
    const headers = signAwsV4({
      method: "GET", host: "example.amazonaws.com", path: "/", region: "us-east-1", service: "service",
      credentials: AWS_EXAMPLE, date: DATE,
    });
    assert.equal(
      headers.authorization,
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, " +
        "Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
    assert.equal(headers["x-amz-date"], "20150830T123600Z");
  });

  it("matches AWS's IAM ListUsers example (query string and an extra signed header)", () => {
    const headers = signAwsV4({
      method: "GET", host: "iam.amazonaws.com", path: "/?Action=ListUsers&Version=2010-05-08", region: "us-east-1", service: "iam",
      headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" }, credentials: AWS_EXAMPLE, date: DATE,
    });
    assert.match(headers.authorization, /Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7$/);
  });

  it("signs a session token and encodes model IDs the way the AWS SDK does", () => {
    const headers = signAwsV4({
      method: "POST", host: "h", path: "/", region: "us-east-1", service: "bedrock",
      credentials: { ...AWS_EXAMPLE, sessionToken: "tok" }, date: DATE,
    });
    assert.equal(headers["x-amz-security-token"], "tok");
    assert.match(headers.authorization, /SignedHeaders=host;x-amz-date;x-amz-security-token,/);
    assert.equal(normalizeAwsPath("/model/us.anthropic.claude-sonnet-4-5-20250929-v1:0/invoke"), "/model/us.anthropic.claude-sonnet-4-5-20250929-v1%3A0/invoke");
    assert.equal(normalizeAwsPath("/model/arn%3Aaws%3Abedrock%3Aus-east-2%3A1%3Aapplication-inference-profile%2Fx/invoke"),
      "/model/arn%3Aaws%3Abedrock%3Aus-east-2%3A1%3Aapplication-inference-profile%2Fx/invoke");
    assert.equal(normalizeAwsPath("/inference-profiles?type=SYSTEM_DEFINED"), "/inference-profiles?type=SYSTEM_DEFINED");
  });
});

describe("gateway routes", () => {
  it("Bedrock: model calls to bedrock-runtime, discovery to bedrock, nothing else", () => {
    const cfg: GatewayConfig = { provider: "bedrock", region: "eu-west-1" };
    assert.deepEqual(gatewayRoute(cfg, "POST", "/model/eu.anthropic.claude-x-v1:0/invoke-with-response-stream"),
      { host: "bedrock-runtime.eu-west-1.amazonaws.com", path: "/model/eu.anthropic.claude-x-v1%3A0/invoke-with-response-stream" });
    assert.equal(gatewayRoute(cfg, "GET", "/inference-profiles?type=SYSTEM_DEFINED")?.host, "bedrock.eu-west-1.amazonaws.com");
    assert.equal(gatewayRoute(cfg, "GET", "/inference-profiles/us.anthropic.claude-x")?.host, "bedrock.eu-west-1.amazonaws.com");
    assert.equal(gatewayRoute(cfg, "DELETE", "/inference-profiles/x"), null);
    assert.equal(gatewayRoute(cfg, "POST", "/guardrails"), null);
    assert.equal(gatewayRoute(cfg, "POST", "/model/a/b/c"), null);
  });

  it("Vertex: only the configured project and locations, only Anthropic models", () => {
    const cfg: GatewayConfig = { provider: "vertex", project: "p1", locations: ["us-east5", "global"] };
    const path = "/v1/projects/p1/locations/us-east5/publishers/anthropic/models/claude-sonnet-4-5@20250929:streamRawPredict";
    assert.deepEqual(gatewayRoute(cfg, "POST", path), { host: "us-east5-aiplatform.googleapis.com", path });
    assert.equal(gatewayRoute(cfg, "POST", path.replace("us-east5", "global"))?.host, "aiplatform.googleapis.com");
    assert.equal(gatewayRoute(cfg, "POST", path.replace("/p1/", "/other/")), null, "another project");
    assert.equal(gatewayRoute(cfg, "POST", path.replace("us-east5", "europe-west1")), null, "an unlisted location");
    assert.equal(gatewayRoute(cfg, "POST", path.replace("anthropic", "google")), null, "another publisher");
    assert.equal(gatewayRoute(cfg, "GET", "/v1/projects/p1/secrets"), null);
    assert.equal(vertexHost("eu"), "aiplatform.eu.rep.googleapis.com");
  });

  it("Foundry: the Anthropic API under the resource's base path", () => {
    const cfg: GatewayConfig = { provider: "foundry", host: "res.services.ai.azure.com", basePath: "/anthropic" };
    assert.deepEqual(gatewayRoute(cfg, "POST", "/v1/messages?beta=true"), { host: "res.services.ai.azure.com", path: "/anthropic/v1/messages?beta=true" });
    assert.equal(gatewayRoute(cfg, "GET", "/openai/deployments"), null);
  });
});

describe("model providers", () => {
  it("follows Claude Code's switches", () => {
    assert.equal(claudeProvider({}), "anthropic");
    assert.equal(claudeProvider({ CLAUDE_CODE_USE_BEDROCK: "1" }), "bedrock");
    assert.equal(claudeProvider({ CLAUDE_CODE_USE_BEDROCK: "0", CLAUDE_CODE_USE_VERTEX: "true" }), "vertex");
    assert.equal(claudeProvider({ CLAUDE_CODE_USE_FOUNDRY: "1" }), "foundry");
  });

  it("Bedrock: needs credentials in the environment; a Bedrock API key is all that's passed when set", () => {
    const base = { CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "eu-west-1" };
    assert.match(providerProblem(base, "gateway")!, /aws configure export-credentials/);
    assert.equal(providerProblem({ ...base, AWS_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "b" }, "gateway"), null);
    const plan = providerPlan({ ...base, AWS_BEARER_TOKEN_BEDROCK: "k", AWS_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "b" });
    assert.deepEqual(plan.credentialVars, ["AWS_BEARER_TOKEN_BEDROCK"]);
    assert.deepEqual(plan.directHosts, ["bedrock-runtime.eu-west-1.amazonaws.com", "bedrock.eu-west-1.amazonaws.com"]);
    const env = plan.gatewayAgentEnv("http://gw/t");
    assert.equal(env.CLAUDE_CODE_SKIP_BEDROCK_AUTH, "1");
    assert.equal(env.ANTHROPIC_BEDROCK_BASE_URL, "http://gw/t");
    assert.equal(env.AWS_REGION, "eu-west-1");
    assert.match(providerProblem({ ...base, AWS_BEARER_TOKEN_BEDROCK: "k", ANTHROPIC_BEDROCK_BASE_URL: "https://corp" }, "gateway")!, /your own gateway/);
    assert.equal(providerProblem({ ...base, AWS_BEARER_TOKEN_BEDROCK: "k", ANTHROPIC_BEDROCK_BASE_URL: "https://corp" }, "direct"), null);
    assert.match(providerProblem({ ...base, CLAUDE_CODE_USE_VERTEX: "1" }, "gateway")!, /only one/);
    assert.match(providerProblem({ ...base, CLAUDE_CODE_USE_MANTLE: "1" }, "gateway")!, /Mantle/);
  });

  it("Vertex: a project, and a credential file or access token the gateway can use", async () => {
    const home = join(tmpdir(), `dispatch-home-${randomUUID()}`);
    await mkdir(join(home, ".config", "gcloud"), { recursive: true });
    try {
      const base = { CLAUDE_CODE_USE_VERTEX: "1", ANTHROPIC_VERTEX_PROJECT_ID: "p1", CLOUD_ML_REGION: "global", VERTEX_REGION_CLAUDE_HAIKU_4_5: "us-east5" };
      assert.match(providerProblem({ CLAUDE_CODE_USE_VERTEX: "1" }, "gateway", home)!, /ANTHROPIC_VERTEX_PROJECT_ID/);
      assert.match(providerProblem(base, "gateway", home)!, /gcloud auth application-default login/);
      assert.equal(providerProblem({ ...base, GOOGLE_OAUTH_ACCESS_TOKEN: "t" }, "gateway", home), null);

      const adc = join(home, ".config", "gcloud", "application_default_credentials.json");
      await writeFile(adc, JSON.stringify({ type: "authorized_user", client_id: "c", client_secret: "s", refresh_token: "r" }));
      assert.equal(providerProblem(base, "gateway", home), null);
      const plan = providerPlan(base, home);
      assert.equal(plan.credentialFile, adc);
      assert.deepEqual(plan.gatewayHosts, ["aiplatform.googleapis.com", "us-east5-aiplatform.googleapis.com"]);
      assert.equal(plan.gatewayEnv.GATEWAY_LOCATIONS, "global,us-east5");
      assert.ok(plan.directHosts.includes("oauth2.googleapis.com"));
      assert.equal(plan.gatewayAgentEnv("http://gw/t").ANTHROPIC_VERTEX_BASE_URL, "http://gw/t/v1");

      // Workload identity files can't be used by the gateway, but Claude can use them itself
      await writeFile(adc, JSON.stringify({ type: "external_account" }));
      assert.match(providerProblem(base, "gateway", home)!, /token_format: access_token/);
      assert.equal(providerProblem(base, "direct", home), null);
      assert.ok(providerPlan(base, home).directHosts.includes("sts.googleapis.com"));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("Foundry: a resource and a key or token; the placeholder matches the credential's kind", () => {
    assert.match(providerProblem({ CLAUDE_CODE_USE_FOUNDRY: "1" }, "gateway")!, /ANTHROPIC_FOUNDRY_RESOURCE/);
    assert.match(providerProblem({ CLAUDE_CODE_USE_FOUNDRY: "1", ANTHROPIC_FOUNDRY_RESOURCE: "r" }, "gateway")!, /az login/);
    const key = providerPlan({ CLAUDE_CODE_USE_FOUNDRY: "1", ANTHROPIC_FOUNDRY_RESOURCE: "r", ANTHROPIC_FOUNDRY_API_KEY: "k" });
    assert.deepEqual(key.gatewayHosts, ["r.services.ai.azure.com"]);
    assert.match(key.gatewayAgentEnv("http://gw/t").ANTHROPIC_FOUNDRY_API_KEY, /placeholder/);
    const token = providerPlan({ CLAUDE_CODE_USE_FOUNDRY: "1", ANTHROPIC_FOUNDRY_BASE_URL: "https://x.services.ai.azure.com/anthropic/", ANTHROPIC_FOUNDRY_AUTH_TOKEN: "t" });
    assert.equal(token.gatewayEnv.GATEWAY_HOST, "x.services.ai.azure.com");
    assert.equal(token.gatewayEnv.GATEWAY_BASE_PATH, "/anthropic");
    assert.match(token.gatewayAgentEnv("http://gw/t").ANTHROPIC_FOUNDRY_AUTH_TOKEN, /placeholder/);
    assert.equal(token.gatewayAgentEnv("http://gw/t").ANTHROPIC_FOUNDRY_API_KEY, undefined);
  });

  it("passes model pins through, and nothing secret", () => {
    const names = settingVars({
      ANTHROPIC_DEFAULT_SONNET_MODEL: "us.anthropic.claude-sonnet-4-6", VERTEX_REGION_CLAUDE_4_6_SONNET: "eu", ANTHROPIC_API_KEY: "k",
      ANTHROPIC_BASE_URL: "x", AWS_SECRET_ACCESS_KEY: "s", ANTHROPIC_MODEL: "",
    });
    assert.deepEqual(names, ["ANTHROPIC_DEFAULT_SONNET_MODEL", "VERTEX_REGION_CLAUDE_4_6_SONNET"]);
  });
});

describe("Docker sandbox with a cloud provider", () => {
  let root: string;
  before(async () => {
    root = join(tmpdir(), `dispatch-cloud-${randomUUID()}`);
    await mkdir(join(root, "repo", ".dispatch", "worktrees", "issue-1"), { recursive: true });
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const prepare = (credentials?: "gateway" | "env") => {
    const repo = join(root, "repo");
    return new DockerSandbox({ credentials }).prepareIssue({
      sessionId: "s1", dir: join(repo, ".dispatch", "sandbox", "s1"), worktreePath: join(repo, ".dispatch", "worktrees", "issue-1"), repoRoot: repo,
    });
  };
  const bedrock = { CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "us-west-2", AWS_ACCESS_KEY_ID: "AKIAREAL", AWS_SECRET_ACCESS_KEY: "real-secret", ANTHROPIC_DEFAULT_SONNET_MODEL: "us.anthropic.claude-sonnet-4-6" };

  it("keeps AWS credentials out of the agent's container by default", async () => {
    await withEnv(bedrock, async () => {
      const box = await prepare();
      const args = box.agent.args;
      const agent = args.join(" ");
      assert.match(agent, /CLAUDE_CODE_USE_BEDROCK=1/);
      assert.match(agent, /CLAUDE_CODE_SKIP_BEDROCK_AUTH=1/);
      assert.match(agent, /ANTHROPIC_BEDROCK_BASE_URL=http:\/\/dispatch-proxy-\w+:3130\/[a-f0-9]{32}/);
      assert.doesNotMatch(agent, /AKIAREAL|real-secret|AWS_SECRET_ACCESS_KEY|AWS_ACCESS_KEY_ID/);
      assert.ok(args.some((a, i) => a === "ANTHROPIC_DEFAULT_SONNET_MODEL" && args[i - 1] === "-e"), "model pin passed by name");
      assert.equal(box.record.provider, "Amazon Bedrock");
      assert.ok(box.record.allowedDomains.includes("bedrock-runtime.us-west-2.amazonaws.com (via the credential gateway)"));
      assert.ok(!box.record.allowedDomains.includes("bedrock-runtime.us-west-2.amazonaws.com"), "no direct route");
      assert.equal(await new DockerSandbox({ docker: "true" }).preflight("claude"), null);
    });
  });

  it("with credentials: env, passes them by name and allows the provider's hosts", async () => {
    await withEnv(bedrock, async () => {
      const box = await prepare("env");
      const args = box.agent.args;
      for (const name of ["CLAUDE_CODE_USE_BEDROCK", "AWS_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]) {
        assert.ok(args.some((a, i) => a === name && args[i - 1] === "-e"), `${name} passed by name`);
      }
      assert.doesNotMatch(args.join(" "), /real-secret|ANTHROPIC_BEDROCK_BASE_URL/);
      assert.ok(box.record.allowedDomains.includes("bedrock-runtime.us-west-2.amazonaws.com"));
      assert.doesNotMatch(box.verify.args.join(" "), /AWS_|BEDROCK/);
    });
  });

  it("fails closed when the provider's credentials are missing", async () => {
    await withEnv({ CLAUDE_CODE_USE_BEDROCK: "1", AWS_ACCESS_KEY_ID: undefined, AWS_SECRET_ACCESS_KEY: undefined, AWS_BEARER_TOKEN_BEDROCK: undefined }, async () => {
      assert.match((await new DockerSandbox({ docker: "true" }).preflight("claude"))!, /Bedrock credentials must be in the environment/);
    });
  });
});

/** A fake provider endpoint that records requests and answers with a streamed body */
async function fakeUpstream() {
  const seen: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: string }> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString();
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      if (req.url === "/token") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: `ya29.minted-${seen.length}`, expires_in: 3600 }));
        return;
      }
      res.writeHead(200, { "content-type": "application/vnd.amazon.eventstream" });
      res.write("chunk-1|");
      setTimeout(() => res.end("chunk-2"), 20);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { seen, server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

describe("credential gateway with cloud providers", () => {
  const TOKEN = "0123456789abcdef0123456789abcdef";
  let dir: string;
  before(async () => {
    dir = join(tmpdir(), `dispatch-gw-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, TOKEN), "s1");
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function call(cfg: GatewayConfig, method: string, path: string, headers: Record<string, string> = {}, body = "") {
    const server = startGateway(0, cfg, dir);
    await new Promise((r) => server.once("listening", r));
    const port = (server.address() as AddressInfo).port;
    try {
      return await new Promise<{ status: number; type?: string; body: string }>((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
          let text = "";
          res.on("data", (d) => (text += d));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, type: res.headers["content-type"], body: text }));
        });
        req.on("error", reject);
        req.end(body);
      });
    } finally {
      server.close();
    }
  }

  it("Bedrock: signs with the real AWS credentials and streams the response through unchanged", async () => {
    const up = await fakeUpstream();
    try {
      const creds = { accessKeyId: "AKIAREAL", secretAccessKey: "real-secret", sessionToken: "sess" };
      const res = await call(
        { provider: "bedrock", region: "us-west-2", aws: creds, upstream: up.url },
        "POST", `/${TOKEN}/model/us.anthropic.claude-x-v1:0/invoke-with-response-stream`,
        { "content-type": "application/json", authorization: "Bearer agent-made-this-up" }, '{"messages":[]}',
      );
      assert.equal(res.status, 200);
      assert.equal(res.type, "application/vnd.amazon.eventstream");
      assert.equal(res.body, "chunk-1|chunk-2");
      const got = up.seen[0];
      assert.equal(got.url, "/model/us.anthropic.claude-x-v1%3A0/invoke-with-response-stream");
      assert.equal(got.headers.host, "bedrock-runtime.us-west-2.amazonaws.com");
      assert.equal(got.body, '{"messages":[]}');
      assert.equal(got.headers["x-amz-security-token"], "sess");
      // The signature is the one AWS would compute for exactly this request
      const expected = signAwsV4({
        method: "POST", host: "bedrock-runtime.us-west-2.amazonaws.com", path: got.url, body: got.body, region: "us-west-2",
        service: "bedrock", credentials: creds, date: new Date(String(got.headers["x-amz-date"]).replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z")),
      });
      assert.equal(got.headers.authorization, expected.authorization);
    } finally {
      up.server.close();
    }
  });

  it("Bedrock with an API key: a bearer token instead of a signature", async () => {
    const up = await fakeUpstream();
    try {
      await call({ provider: "bedrock", region: "us-east-1", bearerToken: "bedrock-key", upstream: up.url }, "GET", `/${TOKEN}/inference-profiles?type=SYSTEM_DEFINED`);
      assert.equal(up.seen[0].headers.authorization, "Bearer bedrock-key");
      assert.equal(up.seen[0].headers.host, "bedrock.us-east-1.amazonaws.com");
    } finally {
      up.server.close();
    }
  });

  it("Vertex: mints an access token from a service account key and adds it", async () => {
    const up = await fakeUpstream();
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const keyFile = join(dir, "sa.json");
    await writeFile(keyFile, JSON.stringify({
      type: "service_account", client_email: "dispatch@p1.iam.gserviceaccount.com", token_uri: `${up.url}/token`,
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
    }));
    try {
      const path = "/v1/projects/p1/locations/us-east5/publishers/anthropic/models/claude-x:streamRawPredict";
      const res = await call(
        { provider: "vertex", project: "p1", locations: ["us-east5"], google: new GoogleToken({ credentialsFile: keyFile }), upstream: up.url },
        "POST", `/${TOKEN}${path}`, { "content-type": "application/json" }, "{}",
      );
      assert.equal(res.status, 200);
      const [token, model] = up.seen;
      assert.equal(token.url, "/token");
      const form = new URLSearchParams(token.body);
      assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
      const [header, claims, signature] = form.get("assertion")!.split(".");
      assert.ok(createVerify("RSA-SHA256").update(`${header}.${claims}`).verify(publicKey, Buffer.from(signature, "base64url")), "JWT signed with the key");
      assert.equal(JSON.parse(Buffer.from(claims, "base64url").toString()).scope, "https://www.googleapis.com/auth/cloud-platform");
      assert.equal(model.url, path);
      assert.equal(model.headers.host, "us-east5-aiplatform.googleapis.com");
      assert.equal(model.headers.authorization, "Bearer ya29.minted-1");
    } finally {
      up.server.close();
    }
  });

  it("Foundry: swaps the placeholder key under the resource's base path", async () => {
    const up = await fakeUpstream();
    try {
      const { SENTINEL_API_KEY } = await import("../src/sandbox/gateway.js");
      await call({ provider: "foundry", host: "res.services.ai.azure.com", basePath: "/anthropic", apiKey: "foundry-key", upstream: up.url },
        "POST", `/${TOKEN}/v1/messages?beta=true`, { "x-api-key": SENTINEL_API_KEY }, "{}");
      assert.equal(up.seen[0].url, "/anthropic/v1/messages?beta=true");
      assert.equal(up.seen[0].headers["x-api-key"], "foundry-key");
      assert.equal(up.seen[0].headers.host, "res.services.ai.azure.com");
    } finally {
      up.server.close();
    }
  });

  it("refuses anything but the model API, and logs it as blocked for the session", async () => {
    const up = await fakeUpstream();
    const logged: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => { logged.push(args.join(" ")); };
    try {
      const res = await call({ provider: "vertex", project: "p1", locations: ["us-east5"], google: new GoogleToken({ accessToken: "t" }), upstream: up.url },
        "GET", `/${TOKEN}/v1/projects/p1/locations/us-east5/datasets`);
      assert.equal(res.status, 403);
      assert.equal(up.seen.length, 0);
    } finally {
      console.log = original;
      up.server.close();
    }
    assert.ok(logged.some((line) => /^BLOCKED vertex-gateway\/v1\/projects\/p1\/locations\/us-east5\/datasets \(gateway\) session=s1$/.test(line)), logged.join("\n"));
  });
});

/**
 * Egress proxy for the Docker sandbox. It runs in its own container, attached both to the
 * run's internal network (which has no route out) and to the default bridge. Sandboxed
 * containers reach the outside only through it, and it lets through only the listed hosts.
 *
 * Two listeners, one per policy: AGENT_PORT (Claude API + registries) and VERIFY_PORT
 * (registries only). Standalone on purpose: Node built-ins only, so it runs from a plain
 * node image with this file mounted read-only.
 */
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, isIP } from "node:net";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Whether `host` matches the allowlist: exact names, or `*.example.com` for subdomains */
export function hostAllowed(host: string, allowList: string[]): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  if (!name || isIP(name.replace(/^\[|\]$/g, ""))) return false; // no IP literals
  return allowList.some((entry) => {
    const pattern = entry.trim().toLowerCase();
    if (pattern.startsWith("*.")) return name.endsWith(pattern.slice(1));
    return name === pattern;
  });
}

/** The username from a Proxy-Authorization header, or "" */
export function proxyUser(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  const match = value?.match(/^Basic\s+(\S+)/i);
  if (!match) return "";
  return Buffer.from(match[1], "base64").toString("utf-8").split(":")[0];
}

/**
 * The session a request belongs to. Each session's proxy URL carries a random token as its
 * username, which clients send as Proxy-Authorization; Dispatch registers each token as a
 * file in `sessionsDir` holding the session ID. Returns null for a missing or unknown token:
 * a client that leaves the header out (or makes one up) can't hide which session it is,
 * it just gets refused. Without a sessionsDir, every request is accepted as session "-".
 */
export function sessionOf(header: string | string[] | undefined, sessionsDir?: string): string | null {
  if (!sessionsDir) return "-";
  const token = proxyUser(header);
  if (!/^[a-f0-9]{32}$/.test(token)) return null;
  try {
    const id = readFileSync(join(sessionsDir, token), "utf-8").trim();
    return /^[\w-]{1,64}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** Ports a sandboxed client may reach through the proxy */
const ALLOWED_PORTS = new Set([80, 443]);

function deny(socket: { end: (data: string) => void }, host: string, reason: string, session: string) {
  console.log(`BLOCKED ${host} (${reason}) session=${session}`);
  socket.end(`HTTP/1.1 403 Forbidden\r\nX-Proxy-Error: blocked-by-dispatch\r\nContent-Length: 0\r\n\r\n`);
}

const REFUSE_UNKNOWN = "HTTP/1.1 407 Proxy Authentication Required\r\nX-Proxy-Error: unknown-session\r\nContent-Length: 0\r\n\r\n";

export function startProxy(port: number, allowList: string[], label: string, sessionsDir?: string) {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // Plain HTTP through the proxy: the request line carries an absolute URL
    let url: URL;
    try {
      url = new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end();
      return;
    }
    const target = Number(url.port || 80);
    const session = sessionOf(req.headers["proxy-authorization"], sessionsDir);
    if (session === null) {
      console.log(`BLOCKED ${url.hostname}:${target} (${label}) session=-`);
      res.writeHead(407, { "X-Proxy-Error": "unknown-session" }).end();
      return;
    }
    if (!hostAllowed(url.hostname, allowList) || !ALLOWED_PORTS.has(target)) {
      console.log(`BLOCKED ${url.hostname}:${target} (${label}) session=${session}`);
      res.writeHead(403, { "X-Proxy-Error": "blocked-by-dispatch" }).end();
      return;
    }
    const upstream = httpRequest(
      { host: url.hostname, port: target, path: url.pathname + url.search, method: req.method, headers: req.headers },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
      },
    );
    upstream.on("error", () => res.writeHead(502).end());
    req.pipe(upstream);
  });

  // HTTPS: CONNECT host:port, then a blind TCP tunnel
  server.on("connect", (req: IncomingMessage, client, head: Buffer) => {
    const [host, portText] = (req.url ?? "").split(/:(?=\d+$)/);
    const target = Number(portText || 443);
    const session = sessionOf(req.headers["proxy-authorization"], sessionsDir);
    if (session === null) {
      console.log(`BLOCKED ${host}:${target} (${label}) session=-`);
      client.end(REFUSE_UNKNOWN);
      return;
    }
    if (!hostAllowed(host, allowList) || !ALLOWED_PORTS.has(target)) {
      deny(client, `${host}:${target}`, label, session);
      return;
    }
    console.log(`ALLOWED ${host}:${target} (${label}) session=${session}`);
    const upstream = connect(target, host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    const close = () => {
      upstream.destroy();
      client.destroy();
    };
    upstream.on("error", close);
    client.on("error", close);
  });

  server.listen(port, "0.0.0.0", () => console.log(`listening ${label} on ${port}: ${allowList.join(",")}`));
  return server;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const list = (name: string) => (process.env[name] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const sessions = process.env.SESSIONS_DIR || undefined;
  startProxy(Number(process.env.AGENT_PORT ?? 3128), list("AGENT_DOMAINS"), "agent", sessions);
  startProxy(Number(process.env.VERIFY_PORT ?? 3129), list("VERIFY_DOMAINS"), "verify", sessions);
}

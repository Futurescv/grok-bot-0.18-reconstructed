// Local gateway proxy: 127.0.0.1 -> Kubernetes apiserver service proxy -> box gateway.
//
// Why this exists: `kubectl port-forward` was the weak link. Its SPDY tunnel
// rots (streams start timing out while the process stays alive) and its
// WebSocket mode fared worse under this client's connection churn — measured
// 0/20 successful API calls through the tunnel while the same calls were 20/20
// from inside the pod. The apiserver's own service proxy is a plain HTTPS
// reverse proxy on the same private VPC address kubectl already talks to, and
// answers /health in ~140ms with no tunnel to keep alive.
//
// Two details make it work:
//  * The apiserver consumes Authorization to authenticate the caller and
//    deletes it before forwarding, so the gateway token travels in
//    GATEWAY_TOKEN_HEADER instead (unknown headers pass through untouched).
//    The box gateway accepts either.
//  * The desktop client keeps talking plain HTTP to 127.0.0.1 and keeps
//    sending its own bearer, which this proxy verifies before forwarding, so a
//    stray local process cannot borrow the cluster credential.
//
// Usage: SAND_HOST_GATEWAY_TOKEN=<token> node deploy/acs/gateway-proxy.mjs
//
// The same script also serves the box's noVNC ports, which is how the agent's
// screen resolves: the host hands the client a loopback URL on the box's own
// noVNC port, so something has to answer on that port here. Those ports carry
// their own websockify token and are reached by a webview that cannot send our
// bearer, so run them with REQUIRE_TOKEN=0:
//   PROXY_PORT=6081 SERVICE_PORT=6081 REQUIRE_TOKEN=0 node deploy/acs/gateway-proxy.mjs
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { readFileSync, appendFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import os from "node:os";
import path from "node:path";

const GATEWAY_TOKEN_HEADER = "x-sand-gateway-token";
const LISTEN_HOST = "127.0.0.1";
const LISTEN_PORT = Number(process.env.PROXY_PORT ?? 11340);
const NAMESPACE = process.env.NS ?? "grok-bot";
const SERVICE = process.env.SERVICE ?? "grok-bot-box";
const SERVICE_PORT = process.env.SERVICE_PORT ?? "1340";
const REQUIRE_TOKEN = (process.env.REQUIRE_TOKEN ?? "1") !== "0";
const KUBECONFIG = process.env.KUBECONFIG ?? path.join(os.homedir(), "Documents/auth/acs-internal/k8s.yaml");
const LOG = process.env.PROXY_LOG ?? "/tmp/gateway-proxy.log";
// Headers that describe the hop we are replacing, not the request being relayed.
const DROP_HEADERS = new Set(["host", "authorization", "connection", "keep-alive", "proxy-authorization", "transfer-encoding", "upgrade", "content-length"]);

const token = process.env.SAND_HOST_GATEWAY_TOKEN ?? "";
if (token.length === 0 && REQUIRE_TOKEN) {
  console.error("SAND_HOST_GATEWAY_TOKEN is not set");
  process.exit(1);
}

const log = (line) => {
  const stamped = `${new Date().toISOString().slice(11, 23)} ${line}\n`;
  try { appendFileSync(LOG, stamped); } catch { /* logging must never break the data path */ }
};

// The kubeconfig is generated, so the four fields we need are plain scalars.
// Regex keeps the credentials in memory instead of shelling out or writing PEM
// files to disk.
function readClusterAccess(file) {
  const raw = readFileSync(file, "utf8");
  const pick = (key) => raw.match(new RegExp(`${key}:\\s*(\\S+)`))?.[1];
  const server = pick("server");
  const ca = pick("certificate-authority-data");
  const cert = pick("client-certificate-data");
  const key = pick("client-key-data");
  if (server == null || cert == null || key == null) throw new Error(`${file} lacks a server URL and client certificate`);
  const endpoint = new URL(server);
  return {
    host: endpoint.hostname,
    port: endpoint.port.length > 0 ? Number(endpoint.port) : 443,
    ...(ca == null ? { rejectUnauthorized: false } : { ca: Buffer.from(ca, "base64") }),
    cert: Buffer.from(cert, "base64"),
    key: Buffer.from(key, "base64"),
  };
}

const cluster = readClusterAccess(KUBECONFIG);
const proxyPrefix = `/api/v1/namespaces/${NAMESPACE}/services/${SERVICE}:${SERVICE_PORT}/proxy`;

function clientIsAuthorized(req) {
  if (!REQUIRE_TOKEN) return true;
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const provided = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function upstreamOptions(method, target, headers) {
  return {
    host: cluster.host,
    port: cluster.port,
    method,
    path: `${proxyPrefix}${target}`,
    headers,
    ...(cluster.ca == null ? { rejectUnauthorized: false } : { ca: cluster.ca }),
    cert: cluster.cert,
    key: cluster.key,
    // Long-lived SSE streams and VNC sockets must not be reaped by an idle timer.
    timeout: 0,
  };
}

function relayHeaders(req) {
  const headers = REQUIRE_TOKEN ? { [GATEWAY_TOKEN_HEADER]: token } : {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (!DROP_HEADERS.has(name.toLowerCase()) && value !== undefined) headers[name] = value;
  }
  return headers;
}

const server = createServer((clientReq, clientRes) => {
  const target = clientReq.url ?? "/";
  // /health is the one unauthenticated endpoint, and supervisors probe it.
  if (!clientIsAuthorized(clientReq) && !target.startsWith("/health")) {
    log(`401 ${clientReq.method} ${target} (local caller token mismatch)`);
    clientRes.writeHead(401, { "content-type": "application/json" });
    clientRes.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  const headers = relayHeaders(clientReq);

  const upstream = httpsRequest(upstreamOptions(clientReq.method, target, headers));

  upstream.on("response", (upstreamRes) => {
    log(`${upstreamRes.statusCode} ${clientReq.method} ${target}`);
    clientRes.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
    // flushHeaders + pipe keeps SSE chunks moving instead of pooling in a buffer.
    clientRes.flushHeaders();
    upstreamRes.pipe(clientRes);
  });
  upstream.on("error", (error) => {
    log(`ERR ${clientReq.method} ${target}: ${error.message}`);
    if (!clientRes.headersSent) clientRes.writeHead(502, { "content-type": "application/json" });
    if (!clientRes.writableEnded) clientRes.end(JSON.stringify({ error: `gateway proxy: ${error.message}` }));
  });
  clientReq.on("aborted", () => upstream.destroy());
  clientReq.pipe(upstream);
});

// noVNC opens a WebSocket to websockify after loading vnc.html. The apiserver
// proxy forwards upgrades, but only if we ask for one and then get out of the
// way: once it answers 101 the two sockets are a raw byte pipe.
server.on("upgrade", (clientReq, clientSocket, head) => {
  const target = clientReq.url ?? "/";
  if (!clientIsAuthorized(clientReq)) {
    log(`401 UPGRADE ${target} (local caller token mismatch)`);
    clientSocket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
    return;
  }
  const headers = relayHeaders(clientReq);
  headers.connection = "Upgrade";
  headers.upgrade = clientReq.headers.upgrade ?? "websocket";
  const upstream = httpsRequest(upstreamOptions("GET", target, headers));
  upstream.on("upgrade", (upstreamRes, upstreamSocket, upstreamHead) => {
    log(`101 UPGRADE ${target}`);
    const lines = Object.entries(upstreamRes.headers).flatMap(([name, value]) =>
      (Array.isArray(value) ? value : [value]).map(item => `${name}: ${item}`));
    clientSocket.write(`HTTP/1.1 101 ${upstreamRes.statusMessage ?? "Switching Protocols"}\r\n${lines.join("\r\n")}\r\n\r\n`);
    clientSocket.setNoDelay(true);
    upstreamSocket.setNoDelay(true);
    if (upstreamHead?.length > 0) clientSocket.write(upstreamHead);
    if (head?.length > 0) upstreamSocket.write(head);
    upstreamSocket.pipe(clientSocket);
    clientSocket.pipe(upstreamSocket);
    const drop = () => { upstreamSocket.destroy(); clientSocket.destroy(); };
    upstreamSocket.on("error", drop); clientSocket.on("error", drop);
    upstreamSocket.on("close", drop); clientSocket.on("close", drop);
  });
  // An upgrade that comes back as a normal response is a failure worth seeing:
  // relay it so the viewer reports the status instead of hanging.
  upstream.on("response", (upstreamRes) => {
    log(`${upstreamRes.statusCode} UPGRADE-REFUSED ${target}`);
    clientSocket.end(`HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage ?? ""}\r\n\r\n`);
  });
  upstream.on("error", (error) => {
    log(`ERR UPGRADE ${target}: ${error.message}`);
    clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
  });
  clientSocket.on("error", () => upstream.destroy());
  upstream.end();
});

// Streaming responses die if either side applies Nagle-style buffering.
server.on("connection", (socket) => socket.setNoDelay(true));
server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  log(`proxy up on ${LISTEN_HOST}:${LISTEN_PORT} -> https://${cluster.host}:${cluster.port}${proxyPrefix}`);
  console.log(`gateway proxy listening on http://${LISTEN_HOST}:${LISTEN_PORT}`);
});

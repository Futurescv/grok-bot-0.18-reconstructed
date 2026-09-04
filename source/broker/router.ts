import { request as httpRequest, type IncomingMessage, type ServerResponse, type ClientRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Duplex } from "node:stream";

import { isBoxRouteRefusal, resolveBoxRoute, type BoxRoute } from "./box-routes.js";
import { scopeForNetworkToken } from "./identity.js";
import type { KubeClient } from "./kube.js";

/**
 * Reverse proxy from `/box/<networkToken>/<leg>/…` to one box Pod.
 *
 * Header handling is the load-bearing part:
 *  - `origin` MUST be removed. The in-box gateway 403s any request carrying one
 *    (gateway-server.ts), and the noVNC webview does send it.
 *  - `authorization` is passed through untouched, so the box's own token gate
 *    still applies behind this proxy rather than being replaced by it.
 *  - Nothing is buffered: `/events` is SSE with a 15s heartbeat, and the client
 *    aborts a stream that stalls for 35s.
 */
export const NETWORK_TOKEN_HEADER = "x-anyrun-network-token";
export const GATEWAY_TOKEN_HEADER = "x-sand-gateway-token";

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length"]);
// Browser-context headers: the gateway treats their presence as a browser-origin
// request, which it refuses outright.
const BROWSER_CONTEXT = new Set(["origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "sec-fetch-user"]);

export interface BoxLocation { readonly scope: string; readonly podName: string; readonly podIP: string }

export interface PodDialer {
  readonly kind: "direct" | "apiserver-proxy";
  open(target: { readonly location: BoxLocation; readonly port: number; readonly path: string; readonly method: string; readonly headers: Record<string, string | string[]> }): ClientRequest;
}

/** In-cluster: pod IPs are routable from the broker Pod. */
export function createDirectDialer(): PodDialer {
  return {
    kind: "direct",
    open: ({ location, port, path, method, headers }) => httpRequest({ host: location.podIP, port, path, method, headers, timeout: 0 }),
  };
}

/**
 * Laptop mode: reach the Pod through the apiserver's pod proxy, the same channel
 * deploy/acs/gateway-proxy.mjs uses. Two known asymmetries, both accepted for a
 * dev loop: the apiserver consumes `authorization` (so the gateway token is moved
 * to GATEWAY_TOKEN_HEADER, which the box also accepts), and it drops the query
 * string on WebSocket upgrades (so the token-gated fork display cannot work here).
 */
export function createApiserverProxyDialer(kube: KubeClient): PodDialer {
  return {
    kind: "apiserver-proxy",
    open: ({ location, port, path, method, headers }) => {
      const authorization = headers.authorization;
      const bearer = typeof authorization === "string" && authorization.startsWith("Bearer ") ? authorization.slice(7) : undefined;
      const forwarded: Record<string, string | string[]> = { ...headers, ...kube.authHeaders() };
      delete forwarded.authorization;
      if (bearer !== undefined) forwarded[GATEWAY_TOKEN_HEADER] = bearer;
      return httpsRequest({
        host: kube.endpoint.host,
        port: kube.endpoint.port,
        method,
        path: `/api/v1/namespaces/${encodeURIComponent(kube.namespace)}/pods/${encodeURIComponent(location.podName)}:${port}/proxy${path}`,
        headers: forwarded,
        timeout: 0,
        ...(kube.endpoint.tls.ca === undefined ? { rejectUnauthorized: false } : { ca: kube.endpoint.tls.ca }),
        ...(kube.endpoint.tls.cert === undefined ? {} : { cert: kube.endpoint.tls.cert, key: kube.endpoint.tls.key }),
      });
    },
  };
}

export function relayHeaders(source: IncomingMessage): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(source.headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || BROWSER_CONTEXT.has(lower) || value === undefined) continue;
    headers[lower] = value;
  }
  return headers;
}

export interface RouterDeps {
  readonly masterSecret: string;
  readonly dialer: PodDialer;
  /** Scopes with a live box, newest state; used to resolve a network token. */
  readonly knownScopes: () => readonly string[];
  readonly locate: (scope: string) => Promise<BoxLocation | undefined>;
  readonly onActivity: (scope: string, delta: number) => void;
  readonly log: (line: string) => void;
}

function noDelay(stream: Duplex): void {
  const candidate = stream as Duplex & { setNoDelay?: (value: boolean) => void };
  candidate.setNoDelay?.(true);
}

function refuse(response: ServerResponse, status: number, error: string): void {
  if (response.headersSent) { response.end(); return; }
  const body = JSON.stringify({ error });
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  response.end(body);
}

export function createBoxRouter(deps: RouterDeps) {
  const resolve = async (request: IncomingMessage): Promise<{ route: BoxRoute; location: BoxLocation } | { status: number; error: string }> => {
    const route = resolveBoxRoute(request.url ?? "/");
    if (isBoxRouteRefusal(route)) {
      return route.refusal === "not-a-box-path"
        ? { status: 404, error: "not a box path" }
        : { status: 400, error: `refused box path (${route.refusal})` };
    }
    // The webview injects the token on every request to this host; the path
    // segment is the fallback for the very first navigation.
    const header = request.headers[NETWORK_TOKEN_HEADER];
    const presented = (Array.isArray(header) ? header[0] : header) ?? route.token;
    const scope = scopeForNetworkToken(deps.masterSecret, presented, deps.knownScopes());
    if (scope === undefined) return { status: 401, error: "unknown box token" };
    const location = await deps.locate(scope);
    if (location === undefined) return { status: 503, error: "box is starting" };
    return { route, location };
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const resolved = await resolve(request);
    if ("status" in resolved) { refuse(response, resolved.status, resolved.error); return; }
    const { route, location } = resolved;
    deps.onActivity(location.scope, 1);
    let settled = false;
    const settle = (): void => { if (!settled) { settled = true; deps.onActivity(location.scope, -1); } };

    const upstream = deps.dialer.open({ location, port: route.port, path: route.path, method: request.method ?? "GET", headers: relayHeaders(request) });
    upstream.on("response", (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      response.flushHeaders();
      upstreamResponse.pipe(response);
      upstreamResponse.on("end", settle);
      upstreamResponse.on("error", settle);
    });
    upstream.on("error", (error) => {
      deps.log(`ERR ${request.method} ${route.leg}${route.path}: ${error.message}`);
      settle();
      refuse(response, 502, `box unreachable: ${error.message}`);
    });
    request.on("aborted", () => { upstream.destroy(); settle(); });
    response.on("close", settle);
    request.pipe(upstream);
  };

  const handleUpgrade = async (request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> => {
    const resolved = await resolve(request);
    if ("status" in resolved) { socket.end(`HTTP/1.1 ${resolved.status} ${resolved.error}\r\n\r\n`); return; }
    const { route, location } = resolved;
    deps.onActivity(location.scope, 1);
    let settled = false;
    const settle = (): void => { if (!settled) { settled = true; deps.onActivity(location.scope, -1); } };

    const headers = relayHeaders(request);
    headers.connection = "Upgrade";
    headers.upgrade = (Array.isArray(request.headers.upgrade) ? request.headers.upgrade[0] : request.headers.upgrade) ?? "websocket";
    const upstream = deps.dialer.open({ location, port: route.port, path: route.path, method: "GET", headers });
    upstream.on("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
      const lines = Object.entries(upstreamResponse.headers).flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).map(item => `${name}: ${String(item)}`));
      socket.write(`HTTP/1.1 101 ${upstreamResponse.statusMessage ?? "Switching Protocols"}\r\n${lines.join("\r\n")}\r\n\r\n`);
      // Both are net.Sockets at runtime; the event types only promise a Duplex.
      noDelay(socket);
      noDelay(upstreamSocket);
      if (upstreamHead != null && upstreamHead.length > 0) socket.write(upstreamHead);
      if (head.length > 0) upstreamSocket.write(head);
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
      const drop = (): void => { settle(); upstreamSocket.destroy(); socket.destroy(); };
      for (const stream of [upstreamSocket, socket]) { stream.on("error", drop); stream.on("close", drop); }
    });
    // An upgrade answered as a normal response is worth relaying: the viewer then
    // reports the status instead of hanging on a socket that will never speak.
    upstream.on("response", (upstreamResponse) => {
      deps.log(`UPGRADE refused ${upstreamResponse.statusCode} ${route.leg}${route.path}`);
      settle();
      socket.end(`HTTP/1.1 ${upstreamResponse.statusCode ?? 502} ${upstreamResponse.statusMessage ?? ""}\r\n\r\n`);
    });
    upstream.on("error", (error) => {
      deps.log(`ERR upgrade ${route.leg}${route.path}: ${error.message}`);
      settle();
      socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    });
    socket.on("error", () => { upstream.destroy(); settle(); });
    upstream.end();
  };

  return { handle, handleUpgrade };
}

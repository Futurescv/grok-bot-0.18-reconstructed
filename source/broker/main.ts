import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";

import { connectNodeAdapter } from "@connectrpc/connect-node";
import { Code, ConnectError } from "@connectrpc/connect";

import { DashboardService } from "../packages/proto/generated/aiserver/v1/dashboard_connect.js";
import { GetUserPrivacyModeResponse } from "../packages/proto/generated/aiserver/v1/dashboard_pb.js";
import { GrokBotService } from "../packages/proto/generated/aiserver/v1/grok_bot_connect.js";
import { createAllowlist } from "./allowlist.js";
import { createBrokerHandlers } from "./connect-handlers.js";
import { gatewayTokenFor } from "./identity.js";
import { createKubeClient, getPod, type Pod } from "./kube.js";
import { BOX_ANNOTATION_SCOPE, createProvisioner } from "./provisioner.js";
import { createApiserverProxyDialer, createBoxRouter, createDirectDialer } from "./router.js";

/**
 * The self-hosted replacement for the slice of Cursor's backend this app needs:
 * it provisions one box per API key and proxies that box's gateway and desktop
 * back to the client, so a packaged app only needs a URL and a key.
 *
 * One process serves three things on one port, split by path:
 *   /aiserver.v1.*  Connect RPC (binary proto, HTTP/1.1 — what the client sends)
 *   /box/<token>/*  reverse proxy to the caller's own Pod
 *   /runtime/*      the reconstructed .cjs files a box fetches while starting
 */
const DEFAULT_BOX_IMAGE = "public.ecr.aws/k0i0n2g5/cursorenvironments/universal:sand-box-latest";
const RUNTIME_FILES = { "host-main.cjs": "host-main.cjs", "box-exec-daemon.cjs": "box-exec-daemon.cjs" } as const;

function required(env: NodeJS.ProcessEnv, name: string): string {
  const direct = env[name]?.trim();
  if (direct != null && direct.length > 0) return direct;
  const file = env[`${name}_FILE`]?.trim();
  if (file != null && file.length > 0) {
    const value = readFileSync(file, "utf8").trim();
    if (value.length > 0) return value;
  }
  throw new Error(`${name} is required (set it, or ${name}_FILE pointing at a mounted secret)`);
}

function readOptionalFile(file: string | undefined): string | undefined {
  if (file == null || file.trim().length === 0) return undefined;
  try { const value = readFileSync(file.trim(), "utf8").trim(); return value.length > 0 ? value : undefined; } catch { return undefined; }
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = Number(env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function readRuntimePayload(directory: string): { readonly files: Map<string, Buffer>; readonly manifest: Buffer } {
  const files = new Map<string, Buffer>();
  const sha256: Record<string, string> = {};
  for (const name of Object.keys(RUNTIME_FILES)) {
    const file = path.join(directory, name);
    if (!existsSync(file)) continue;
    const bytes = readFileSync(file);
    files.set(name, bytes);
    sha256[name] = createHash("sha256").update(bytes).digest("hex");
  }
  return { files, manifest: Buffer.from(`${JSON.stringify({ sha256 }, null, 2)}\n`, "utf8") };
}

export async function startBroker(env: NodeJS.ProcessEnv = process.env) {
  const log = (line: string): void => { process.stdout.write(`[broker] ${line}\n`); };
  const kube = createKubeClient(env);
  const masterSecret = required(env, "BROKER_MASTER_SECRET");
  const publicBaseUrl = required(env, "PUBLIC_BASE_URL");
  const port = integer(env, "BROKER_PORT", 8080);
  const runtimeDir = env.BROKER_RUNTIME_DIR?.trim() || "/runtime-payload";
  const runtime = readRuntimePayload(runtimeDir);
  const idleTtlMs = integer(env, "IDLE_TTL_MS", 2 * 60 * 60_000);

  const allowlist = createAllowlist(kube, {
    ...(env.BROKER_DEV_KEYS == null ? {} : { extraKeys: env.BROKER_DEV_KEYS.split(",").map(key => key.trim()) }),
    onError: (error) => log(`allowlist refresh failed: ${error instanceof Error ? error.message : String(error)}`),
  });
  await allowlist.refresh().catch(error => log(`allowlist first read failed (continuing): ${String(error)}`));
  allowlist.start();

  // Optional: an operator-supplied inference endpoint for every box. Without it
  // boxes have no model credential until a user enters one in Settings → Router.
  const inferenceKey = env.BOX_INFERENCE_API_KEY?.trim() || readOptionalFile(env.BOX_INFERENCE_API_KEY_FILE);
  const inferenceEnv: Record<string, string> = {
    ...(inferenceKey == null ? {} : { GROKBOT_ANTHROPIC_API_KEY: inferenceKey }),
    ...(env.BOX_INFERENCE_BASE_URL?.trim() == null || env.BOX_INFERENCE_BASE_URL.trim().length === 0 ? {} : { GROKBOT_ANTHROPIC_BASE_URL: env.BOX_INFERENCE_BASE_URL.trim() }),
    ...(env.BOX_INFERENCE_MODEL?.trim() == null || env.BOX_INFERENCE_MODEL.trim().length === 0 ? {} : { GROKBOT_ANTHROPIC_MODEL: env.BOX_INFERENCE_MODEL.trim() }),
  };

  const provisioner = createProvisioner(kube, {
    masterSecret,
    inferenceEnv,
    image: env.BOX_IMAGE?.trim() || DEFAULT_BOX_IMAGE,
    runtimeBaseUrl: env.BOX_RUNTIME_BASE_URL?.trim() || `http://grok-bot-broker.${kube.namespace}.svc.cluster.local/runtime`,
    cpuRequest: env.BOX_CPU_REQUEST?.trim() || "1",
    memoryRequest: env.BOX_MEMORY_REQUEST?.trim() || "2Gi",
    cpuLimit: env.BOX_CPU_LIMIT?.trim() || "4",
    memoryLimit: env.BOX_MEMORY_LIMIT?.trim() || "8Gi",
    // The fixed nodes in this cluster sit at ~96% of allocatable CPU requests, so
    // a 1-CPU box only fits on the serverless (virtual-kubelet) nodes, which carry
    // a NoSchedule taint. With the toleration present the scheduler still prefers a
    // real node when one has room, and overflows to serverless when none does.
    ...(env.BOX_TOLERATE_SERVERLESS === "0" ? {} : { tolerations: [{ key: "virtual-kubelet.io/provider", operator: "Equal", value: "alibabacloud", effect: "NoSchedule" }] }),
    ensureWaitMs: integer(env, "BOX_ENSURE_WAIT_MS", 30_000),
    readyTimeoutMs: integer(env, "BOX_READY_TIMEOUT_MS", 300_000),
    pollMs: integer(env, "BOX_POLL_MS", 2_000),
    maxLiveBoxes: integer(env, "MAX_LIVE_BOXES", 10),
    now: Date.now,
  });

  // Live box inventory, refreshed on a timer. Routing only accepts a scope that
  // still has a live Pod *and* a key the allowlist still knows, so revoking a key
  // stops its traffic within one refresh instead of when the Pod is reaped.
  let livePods: readonly Pod[] = [];
  const activity = new Map<string, { open: number; lastAt: number }>();
  const touch = (scope: string, delta: number): void => {
    const current = activity.get(scope) ?? { open: 0, lastAt: Date.now() };
    activity.set(scope, { open: Math.max(0, current.open + delta), lastAt: Date.now() });
  };
  // The annotation, not the label: the label is truncated to fit Kubernetes' cap.
  const scopeOf = (pod: Pod): string => pod.metadata?.annotations?.[BOX_ANNOTATION_SCOPE] ?? "";
  const refreshInventory = async (): Promise<void> => {
    livePods = await provisioner.live();
  };
  const knownScopes = (): readonly string[] => {
    const allowed = new Set(allowlist.scopes());
    return livePods.map(scopeOf).filter(scope => scope.length > 0 && allowed.has(scope));
  };
  const locate = async (scope: string) => {
    const fromInventory = livePods.find(pod => scopeOf(pod) === scope);
    const ip = fromInventory?.status?.podIP;
    if (fromInventory != null && ip != null && ip.length > 0) return { scope, podName: fromInventory.metadata!.name!, podIP: ip };
    // Inventory can lag a fresh box by a few seconds; ask directly before refusing.
    const name = livePods.find(pod => scopeOf(pod) === scope)?.metadata?.name;
    const pod = name == null ? undefined : await getPod(kube, name);
    const freshIp = pod?.status?.podIP;
    return pod == null || freshIp == null || freshIp.length === 0 ? undefined : { scope, podName: pod.metadata!.name!, podIP: freshIp };
  };

  const dialMode = env.BROKER_DIAL_MODE?.trim() || (kube.mode === "in-cluster" ? "direct" : "apiserver-proxy");
  const router = createBoxRouter({
    masterSecret,
    dialer: dialMode === "apiserver-proxy" ? createApiserverProxyDialer(kube) : createDirectDialer(),
    knownScopes,
    locate,
    onActivity: touch,
    log,
  });

  const handlers = createBrokerHandlers({ allowlist, provisioner, masterSecret, publicBaseUrl, quotaRetryAfterSeconds: integer(env, "QUOTA_RETRY_AFTER_S", 900), idleWatchMs: integer(env, "MIGRATION_IDLE_WATCH_MS", 20_000), now: Date.now, log });
  const adapter = connectNodeAdapter({
    routes(connect) {
      // The reconstructed generated descriptors type `kind` as the widened
      // MethodKind, so the typed rpc() overload cannot tell unary from streaming
      // and rejects them. The cast is on the descriptors only — every
      // implementation below stays fully typed by createBrokerHandlers.
      const register = (service: unknown, method: unknown, implementation: unknown): void => {
        (connect.rpc as unknown as (s: unknown, m: unknown, i: unknown) => unknown)(service, method, implementation);
      };
      const methods = GrokBotService.methods;
      register(GrokBotService, methods.ensureSandBox, handlers.service.ensureSandBox);
      register(GrokBotService, methods.ensureSandBoxWindow, handlers.service.ensureSandBoxWindow);
      register(GrokBotService, methods.recreateSandBox, handlers.service.recreateSandBox);
      register(GrokBotService, methods.forceRecreateSandBox, handlers.service.forceRecreateSandBox);
      register(GrokBotService, methods.getSandBoxRunState, handlers.service.getSandBoxRunState);
      register(GrokBotService, methods.watchSandBoxMigration, handlers.service.watchSandBoxMigration);
      // Answering this saves the client a 3s timeout on every run. The default
      // (unspecified) privacy mode is the ghost-mode-safe one.
      register(DashboardService, DashboardService.methods.getUserPrivacyMode, async () => new GetUserPrivacyModeResponse({}));
    },
  });

  const bearerOf = (request: IncomingMessage): string | undefined => {
    const header = request.headers.authorization;
    const value = Array.isArray(header) ? header[0] : header;
    return value != null && value.startsWith("Bearer ") ? value.slice(7).trim() : undefined;
  };
  const json = (response: ServerResponse, status: number, value: unknown): void => {
    const body = JSON.stringify(value);
    response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
    response.end(body);
  };

  const server = createServer((request, response) => {
    const url = request.url ?? "/";
    void (async () => {
      try {
        if (url === "/healthz") return json(response, 200, { ok: true, mode: kube.mode, dial: dialMode, boxes: livePods.length });
        if (url.startsWith("/box/")) return await router.handle(request, response);
        // Deliberately not exposed through the Ingress: only in-cluster boxes need it.
        if (url.startsWith("/runtime/")) {
          const name = url.slice("/runtime/".length).split("?")[0] ?? "";
          if (name === "manifest.json") { response.writeHead(200, { "content-type": "application/json", "content-length": runtime.manifest.byteLength }); response.end(runtime.manifest); return; }
          const bytes = runtime.files.get(name);
          if (bytes === undefined) return json(response, 404, { error: `no runtime file named ${name}` });
          response.writeHead(200, { "content-type": "application/javascript", "content-length": bytes.byteLength });
          response.end(bytes);
          return;
        }
        if (url.startsWith("/broker/verify")) {
          const key = bearerOf(request);
          const displayName = key == null ? undefined : allowlist.lookup(key);
          return displayName === undefined ? json(response, 401, { error: "unknown API key" }) : json(response, 200, { ok: true, displayName });
        }
        if (url.startsWith("/sand-box/local-exec-daemon-credential")) {
          const key = bearerOf(request);
          const displayName = key == null ? undefined : allowlist.lookup(key);
          if (displayName === undefined) return json(response, 401, { error: "unknown API key" });
          const scope = createHash("sha256").update(key!).digest("hex");
          return json(response, 200, { credential: gatewayTokenFor(masterSecret, scope), expiresAtMs: Date.now() + 7 * 24 * 60 * 60_000 });
        }
        if (url.startsWith("/sand/feedback")) { response.writeHead(204); response.end(); return; }
        if (url.startsWith("/aiserver.")) return adapter(request, response);
        return json(response, 404, { error: `no broker route for ${url}` });
      } catch (error) {
        const message = error instanceof ConnectError ? error.rawMessage : error instanceof Error ? error.message : String(error);
        log(`ERR ${request.method} ${url}: ${message}`);
        if (!response.headersSent) json(response, error instanceof ConnectError && error.code === Code.Unauthenticated ? 401 : 500, { error: message });
        else response.end();
      }
    })();
  });
  server.on("connection", socket => socket.setNoDelay(true));
  server.on("upgrade", (request, socket, head) => { void router.handleUpgrade(request, socket, head); });

  await refreshInventory().catch(error => log(`inventory first read failed (continuing): ${String(error)}`));
  const inventoryTimer = setInterval(() => { void refreshInventory().catch(error => log(`inventory refresh failed: ${String(error)}`)); }, integer(env, "INVENTORY_REFRESH_MS", 15_000));
  inventoryTimer.unref();

  // Idle reclaim: the app holds a permanent /events stream while it is open, so
  // "no open streams and quiet for a while" is a good proxy for "nobody is using
  // this box". State is in memory only — after a broker restart every box gets a
  // fresh grace period, which is the safe direction to be wrong in.
  const reaperTimer = setInterval(() => {
    void (async () => {
      const now = Date.now();
      for (const pod of livePods) {
        const scope = scopeOf(pod);
        const seen = activity.get(scope);
        if (scope.length === 0 || seen == null || seen.open > 0 || now - seen.lastAt < idleTtlMs) continue;
        log(`reaping idle box scope=${scope.slice(0, 12)} idle=${Math.round((now - seen.lastAt) / 60_000)}m`);
        await provisioner.destroy(scope).catch(error => log(`reap failed: ${String(error)}`));
        activity.delete(scope);
      }
      await refreshInventory().catch(() => undefined);
    })();
  }, integer(env, "REAPER_INTERVAL_MS", 60_000));
  reaperTimer.unref();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => { server.off("error", reject); resolve(); });
  });
  log(`listening on 0.0.0.0:${port} kube=${kube.mode} dial=${dialMode} public=${publicBaseUrl} runtime=${[...runtime.files.keys()].join(",") || "(none)"} inference=${Object.keys(inferenceEnv).length > 0 ? (env.BOX_INFERENCE_BASE_URL?.trim() ?? "(default endpoint)") : "(none: users must supply a key)"}`);
  return {
    port,
    close: async () => {
      allowlist.stop();
      clearInterval(inventoryTimer);
      clearInterval(reaperTimer);
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

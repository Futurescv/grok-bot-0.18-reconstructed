import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-api-key-session-"));
  const output = path.join(temporary, "api-key-session.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/electron-main/account/api-key-session.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

/** @typedef {{ url: string, close(): Promise<void>, setStatus(status: number): void }} FakeGateway */

// Minimal stand-in for the box gateway: bearer-checked /events that answers
// with the configured status and then keeps the stream open, exactly like the
// real SSE endpoint the service probes.
async function startFakeGateway(token) {
  let status = 200;
  const server = http.createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401); response.end(); return; }
    if (request.url !== "/events") { response.writeHead(404); response.end(); return; }
    response.writeHead(status, { "content-type": "text/event-stream" });
    // Flush the status line now; the body intentionally never arrives.
    response.flushHeaders();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("fake gateway did not report a port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    setStatus(next) { status = next; },
    close: () => new Promise((resolve, reject) => {
      server.closeAllConnections();
      server.close((error) => (error == null ? resolve() : reject(error)));
    }),
  };
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(() => resolve()));
  return port;
}

test("API-key session config activates only for a fully configured self-hosted gateway (no broker sources)", async () => {
  const loaded = await loadModule();
  try {
    const { resolveApiKeySessionConfig } = loaded.module;
    assert.equal(resolveApiKeySessionConfig({}), null);
    assert.equal(resolveApiKeySessionConfig({ SAND_HOST_GATEWAY_URL: "http://127.0.0.1:11340" }), null);
    assert.equal(resolveApiKeySessionConfig({ SAND_HOST_GATEWAY_URL: "not a url", SAND_HOST_GATEWAY_TOKEN: "t" }), null);
    // SAND_AUTH_MODE=cursor keeps the account login authoritative.
    assert.equal(resolveApiKeySessionConfig({ SAND_HOST_GATEWAY_URL: "http://127.0.0.1:11340", SAND_HOST_GATEWAY_TOKEN: "t", SAND_AUTH_MODE: "cursor" }), null);
    assert.deepEqual(
      resolveApiKeySessionConfig({ SAND_HOST_GATEWAY_URL: "http://127.0.0.1:11340/", SAND_HOST_GATEWAY_TOKEN: "t" }),
      { mode: "gateway", gatewayUrl: "http://127.0.0.1:11340/", gatewayToken: "t" },
    );
  } finally {
    await loaded.dispose();
  }
});

test("a valid gateway API key opens the session and never doubles as a backend token", async () => {
  const loaded = await loadModule();
  const gateway = await startFakeGateway("real-key");
  try {
    const service = new loaded.module.SandApiKeySessionAuthService(
      { mode: "gateway", gatewayUrl: gateway.url, gatewayToken: "real-key" },
    );
    const status = await service.getStatus();
    assert.equal(status.kind, "logged-in");
    if (status.kind !== "logged-in") return;
    assert.equal(status.authId, "api-key-session");
    assert.equal(status.displayName, "Self-hosted (API key)");
    const backendToken = await service.getValidAccessToken();
    assert.equal(backendToken, "api-key-local-session");
    assert.notEqual(backendToken, "real-key");
  } finally {
    await gateway.close();
    await loaded.dispose();
  }
});

test("a rejected key and an unreachable gateway both land on logged-out with the reason", async () => {
  const loaded = await loadModule();
  const gateway = await startFakeGateway("real-key");
  const deadPort = await freePort();
  try {
    const rejected = new loaded.module.SandApiKeySessionAuthService({ mode: "gateway", gatewayUrl: gateway.url, gatewayToken: "wrong-key" });
    const rejectedStatus = await rejected.getStatus();
    assert.match(rejectedStatus.kind === "logged-out" ? (rejectedStatus.errorMessage ?? "") : "", /rejected this API key/);

    const unreachable = new loaded.module.SandApiKeySessionAuthService({ mode: "gateway", gatewayUrl: `http://127.0.0.1:${deadPort}` , gatewayToken: "real-key" });
    const unreachableStatus = await unreachable.getStatus();
    assert.match(unreachableStatus.kind === "logged-out" ? (unreachableStatus.errorMessage ?? "") : "", /Cannot reach the gateway/);
  } finally {
    await gateway.close();
    await loaded.dispose();
  }
});

test("login() re-verifies past the status cache and logout() reports signed-out", async () => {
  const loaded = await loadModule();
  const gateway = await startFakeGateway("real-key");
  try {
    const service = new loaded.module.SandApiKeySessionAuthService({ mode: "gateway", gatewayUrl: gateway.url, gatewayToken: "real-key" });
    gateway.setStatus(401);
    const denied = await service.getStatus();
    assert.equal(denied.kind, "logged-out");
    gateway.setStatus(200);
    const recovered = await service.login();
    assert.equal(recovered.kind, "logged-in");
    const seen = [];
    service.subscribe((status) => seen.push(status.kind));
    const signedOut = await service.logout();
    assert.equal(signedOut.kind, "logged-out");
    assert.deepEqual(seen, ["logged-out"]);
    assert.equal((await service.getStatus()).kind, "logged-out");
  } finally {
    await gateway.close();
    await loaded.dispose();
  }
});

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadGatewayServer() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-gateway-token-"));
  const outfile = path.join(temporary, "gateway-server.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/host/gateway-server.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(outfile).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

const asRequest = (headers) => ({ headers });

test("the gateway accepts its token from the bearer or the pass-through header", async () => {
  const loaded = await loadGatewayServer();
  try {
    const { isAuthorized } = loaded.module;
    const token = "0123456789abcdef";

    assert.equal(isAuthorized(asRequest({ authorization: `Bearer ${token}` }), token), true);
    // The Kubernetes apiserver proxy deletes Authorization, so the same token
    // arrives in the pass-through header instead.
    assert.equal(isAuthorized(asRequest({ "x-sand-gateway-token": token }), token), true);
    assert.equal(isAuthorized(asRequest({ authorization: `Bearer ${token}`, "x-sand-gateway-token": token }), token), true);

    assert.equal(isAuthorized(asRequest({}), token), false);
    assert.equal(isAuthorized(asRequest({ "x-sand-gateway-token": "wrong-but-same-len" }), token), false);
    assert.equal(isAuthorized(asRequest({ "x-sand-gateway-token": "short" }), token), false);
    // A stripped Authorization must not fall through to an empty header value.
    assert.equal(isAuthorized(asRequest({ "x-sand-gateway-token": "" }), token), false);
    assert.equal(isAuthorized(asRequest({ authorization: token }), token), false, "raw token without the Bearer scheme");
    // Arrays arrive when a header is repeated; the first value is what counts.
    assert.equal(isAuthorized(asRequest({ "x-sand-gateway-token": [token, "other"] }), token), true);
  } finally {
    await loaded.dispose();
  }
});

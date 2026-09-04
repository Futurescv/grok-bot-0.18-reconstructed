import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { transform } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function load(relative) {
  const source = await readFile(path.join(repoRoot, relative), "utf8");
  const { code } = await transform(source, { format: "esm", loader: "ts", target: "es2022" });
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

test("a key is its own identity, and both box tokens derive from one master secret", async () => {
  const identity = await load("source/broker/identity.ts");
  const scope = identity.keyScope("gbk_example");
  // The desktop computes exactly this for a non-JWT credential (accountCacheScope).
  assert.match(scope, /^[0-9a-f]{64}$/);
  assert.equal(identity.keyScope("gbk_example"), scope, "stable across calls");
  assert.notEqual(identity.keyScope("gbk_other"), scope);
  assert.equal(identity.podNameFor(scope), `box-${scope.slice(0, 12)}`);
  assert.match(identity.podNameFor(scope), /^[a-z0-9-]{1,63}$/, "a pod name must be a DNS label");

  const network = identity.networkTokenFor("master", scope);
  const gateway = identity.gatewayTokenFor("master", scope);
  assert.match(network, /^[A-Za-z0-9_-]+$/, "base64url so it survives a URL path and query");
  assert.notEqual(network, gateway, "the routing token is not the box's own auth token");
  assert.equal(identity.networkTokenFor("master", scope), network, "recomputable, so nothing is stored");
  assert.notEqual(identity.networkTokenFor("rotated", scope), network, "rotating the master invalidates every box");
});

test("an unknown network token resolves to nothing instead of guessing a box", async () => {
  const identity = await load("source/broker/identity.ts");
  const mine = identity.keyScope("mine");
  const theirs = identity.keyScope("theirs");
  const known = [mine, theirs];
  assert.equal(identity.scopeForNetworkToken("master", identity.networkTokenFor("master", mine), known), mine);
  assert.equal(identity.scopeForNetworkToken("master", identity.networkTokenFor("master", theirs), known), theirs);
  assert.equal(identity.scopeForNetworkToken("master", "not-a-real-token", known), undefined);
  // A token that is valid for a scope the broker does not know about is still refused.
  assert.equal(identity.scopeForNetworkToken("master", identity.networkTokenFor("master", identity.keyScope("third")), known), undefined);
  assert.equal(identity.sameToken(undefined, "x"), false);
  assert.equal(identity.sameToken("short", "longer-value"), false, "length mismatch must not throw");
});

test("box paths map onto one leg each, with the prefix stripped and the query preserved", async () => {
  const { resolveBoxRoute, isBoxRouteRefusal, boxLegBaseUrl } = await load("source/broker/box-routes.ts");
  const nt = "AbC-123_xyz";
  const cases = [
    // [url, leg, port, upstream path]
    [`/box/${nt}/gw/api/listAgents`, "gw", 1340, "/api/listAgents"],
    [`/box/${nt}/gw/events?channels=transcript`, "gw", 1340, "/events?channels=transcript"],
    [`/box/${nt}/gw/health`, "gw", 1340, "/health"],
    [`/box/${nt}/gw/avatars/agent-1?v=2`, "gw", 1340, "/avatars/agent-1?v=2"],
    [`/box/${nt}/vnc/vnc.html?network_token=${nt}`, "vnc", 6080, `/vnc.html?network_token=${nt}`],
    [`/box/${nt}/vnc/app/localization.js`, "vnc", 6080, "/app/localization.js"],
    [`/box/${nt}/vnc/websockify`, "vnc", 6080, "/websockify"],
    // The fork leg is the one whose token must survive: websockify's TokenFile
    // plugin refuses the connection without it.
    [`/box/${nt}/fork/websockify?token=3&network_token=${nt}`, "fork", 6081, `/websockify?token=3&network_token=${nt}`],
    [`/box/${nt}/fork/vnc.html?path=websockify%3Ftoken%3D3`, "fork", 6081, "/vnc.html?path=websockify%3Ftoken%3D3"],
    [`/box/${nt}/vnc`, "vnc", 6080, "/"],
    [`/box/${nt}/vnc/`, "vnc", 6080, "/"],
  ];
  for (const [url, leg, port, expected] of cases) {
    const route = resolveBoxRoute(url);
    assert.equal(isBoxRouteRefusal(route), false, `${url} should route`);
    if (isBoxRouteRefusal(route)) continue;
    assert.deepEqual({ leg: route.leg, port: route.port, path: route.path, token: route.token }, { leg, port, path: expected, token: nt }, url);
  }
  assert.equal(boxLegBaseUrl("http://alb.example/", nt, "fork"), `http://alb.example/box/${nt}/fork`);
});

test("anything that is not a well-formed box path is refused, not normalised", async () => {
  const { resolveBoxRoute, isBoxRouteRefusal } = await load("source/broker/box-routes.ts");
  const refusalFor = (url) => {
    const route = resolveBoxRoute(url);
    return isBoxRouteRefusal(route) ? route.refusal : `ROUTED:${route.leg}${route.path}`;
  };
  assert.equal(refusalFor("/healthz"), "not-a-box-path");
  assert.equal(refusalFor("/aiserver.v1.GrokBotService/EnsureSandBox"), "not-a-box-path");
  assert.equal(refusalFor("/box/"), "malformed");
  assert.equal(refusalFor("/box/tok"), "unknown-leg");
  assert.equal(refusalFor("/box/tok/"), "unknown-leg");
  assert.equal(refusalFor("/box/tok/admin/whatever"), "unknown-leg", "only the three known legs exist");
  assert.equal(refusalFor("/box/has space/gw/api/x"), "malformed", "tokens are base64url");
  // Traversal, raw and encoded, single and double.
  assert.equal(refusalFor("/box/tok/gw/../../secret"), "traversal");
  assert.equal(refusalFor("/box/tok/vnc/%2e%2e/%2e%2e/etc/passwd"), "traversal");
  assert.equal(refusalFor("/box/tok/vnc/%252e%252e/etc/passwd"), "traversal");
  assert.equal(refusalFor("/box/tok/vnc/..\\windows"), "traversal");
  // A dotted filename is fine; only a full ".." segment is traversal.
  assert.equal(refusalFor("/box/tok/vnc/app/ui..js"), "ROUTED:vnc/app/ui..js");
});

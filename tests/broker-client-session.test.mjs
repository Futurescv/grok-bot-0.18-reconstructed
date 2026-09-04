import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function load(relative) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-broker-client-"));
  const outfile = path.join(temporary, "module.mjs");
  await build({ entryPoints: [path.join(repoRoot, relative)], outfile, bundle: true, format: "esm", platform: "node", target: "node22" });
  const module = await import(`${pathToFileURL(outfile).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

// A stand-in for Electron's safeStorage: reversible, and obviously not the
// plaintext, which is all the store's contract needs.
const fakeSafeStorage = (available = true) => ({
  isAvailable: () => available,
  encrypt: (plaintext) => `enc:${Buffer.from(plaintext).toString("base64")}`,
  decrypt: (stored) => Buffer.from(stored.replace(/^enc:/, ""), "base64").toString("utf8"),
});

test("the broker key is stored encrypted, 0600, and adopted from a bootstrap file once", async () => {
  const loaded = await load("source/electron-main/account/broker-key-store.ts");
  const dir = await mkdtemp(path.join(os.tmpdir(), "grok-broker-key-"));
  try {
    const filePath = path.join(dir, "broker-key.json");
    const bootstrapFilePath = path.join(dir, "bootstrap-key");
    const store = loaded.module.createBrokerKeyStore({ filePath, bootstrapFilePath, codec: fakeSafeStorage() });

    assert.equal(store.read(), undefined, "nothing stored and no bootstrap file");

    await writeFile(bootstrapFilePath, "  gbk_from-bootstrap  \n", "utf8");
    assert.equal(store.read(), "gbk_from-bootstrap", "adopted and trimmed");
    assert.equal(store.read(), "gbk_from-bootstrap", "still readable from the encrypted store");
    await assert.rejects(() => stat(bootstrapFilePath), "the plaintext bootstrap copy is removed once stored");

    const onDisk = JSON.parse(await readFile(filePath, "utf8"));
    assert.equal(onDisk.encrypted, true);
    assert.match(onDisk.key, /^enc:/);
    assert.doesNotMatch(onDisk.key, /gbk_from-bootstrap/, "the plaintext key is not on disk");
    assert.equal((await stat(filePath)).mode & 0o777, 0o600);

    store.write("gbk_typed-by-user");
    assert.equal(store.read(), "gbk_typed-by-user");
    store.clear();
    assert.equal(store.read(), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await loaded.dispose();
  }
});

test("without encrypted storage the key is still usable, and marked as unencrypted", async () => {
  const loaded = await load("source/electron-main/account/broker-key-store.ts");
  const dir = await mkdtemp(path.join(os.tmpdir(), "grok-broker-key-plain-"));
  try {
    const filePath = path.join(dir, "broker-key.json");
    const store = loaded.module.createBrokerKeyStore({ filePath, codec: fakeSafeStorage(false) });
    store.write("gbk_plain");
    assert.equal(store.read(), "gbk_plain");
    assert.equal(JSON.parse(await readFile(filePath, "utf8")).encrypted, false);
    assert.equal((await stat(filePath)).mode & 0o777, 0o600, "still not world-readable");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await loaded.dispose();
  }
});

test("broker mode activates from a packaged backend plus a stored key, and an explicit gateway still wins", async () => {
  const loaded = await load("source/electron-main/account/api-key-session.ts");
  const { resolveApiKeySessionConfig } = loaded.module;
  try {
    const sources = { brokerBackendUrl: () => "http://broker.example", brokerApiKey: () => "gbk_key" };
    assert.equal(resolveApiKeySessionConfig({}, {}), null, "nothing configured");
    // A packaged backend with no key yet is still broker mode: that is the state
    // in which the gate has to ask for a key (see the key-window test below).
    assert.deepEqual(resolveApiKeySessionConfig({}, { brokerBackendUrl: () => "http://broker.example" }), { mode: "broker", backendUrl: "http://broker.example/", apiKey: "" });
    assert.equal(resolveApiKeySessionConfig({}, { brokerApiKey: () => "gbk_key" }), null, "key but this build ships no backend");
    assert.equal(resolveApiKeySessionConfig({ SAND_AUTH_MODE: "cursor" }, sources), null, "Cursor auth forced");

    assert.deepEqual(resolveApiKeySessionConfig({}, sources), { mode: "broker", backendUrl: "http://broker.example/", apiKey: "gbk_key" });
    // A gateway pair is the local/dev deployment and takes precedence.
    assert.deepEqual(
      resolveApiKeySessionConfig({ SAND_HOST_GATEWAY_URL: "http://127.0.0.1:11340", SAND_HOST_GATEWAY_TOKEN: "tok" }, sources),
      { mode: "gateway", gatewayUrl: "http://127.0.0.1:11340/", gatewayToken: "tok" },
    );
  } finally {
    await loaded.dispose();
  }
});

test("the user's key reaches our broker and nothing else", async () => {
  const loaded = await load("source/electron-main/account/api-key-session.ts");
  try {
    const service = new loaded.module.SandApiKeySessionAuthService({ mode: "broker", backendUrl: "http://broker.example/", apiKey: "gbk_secret" });
    assert.equal(await service.getValidAccessToken({ backendUrl: "http://broker.example/aiserver.v1.GrokBotService/EnsureSandBox" }), "gbk_secret");
    assert.equal(await service.getValidAccessToken(), "gbk_secret", "our own probes ask without a URL");
    // The sentinel, not the key: these clients are pointed somewhere that did not issue it.
    for (const elsewhere of ["https://api2.cursor.sh", "http://broker.example.evil", "https://broker.example", "not a url"]) {
      assert.equal(await service.getValidAccessToken({ backendUrl: elsewhere }), "api-key-local-session", elsewhere);
    }
    // Gateway mode never hands out its token as a backend credential.
    const gateway = new loaded.module.SandApiKeySessionAuthService({ mode: "gateway", gatewayUrl: "http://127.0.0.1:11340/", gatewayToken: "gwtok" });
    assert.equal(await gateway.getValidAccessToken({ backendUrl: "http://127.0.0.1:11340/" }), "api-key-local-session");
  } finally {
    await loaded.dispose();
  }
});

test("broker mode verifies the key against /broker/verify and reports the reason", async () => {
  const loaded = await load("source/electron-main/account/api-key-session.ts");
  try {
    const seen = [];
    const fetchImpl = async (url, init) => {
      seen.push({ url: String(url), authorization: init.headers.authorization });
      if (String(url).endsWith("/broker/verify")) return new Response(JSON.stringify({ ok: true, displayName: "alice" }), { status: 200 });
      return new Response("", { status: 404 });
    };
    const service = new loaded.module.SandApiKeySessionAuthService(
      { mode: "broker", backendUrl: "http://broker.example/", apiKey: "gbk_secret" },
      { fetchImpl },
    );
    const status = await service.getStatus();
    assert.equal(status.kind, "logged-in");
    assert.deepEqual(seen, [{ url: "http://broker.example/broker/verify", authorization: "Bearer gbk_secret" }]);

    const rejected = new loaded.module.SandApiKeySessionAuthService(
      { mode: "broker", backendUrl: "http://broker.example/", apiKey: "gbk_bad" },
      { fetchImpl: async () => new Response("", { status: 401 }) },
    );
    const refused = await rejected.getStatus();
    assert.equal(refused.kind, "logged-out");
    assert.match(refused.errorMessage ?? "", /rejected this API key/);
    assert.doesNotMatch(refused.errorMessage ?? "", /SAND_HOST_GATEWAY_TOKEN/, "broker copy must not tell the user to set env vars");
  } finally {
    await loaded.dispose();
  }
});

test("with no key yet, sign-in opens the key window, stores what is typed, and verifies it", async () => {
  const loaded = await load("source/electron-main/account/api-key-session.ts");
  try {
    // A build packaged against a broker is in broker mode even before a key
    // exists — otherwise the user would be shown the Cursor sign-in wall.
    const pending = resolveOrThrow(loaded.module, { brokerBackendUrl: () => "http://broker.example" });
    assert.deepEqual(pending, { mode: "broker", backendUrl: "http://broker.example/", apiKey: "" });

    const stored = [];
    let prompts = 0;
    const service = new loaded.module.SandApiKeySessionAuthService(pending, {
      fetchImpl: async (_url, init) => new Response("", { status: init.headers.authorization === "Bearer gbk_typed" ? 200 : 401 }),
      promptForApiKey: async () => { prompts += 1; return "  gbk_typed  "; },
      storeApiKey: (key) => stored.push(key),
    });

    const before = await service.getStatus();
    assert.equal(before.kind, "logged-out");
    assert.match(before.errorMessage ?? "", /Enter your API key/);
    assert.equal(await service.getValidAccessToken({ backendUrl: "http://broker.example/" }), "api-key-local-session", "no key means no credential to hand out");
    assert.equal(prompts, 0, "showing status must not pop a window");

    const after = await service.login();
    assert.equal(after.kind, "logged-in");
    assert.equal(prompts, 1);
    assert.deepEqual(stored, ["gbk_typed"], "trimmed and persisted");
    assert.equal(await service.getValidAccessToken({ backendUrl: "http://broker.example/" }), "gbk_typed");

    // Already signed in: signing in again must not ask for another key.
    await service.login();
    assert.equal(prompts, 1);
  } finally {
    await loaded.dispose();
  }
});

test("cancelling the key window leaves the gate shut without storing anything", async () => {
  const loaded = await load("source/electron-main/account/api-key-session.ts");
  try {
    const stored = [];
    const service = new loaded.module.SandApiKeySessionAuthService(
      { mode: "broker", backendUrl: "http://broker.example/", apiKey: "" },
      { fetchImpl: async () => new Response("", { status: 200 }), promptForApiKey: async () => undefined, storeApiKey: (key) => stored.push(key) },
    );
    const status = await service.login();
    assert.equal(status.kind, "logged-out");
    assert.match(status.errorMessage ?? "", /Enter your API key/);
    assert.deepEqual(stored, []);
  } finally {
    await loaded.dispose();
  }
});

test("the key window markup carries the backend it will send the key to, and nothing else", async () => {
  const loaded = await load("source/electron-main/account/broker-key-window.ts");
  try {
    const html = loaded.module.brokerKeyWindowHtml({ backendLabel: "broker.example", channel: "sand:broker-key-submit" });
    assert.match(html, /Paste the API key/);
    assert.match(html, /sent only to broker\.example/, "the user is told where the key goes");
    assert.match(html, /type="password"/);
    assert.match(html, /default-src 'none'/, "the form cannot fetch anything");
    assert.doesNotMatch(html, /https?:\/\//, "no remote assets");
  } finally {
    await loaded.dispose();
  }
});

function resolveOrThrow(module, sources) {
  const config = module.resolveApiKeySessionConfig({}, sources);
  assert.notEqual(config, null);
  return config;
}

test("signing out forgets the key, so the next sign-in can use a different one", async () => {
  const loaded = await load("source/electron-main/account/api-key-session.ts");
  try {
    const stored = ["gbk_first"];
    let prompted = 0;
    const service = new loaded.module.SandApiKeySessionAuthService(
      { mode: "broker", backendUrl: "http://broker.example/", apiKey: "gbk_first" },
      {
        fetchImpl: async () => new Response("", { status: 200 }),
        promptForApiKey: async () => { prompted += 1; return "gbk_second"; },
        storeApiKey: (key) => stored.push(key),
        clearApiKey: () => { stored.length = 0; },
      },
    );
    assert.equal((await service.getStatus()).kind, "logged-in");

    assert.equal((await service.logout()).kind, "logged-out");
    assert.deepEqual(stored, [], "the stored key is forgotten, not merely ignored");
    assert.equal(await service.getValidAccessToken({ backendUrl: "http://broker.example/" }), "api-key-local-session");

    // The next sign-in asks again, and takes the new key.
    assert.equal((await service.login()).kind, "logged-in");
    assert.equal(prompted, 1);
    assert.deepEqual(stored, ["gbk_second"]);
    assert.equal(await service.getValidAccessToken({ backendUrl: "http://broker.example/" }), "gbk_second");
  } finally {
    await loaded.dispose();
  }
});

test("a gateway session's logout leaves nothing to clear", async () => {
  const loaded = await load("source/electron-main/account/api-key-session.ts");
  try {
    let cleared = 0;
    const service = new loaded.module.SandApiKeySessionAuthService(
      { mode: "gateway", gatewayUrl: "http://127.0.0.1:11340/", gatewayToken: "tok" },
      { fetchImpl: async () => new Response("", { status: 200 }), clearApiKey: () => { cleared += 1; } },
    );
    await service.logout();
    assert.equal(cleared, 0, "the gateway token comes from the environment, not from us");
  } finally {
    await loaded.dispose();
  }
});

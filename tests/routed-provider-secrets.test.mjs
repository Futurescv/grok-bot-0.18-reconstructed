import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { transform } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule() {
  const source = await readFile(path.join(repoRoot, "source/host/extensions/inference/routed-provider-secrets.ts"), "utf8");
  const { code } = await transform(source, { format: "esm", loader: "ts", target: "es2022" });
  // A fresh module instance per test: the adopted map is process-wide state.
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}#${Math.random()}`);
}

test("a key pushed to the box is also usable by the coordinator that runs routed inference", async () => {
  const { adoptRoutedProviderSecrets, routedProviderSecret } = await loadModule();
  const none = () => ({});
  assert.equal(routedProviderSecret("GROKBOT_ANTHROPIC_API_KEY", none), undefined, "nothing configured anywhere");

  // Exactly the argument shape of the setBoxSecrets RPC the coordinator forwards.
  adoptRoutedProviderSecrets({ secrets: { GROKBOT_ANTHROPIC_API_KEY: "from-ui", GROKBOT_ANTHROPIC_MODEL: "glm-test" } });
  assert.equal(routedProviderSecret("GROKBOT_ANTHROPIC_API_KEY", none), "from-ui");
  assert.equal(routedProviderSecret("GROKBOT_ANTHROPIC_MODEL", none), "glm-test");
  // A bare map is accepted too, and replaces the previous set rather than merging.
  adoptRoutedProviderSecrets({ GROKBOT_ANTHROPIC_API_KEY: "second" });
  assert.equal(routedProviderSecret("GROKBOT_ANTHROPIC_API_KEY", none), "second");
  assert.equal(routedProviderSecret("GROKBOT_ANTHROPIC_MODEL", none), undefined, "a push is the whole set, not a patch");
});

test("resolution order is env, then the adopted push, then the box's on-disk store", async () => {
  const { adoptRoutedProviderSecrets, routedProviderSecret } = await loadModule();
  const previous = process.env.GROKBOT_TEST_SECRET;
  const onDisk = () => ({ GROKBOT_TEST_SECRET: "from-disk" });
  try {
    delete process.env.GROKBOT_TEST_SECRET;
    assert.equal(routedProviderSecret("GROKBOT_TEST_SECRET", onDisk), "from-disk");

    adoptRoutedProviderSecrets({ secrets: { GROKBOT_TEST_SECRET: "from-ui" } });
    assert.equal(routedProviderSecret("GROKBOT_TEST_SECRET", onDisk), "from-ui", "the UI outranks the box file");

    process.env.GROKBOT_TEST_SECRET = "  from-env  ";
    assert.equal(routedProviderSecret("GROKBOT_TEST_SECRET", onDisk), "from-env", "an explicit environment still wins, and is trimmed");

    // Blank values are not credentials; fall through to the next source.
    process.env.GROKBOT_TEST_SECRET = "   ";
    assert.equal(routedProviderSecret("GROKBOT_TEST_SECRET", onDisk), "from-ui");
    adoptRoutedProviderSecrets({ secrets: { GROKBOT_TEST_SECRET: "" } });
    assert.equal(routedProviderSecret("GROKBOT_TEST_SECRET", onDisk), "from-disk");
  } finally {
    if (previous === undefined) delete process.env.GROKBOT_TEST_SECRET;
    else process.env.GROKBOT_TEST_SECRET = previous;
  }
});

test("non-string and malformed pushes are ignored rather than crashing a turn", async () => {
  const { adoptRoutedProviderSecrets, routedProviderSecret } = await loadModule();
  const none = () => ({});
  adoptRoutedProviderSecrets({ secrets: { GOOD: "yes", NUMBER: 42, NESTED: { a: 1 }, NULL: null } });
  assert.equal(routedProviderSecret("GOOD", none), "yes");
  for (const name of ["NUMBER", "NESTED", "NULL"]) assert.equal(routedProviderSecret(name, none), undefined);
  for (const bogus of [undefined, null, "string", 7, [], { secrets: "nope" }]) {
    adoptRoutedProviderSecrets(bogus);
    assert.equal(routedProviderSecret("GOOD", none), undefined);
  }
});

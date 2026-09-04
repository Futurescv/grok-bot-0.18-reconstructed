import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadStore() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-settings-provider-"));
  const outfile = path.join(temporary, "sand-settings-store.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/shared/node/settings/sand-settings-store.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(outfile).href}?${Date.now()}`);
  return { module, dir: temporary, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

test("a deployment can set the inference provider it boots with, and the stored choice still wins", async () => {
  const loaded = await loadStore();
  const previous = process.env.SAND_INFERENCE_PROVIDER;
  const settingsPath = path.join(loaded.dir, "settings.json");
  try {
    const store = new loaded.module.SandSettingsStore(settingsPath);

    delete process.env.SAND_INFERENCE_PROVIDER;
    assert.equal(store.getInferenceProvider(), "cursor", "no settings file and no env");

    process.env.SAND_INFERENCE_PROVIDER = "claude-code";
    assert.equal(store.getInferenceProvider(), "claude-code", "env supplies the boot default");

    process.env.SAND_INFERENCE_PROVIDER = "  codex  ";
    assert.equal(store.getInferenceProvider(), "codex", "surrounding whitespace is tolerated");

    process.env.SAND_INFERENCE_PROVIDER = "not-a-provider";
    assert.equal(store.getInferenceProvider(), "cursor", "an unknown env value falls back to Cursor");

    // A user who picked a provider in Settings keeps it, whatever the box boots with.
    process.env.SAND_INFERENCE_PROVIDER = "claude-code";
    await writeFile(settingsPath, JSON.stringify({ version: 1, inferenceProvider: "openrouter" }), "utf8");
    assert.equal(store.getInferenceProvider(), "openrouter");
  } finally {
    if (previous === undefined) delete process.env.SAND_INFERENCE_PROVIDER;
    else process.env.SAND_INFERENCE_PROVIDER = previous;
    await loaded.dispose();
  }
});

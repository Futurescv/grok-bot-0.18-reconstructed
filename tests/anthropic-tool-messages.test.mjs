import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await mkdir(path.join(repoRoot, ".build"), { recursive: true });

async function loadProviderSession() {
  // Inside the repo: the bundle keeps its dependencies external, so Node has to
  // resolve them from this project's node_modules.
  const temporary = await mkdtemp(path.join(repoRoot, ".build", "test-"));
  const outfile = path.join(temporary, "provider-session.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/host/extensions/inference/provider-session.ts")],
    outfile, bundle: true, format: "esm", platform: "node", target: "node22", packages: "external",
  });
  const module = await import(`${pathToFileURL(outfile).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

test("the agent loop's tool round-trip survives translation to Anthropic blocks", async () => {
  const loaded = await loadProviderSession();
  try {
    const { anthropicMessages } = loaded.module;
    // Exactly the shape the framework appends: an assistant turn carrying
    // tool-call parts, then a `tool` message carrying the results.
    const translated = anthropicMessages([
      { role: "user", content: "list the files" },
      { role: "assistant", content: [
        { type: "text", text: "Running it." },
        { type: "tool-call", toolCallId: "call-1", toolName: "ExternalShell", args: { command: "ls" } },
      ] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "call-1", toolName: "ExternalShell", result: { content: [{ type: "text", text: "Linux box 6.1" }] } }] },
    ]);
    assert.deepEqual(translated, [
      { role: "user", content: [{ type: "text", text: "list the files" }] },
      { role: "assistant", content: [
        { type: "text", text: "Running it." },
        { type: "tool_use", id: "call-1", name: "ExternalShell", input: { command: "ls" } },
      ] },
      // Anthropic requires tool results to arrive as a user turn, and the model
      // must read the tool's text — not the JSON envelope Grok Bot wraps it in.
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "Linux box 6.1" }] },
    ]);
  } finally {
    await loaded.dispose();
  }
});

test("tool schemas are unwrapped from the framework's jsonSchema() envelope", async () => {
  // Declaring the envelope leaves the model with no `properties` at all, so it
  // guesses argument names and every call fails the tool's own validation.
  const loaded = await loadProviderSession();
  try {
    const { anthropicTools, unwrapJsonSchema } = loaded.module;
    const schema = { type: "object", properties: { command: { type: "string" } }, required: ["command"] };
    assert.deepEqual(unwrapJsonSchema({ jsonSchema: schema, validate: () => true }), schema);
    assert.deepEqual(unwrapJsonSchema(schema), schema, "a plain JSON Schema passes through untouched");
    const tools = anthropicTools([
      { name: "Shell", description: "run", inputSchema: { jsonSchema: schema, validate: () => true } },
      { name: "Other", parameters: { jsonSchema: schema } },
    ]);
    assert.deepEqual(tools.map(tool => tool.inputSchema), [schema, schema]);
  } finally {
    await loaded.dispose();
  }
});

test("tool calls reach the framework as a JSON string, not an object", async () => {
  // The vendored agent framework does JSON.parse(part.args) and
  // safeParseJSON({text: toolCall.args}); an object there fails every call, and
  // the model retries the same call until the turn is killed.
  const source = await readFile(path.join(repoRoot, "source/host/extensions/inference/provider-session.ts"), "utf8");
  const streamPart = /if \(event\.type === "tool-call"\) \{ yield \{[^}]*\}/.exec(source)?.[0] ?? "";
  assert.match(streamPart, /toolCallType: "function"/);
  assert.match(streamPart, /args: event\.call\.argsJson/);
  assert.doesNotMatch(streamPart, /args: event\.call\.args\b/);
  const responsePart = /for \(const call of toolCalls\) content\.push\(\{[^}]*\}/.exec(source)?.[0] ?? "";
  assert.match(responsePart, /toolCallType: "function"/);
  assert.match(responsePart, /args: call\.argsJson/);
});

test("a tool's text is unwrapped from whatever envelope it arrives in", async () => {
  const loaded = await loadProviderSession();
  try {
    const { anthropicMessages } = loaded.module;
    const contentOf = (result) => anthropicMessages([{ role: "tool", content: [{ type: "tool-result", toolCallId: "c", result }] }])[0].content[0].content;
    assert.equal(contentOf("plain"), "plain");
    assert.equal(contentOf({ content: [{ type: "text", text: "one" }, { type: "text", text: "two" }] }), "one\ntwo");
    assert.equal(contentOf({ stdout: "from stdout" }), "from stdout");
    assert.equal(contentOf({ text: "from text" }), "from text");
    assert.equal(contentOf({ output: "from output" }), "from output");
    // Nothing recognisable: the whole value, so the model at least sees it.
    assert.equal(contentOf({ weird: 1 }), JSON.stringify({ weird: 1 }));
    assert.equal(contentOf(null), "null");
  } finally {
    await loaded.dispose();
  }
});

test("failed tools, plain strings and consecutive turns are all preserved", async () => {
  const loaded = await loadProviderSession();
  try {
    const { anthropicMessages } = loaded.module;
    assert.deepEqual(
      anthropicMessages([{ role: "tool", content: [{ type: "tool-result", toolCallId: "c1", result: "boom", isError: true }] }]),
      [{ role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "boom", is_error: true }] }],
      "an error result is marked, so the model can recover instead of looping",
    );
    // The Messages API rejects consecutive same-role turns; they are merged.
    assert.deepEqual(
      anthropicMessages([{ role: "user", content: "one" }, { role: "user", content: ["two"] }]),
      [{ role: "user", content: [{ type: "text", text: "one" }, { type: "text", text: "two" }] }],
    );
    // Empty and unknown parts drop out rather than producing invalid blocks.
    assert.deepEqual(anthropicMessages([{ role: "user", content: "" }]), []);
    assert.deepEqual(anthropicMessages([{ role: "assistant", content: [{ type: "image", image: "…" }] }]), []);
  } finally {
    await loaded.dispose();
  }
});

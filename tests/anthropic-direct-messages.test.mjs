import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { transform } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule() {
  const source = await readFile(path.join(repoRoot, "source/host/extensions/inference/anthropic-direct-messages.ts"), "utf8");
  const { code } = await transform(source, { format: "esm", loader: "ts", target: "es2022" });
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

function sse(events, split = 17) {
  const bytes = new TextEncoder().encode(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
  return new Response(new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += split) controller.enqueue(bytes.slice(offset, offset + split));
      controller.close();
    }
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

const textTurn = (chunks, usage) => [
  { type: "message_start", message: { id: "msg-1", usage: { input_tokens: usage.input, cache_read_input_tokens: usage.cacheRead ?? 0, cache_creation_input_tokens: usage.cacheWrite ?? 0 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  ...chunks.map(text => ({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })),
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: usage.output } },
  { type: "message_stop" },
];

test("direct Anthropic Messages transport streams text and totals usage", async () => {
  const { streamAnthropicDirectMessages, messagesUrl } = await loadModule();
  const requests = [];
  const urls = [];
  const fetch = async (url, init) => {
    urls.push(url);
    requests.push({ body: JSON.parse(init.body), headers: init.headers });
    return sse(textTurn(["DIRECT_", "OK"], { input: 11, output: 2, cacheRead: 3 }), 5);
  };
  const events = [];
  for await (const event of streamAnthropicDirectMessages({
    fetch, baseUrl: "https://example.invalid/api/anthropic/", apiKey: "secret-key", model: "glm-test", system: "Grok",
    messages: [{ role: "user", content: "hi" }],
  })) events.push(event);

  assert.deepEqual(events, [
    { type: "text-delta", delta: "DIRECT_" },
    { type: "text-delta", delta: "OK" },
    { type: "done", text: "DIRECT_OK", messageId: "msg-1", usage: { inputTokens: 11, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0 }, toolCalls: [] },
  ]);
  assert.equal(urls[0], "https://example.invalid/api/anthropic/v1/messages", "trailing slashes collapse into one /v1/messages");
  assert.equal(messagesUrl("https://example.invalid/api/anthropic"), "https://example.invalid/api/anthropic/v1/messages");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.stream, true);
  assert.equal(requests[0].body.max_tokens, 8_192);
  assert.equal(requests[0].body.system, "Grok");
  assert.equal(requests[0].body.tools, undefined, "no tool block when the caller declared none");
  // Both auth styles carry the same key: documented header plus what compatible gateways expect.
  assert.equal(requests[0].headers["x-api-key"], "secret-key");
  assert.equal(requests[0].headers.authorization, "Bearer secret-key");
  assert.equal(requests[0].headers["anthropic-version"], "2023-06-01");
});

test("direct Anthropic Messages transport executes tools and replays the exact tool_use id", async () => {
  const { streamAnthropicDirectMessages } = await loadModule();
  const requests = [];
  let toolExecution = null;
  const fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    if (requests.length === 1) return sse([
      { type: "message_start", message: { id: "msg-tool", usage: { input_tokens: 20, cache_read_input_tokens: 4 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Looking…" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu-123", name: "gmail_search", input: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"query\":" } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "\"newer_than:1d\"}" } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
      { type: "message_stop" },
    ]);
    return sse(textTurn(["Subject"], { input: 8, output: 1, cacheRead: 2 }));
  };
  const source = { providerIdentifier: "user-Gmail", toolName: "search_threads" };
  const events = [];
  for await (const event of streamAnthropicDirectMessages({
    fetch, baseUrl: "https://example.invalid", apiKey: "k", model: "glm-test", system: "Use connected tools",
    messages: [{ role: "user", content: "latest email" }],
    tools: [{ name: "gmail_search", description: "Search Gmail", inputSchema: { type: "object" }, source }],
    executeTool: async (tool, args, toolUseId) => {
      toolExecution = { tool, args, toolUseId };
      return { result: { case: "success", value: { subject: "Subject" } } };
    },
  })) events.push(event);

  assert.equal(requests.length, 2);
  assert.deepEqual(toolExecution, {
    tool: { name: "gmail_search", description: "Search Gmail", inputSchema: { type: "object" }, source },
    args: { query: "newer_than:1d" },
    toolUseId: "toolu-123",
  });
  assert.deepEqual(requests[0].tools, [{ name: "gmail_search", description: "Search Gmail", input_schema: { type: "object" } }]);
  // The assistant turn is echoed back (text then tool_use) and the result quotes the id.
  assert.deepEqual(requests[1].messages.at(-2), {
    role: "assistant",
    content: [{ type: "text", text: "Looking…" }, { type: "tool_use", id: "toolu-123", name: "gmail_search", input: { query: "newer_than:1d" } }],
  });
  assert.deepEqual(requests[1].messages.at(-1), {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "toolu-123", content: JSON.stringify({ result: { case: "success", value: { subject: "Subject" } } }) }],
  });
  assert.deepEqual(events.at(-1), { type: "done", text: "Looking…Subject", messageId: "msg-1", usage: { inputTokens: 28, outputTokens: 6, cacheReadTokens: 6, cacheWriteTokens: 0 }, toolCalls: [] });
});

test("with no executor the tool call is handed back for the caller to run", async () => {
  // This is the in-box agent loop's path: it owns the tools (shell, files,
  // computer use), executes the call itself, and starts a fresh turn with the
  // result appended. Refusing here would leave the agent unable to act.
  const { streamAnthropicDirectMessages } = await loadModule();
  const events = [];
  for await (const event of streamAnthropicDirectMessages({
    fetch: async () => sse([
      { type: "message_start", message: { id: "m", usage: { input_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "checking" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu-1", name: "ExternalShell", input: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"command\":\"ls\"}" } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ]),
    baseUrl: "https://example.invalid", apiKey: "k", model: "glm-test", system: "s",
    messages: [{ role: "user", content: "list the files" }],
    tools: [{ name: "ExternalShell", inputSchema: { type: "object" }, source: {} }],
  })) events.push(event);

  // The raw JSON is kept verbatim beside the parsed args: the agent framework's
  // tool protocol carries arguments as a string and parses them itself.
  const call = { toolCallId: "toolu-1", toolName: "ExternalShell", args: { command: "ls" }, argsJson: "{\"command\":\"ls\"}" };
  assert.deepEqual(events, [
    { type: "text-delta", delta: "checking" },
    { type: "tool-call", call },
    { type: "done", text: "checking", messageId: "m", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, toolCalls: [call] },
  ]);
});

test("a tool call with no arguments still hands back valid JSON", async () => {
  const { toolInputJson } = await loadModule();
  assert.equal(toolInputJson(""), "{}");
  assert.equal(toolInputJson("  "), "{}");
  assert.equal(toolInputJson(" {\"a\":1} "), "{\"a\":1}");
});

test("arguments survive both wire styles: streamed deltas and a complete object", async () => {
  // A gateway that puts the finished argument object in content_block_start used
  // to lose it entirely, and the tool then failed its own schema on every retry.
  const { streamAnthropicDirectMessages } = await loadModule();
  const callsFor = async (contentBlock, deltas) => {
    const events = [];
    for await (const event of streamAnthropicDirectMessages({
      fetch: async () => sse([
        { type: "message_start", message: { id: "m", usage: { input_tokens: 1 } } },
        { type: "content_block_start", index: 0, content_block: contentBlock },
        ...deltas.map(partial_json => ({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json } })),
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ]),
      baseUrl: "https://example.invalid", apiKey: "k", model: "glm-test", system: "s",
      messages: [{ role: "user", content: "go" }],
      tools: [{ name: "Shell", inputSchema: { type: "object" }, source: {} }],
    })) events.push(event);
    return events.at(-1).toolCalls;
  };
  const shell = { type: "tool_use", id: "t1", name: "Shell" };
  const expected = [{ toolCallId: "t1", toolName: "Shell", args: { command: "uname -a" }, argsJson: "{\"command\":\"uname -a\"}" }];
  // Anthropic's own style: empty input, arguments streamed as text.
  assert.deepEqual(await callsFor({ ...shell, input: {} }, ["{\"command\":", "\"uname -a\"}"]), expected);
  // A complete object up front, no deltas at all.
  assert.deepEqual(await callsFor({ ...shell, input: { command: "uname -a" } }, []), expected);
  // Both present: the streamed text is the authoritative one.
  assert.deepEqual(await callsFor({ ...shell, input: { command: "stale" } }, ["{\"command\":\"uname -a\"}"]), expected);
  // Neither: still valid JSON so the tool reports its own schema error.
  assert.deepEqual(await callsFor({ ...shell, input: {} }, []), [{ toolCallId: "t1", toolName: "Shell", args: {}, argsJson: "{}" }]);
});

test("direct Anthropic Messages transport fails closed on truncated and unterminated streams", async () => {
  const { streamAnthropicDirectMessages } = await loadModule();
  const run = async (response) => {
    for await (const _event of streamAnthropicDirectMessages({
      fetch: async () => response,
      baseUrl: "https://example.invalid", apiKey: "k", model: "glm-test", system: "s",
      messages: [{ role: "user", content: "hi" }],
    })) {}
  };
  // Half an SSE event on the wire.
  await assert.rejects(() => run(new Response("data: {\"type\":\"content_block_delta\"", { status: 200 })), /incomplete SSE event/);
  // Well-formed events that stop before message_stop: the answer is partial.
  await assert.rejects(() => run(sse([
    { type: "message_start", message: { id: "m", usage: { input_tokens: 1 } } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "half" } },
  ])), /without message_stop/);
  // A refused request surfaces the upstream status and body.
  await assert.rejects(() => run(new Response("{\"error\":{\"message\":\"no quota\"}}", { status: 429 })), /failed \(429: .*no quota/);
});

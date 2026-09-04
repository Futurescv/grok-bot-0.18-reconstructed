type Loose = Record<string, any>;

export type AnthropicDirectUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
};

export type AnthropicDirectTool = {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: unknown;
  readonly source: Loose;
};

/**
 * `argsJson` is the model's raw argument JSON, kept verbatim because the agent
 * framework's tool protocol carries arguments as a JSON *string* and parses them
 * itself; handing it an already-parsed object makes every call fail validation.
 * `args` is the same value parsed, for callers that execute tools directly.
 */
export type AnthropicDirectToolCall = { readonly toolCallId: string; readonly toolName: string; readonly args: unknown; readonly argsJson: string };

export type AnthropicDirectEvent =
  | { readonly type: "text-delta"; readonly delta: string }
  | { readonly type: "tool-call"; readonly call: AnthropicDirectToolCall }
  | { readonly type: "done"; readonly text: string; readonly messageId: string; readonly usage: AnthropicDirectUsage; readonly toolCalls: readonly AnthropicDirectToolCall[] };

export type AnthropicDirectOptions = {
  readonly fetch: typeof fetch;
  /** Base URL of the Anthropic-compatible surface; `/v1/messages` is appended. */
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly maxTokens?: number;
  readonly system: string;
  readonly messages: readonly Loose[];
  readonly tools?: readonly AnthropicDirectTool[];
  readonly executeTool?: (tool: AnthropicDirectTool, args: unknown, toolUseId: string) => Promise<unknown>;
  readonly maxSteps?: number;
  /**
   * A hung inference request must fail rather than stall the turn forever: a
   * request carrying the whole agent toolset is large, and a compatible gateway
   * that dislikes it can simply stop responding.
   */
  readonly requestTimeoutMs?: number;
  readonly log?: (line: string) => void;
};

export const ANTHROPIC_VERSION = "2023-06-01";
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 8_192;
export const ANTHROPIC_DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

function record(value: unknown): Loose | null {
  return typeof value === "object" && value != null && !Array.isArray(value) ? value as Loose : null;
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item) ?? "null"; }
  catch (error) { return JSON.stringify({ isError: true, error: error instanceof Error ? error.message : String(error) }); }
}

function integer(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function messagesUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/v1/messages`;
}

async function responseError(response: Response): Promise<Error> {
  let detail = "";
  try { detail = (await response.text()).slice(0, 4_096).trim(); } catch {}
  return new Error(`Anthropic direct request failed (${response.status}${detail.length === 0 ? "" : `: ${detail}`}).`);
}

async function* sseEvents(response: Response): AsyncGenerator<Loose> {
  if (response.body == null) throw new Error("Anthropic direct response did not include a stream.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, boundary).replaceAll("\r", "");
      buffer = buffer.slice(boundary + 2);
      const data = block.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
      if (data.length === 0 || data === "[DONE]") continue;
      let parsed: unknown;
      try { parsed = JSON.parse(data); }
      catch { throw new Error("Anthropic direct response contained malformed SSE JSON."); }
      const event = record(parsed);
      if (event != null) yield event;
    }
    if (done) break;
  }
  // A stream that stops mid-event is a truncated answer, not a short one.
  if (buffer.trim().length > 0 && buffer.trim() !== "data: [DONE]") throw new Error("Anthropic direct response ended with an incomplete SSE event.");
}

function requestTools(tools: readonly AnthropicDirectTool[] | undefined): Loose[] | undefined {
  if (tools == null || tools.length === 0) return undefined;
  return tools.map(tool => ({
    name: tool.name,
    ...(tool.description == null ? {} : { description: tool.description }),
    input_schema: tool.inputSchema,
  }));
}

function addUsage(total: AnthropicDirectUsage, next: AnthropicDirectUsage): AnthropicDirectUsage {
  return {
    inputTokens: total.inputTokens + next.inputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
    cacheReadTokens: total.cacheReadTokens + next.cacheReadTokens,
    cacheWriteTokens: total.cacheWriteTokens + next.cacheWriteTokens,
  };
}

/**
 * Compatible gateways disagree on how a tool call arrives: Anthropic opens the
 * block with an empty `input` and streams the arguments as `input_json_delta`
 * text, while others put the finished argument object straight into
 * `content_block_start`. Keep both and prefer the streamed text, so neither wire
 * style loses the arguments — a tool invoked with `{}` fails its own schema and
 * the model retries the identical call until the turn is killed.
 */
type ToolUseBlock = { id: string; name: string; json: string; seed: string };

function seedInput(input: unknown): string {
  if (typeof input === "string") return input.trim();
  const asRecord = record(input);
  if (asRecord != null && Object.keys(asRecord).length > 0) return safeJson(asRecord);
  return "";
}

function toolUseArgsJson(block: ToolUseBlock): string {
  return block.json.trim().length > 0 ? block.json : block.seed;
}

/**
 * Streams one Anthropic Messages turn, executing tool calls and continuing until
 * the model stops asking for them.
 *
 * Both `x-api-key` and `authorization: Bearer` carry the same user-supplied key:
 * Anthropic documents the former, while Anthropic-compatible gateways in the
 * wild accept only the latter (verified against two of them), and each surface
 * ignores the header it does not use.
 */
export async function* streamAnthropicDirectMessages(options: AnthropicDirectOptions): AsyncGenerator<AnthropicDirectEvent> {
  const maxSteps = options.maxSteps ?? 8;
  const toolsByName = new Map((options.tools ?? []).map(tool => [tool.name, tool]));
  const url = messagesUrl(options.baseUrl);
  let messages: Loose[] = options.messages.map(message => ({ ...message }));
  let text = "";
  let messageId = "";
  let usage: AnthropicDirectUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

  for (let step = 0; step < maxSteps; step += 1) {
    const declaredTools = requestTools(options.tools);
    if (step === 0 && declaredTools != null) {
      // A declared tool with no `properties` tells the model nothing about its
      // arguments, so it guesses and the call fails validation every time. The
      // model cannot report this, so say it here.
      const blind = declaredTools.filter(tool => {
        const schema = record(tool.input_schema);
        return schema == null || record(schema.properties) == null;
      }).map(tool => tool.name);
      if (blind.length > 0) options.log?.(`WARNING ${blind.length}/${declaredTools.length} tools declared without argument properties: ${blind.slice(0, 8).join(", ")}`);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.requestTimeoutMs ?? ANTHROPIC_DEFAULT_REQUEST_TIMEOUT_MS);
    if (typeof timeout.unref === "function") timeout.unref();
    const body = JSON.stringify({
      model: options.model,
      max_tokens: options.maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
      system: options.system,
      messages,
      ...(declaredTools == null ? {} : { tools: declaredTools, tool_choice: { type: "auto" } }),
      // Thinking off on purpose. With it on, the API requires every assistant
      // turn's thinking blocks to be replayed verbatim when the conversation
      // continues after a tool_use — and the agent framework rebuilds that turn
      // from tool-call parts alone, so they cannot be. The model then loses its
      // reasoning state and repeats the same call forever.
      thinking: { type: "disabled" },
      stream: true,
    });
    options.log?.(`step ${step + 1}/${maxSteps}: ${messages.length} messages, ${declaredTools?.length ?? 0} tools, ${body.length} request bytes`);
    let response: Response;
    try {
      response = await options.fetch(url, {
        method: "POST",
        signal: controller.signal,
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        "anthropic-version": ANTHROPIC_VERSION,
        "x-api-key": options.apiKey,
        authorization: `Bearer ${options.apiKey}`,
        "user-agent": "grok-bot-router/1",
      },
      body,
      });
    } catch (error) {
      clearTimeout(timeout);
      if (controller.signal.aborted) throw new Error(`Anthropic direct request timed out after ${Math.round((options.requestTimeoutMs ?? ANTHROPIC_DEFAULT_REQUEST_TIMEOUT_MS) / 1000)}s (${body.length} request bytes, ${declaredTools?.length ?? 0} tools).`);
      throw error;
    }
    clearTimeout(timeout);
    if (!response.ok) throw await responseError(response);

    const toolUses = new Map<number, ToolUseBlock>();
    const stepText: string[] = [];
    let stopReason = "";
    let sawMessageStop = false;
    for await (const event of sseEvents(response)) {
      if (event.type === "message_start") {
        const message = record(event.message);
        if (typeof message?.id === "string") messageId = message.id;
        const started = record(message?.usage);
        if (started != null) {
          usage = addUsage(usage, {
            inputTokens: integer(started.input_tokens),
            outputTokens: integer(started.output_tokens),
            cacheReadTokens: integer(started.cache_read_input_tokens),
            cacheWriteTokens: integer(started.cache_creation_input_tokens),
          });
        }
        continue;
      }
      if (event.type === "content_block_start") {
        const block = record(event.content_block);
        if (block?.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
          toolUses.set(integer(event.index), { id: block.id, name: block.name, json: "", seed: seedInput(block.input) });
        }
        continue;
      }
      if (event.type === "content_block_delta") {
        const delta = record(event.delta);
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          text += delta.text;
          stepText.push(delta.text);
          yield { type: "text-delta", delta: delta.text };
          continue;
        }
        if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
          const pending = toolUses.get(integer(event.index));
          if (pending != null) pending.json += delta.partial_json;
        }
        continue;
      }
      if (event.type === "message_delta") {
        const delta = record(event.delta);
        if (typeof delta?.stop_reason === "string") stopReason = delta.stop_reason;
        const spent = record(event.usage);
        if (spent != null) {
          usage = addUsage(usage, {
            inputTokens: integer(spent.input_tokens),
            outputTokens: integer(spent.output_tokens),
            cacheReadTokens: integer(spent.cache_read_input_tokens),
            cacheWriteTokens: integer(spent.cache_creation_input_tokens),
          });
        }
        continue;
      }
      if (event.type === "message_stop") { sawMessageStop = true; continue; }
      if (event.type === "error") throw new Error(`Anthropic direct response failed: ${safeJson(event.error ?? event).slice(0, 4_096)}`);
    }
    if (!sawMessageStop) throw new Error("Anthropic direct response ended without message_stop.");
    options.log?.(`step ${step + 1}: stop_reason=${stopReason || "(none)"} text=${stepText.join("").length}b toolCalls=${toolUses.size}`);

    const calls = [...toolUses.entries()].sort((left, right) => left[0] - right[0]).map(entry => entry[1]);
    if (calls.length === 0) {
      yield { type: "done", text, messageId, usage, toolCalls: [] };
      return;
    }
    if (options.executeTool == null) {
      // No executor means the caller drives the tools itself (the in-box agent
      // loop does: it executes each call and streams a fresh turn with the
      // results appended). Report the calls and end this turn.
      const handOff = calls.map(call => ({ toolCallId: call.id, toolName: call.name, args: parseToolInputSafely(toolUseArgsJson(call)), argsJson: toolInputJson(toolUseArgsJson(call)) }));
      options.log?.(`handing off ${handOff.length} tool call(s): ${handOff.map(call => call.toolName).join(", ")}`);
      for (const call of handOff) yield { type: "tool-call", call };
      yield { type: "done", text, messageId, usage, toolCalls: handOff };
      return;
    }

    // Echo the assistant turn back verbatim (text first, then the tool_use
    // blocks) so the tool_result ids the model sees line up with what it sent.
    const assistantContent: Loose[] = [];
    const spoken = stepText.join("");
    if (spoken.length > 0) assistantContent.push({ type: "text", text: spoken });
    for (const call of calls) assistantContent.push({ type: "tool_use", id: call.id, name: call.name, input: parseToolInput(toolUseArgsJson(call)) });

    const results: Loose[] = [];
    for (const call of calls) {
      const selected = toolsByName.get(call.name);
      if (selected == null) {
        results.push({ type: "tool_result", tool_use_id: call.id, is_error: true, content: safeJson({ isError: true, error: `Unknown Grok Bot tool: ${call.name}` }) });
        continue;
      }
      let args: unknown;
      try { args = parseToolInput(toolUseArgsJson(call)); }
      catch { results.push({ type: "tool_result", tool_use_id: call.id, is_error: true, content: safeJson({ isError: true, error: "Tool arguments were not valid JSON." }) }); continue; }
      try { results.push({ type: "tool_result", tool_use_id: call.id, content: safeJson(await options.executeTool(selected, args, call.id)) }); }
      catch (error) { results.push({ type: "tool_result", tool_use_id: call.id, is_error: true, content: safeJson({ isError: true, error: error instanceof Error ? error.message : String(error) }) }); }
    }
    messages = [...messages, { role: "assistant", content: assistantContent }, { role: "user", content: results }];
    if (stopReason.length > 0 && stopReason !== "tool_use") {
      // The model both answered and called a tool; keep looping so the tool
      // result is delivered, but do not treat the answer as final yet.
      continue;
    }
  }
  throw new Error(`Anthropic exceeded Grok Bot's ${maxSteps}-step tool limit.`);
}

/** The raw arguments, normalised so an empty tool call is still valid JSON. */
export function toolInputJson(json: string): string {
  const trimmed = json.trim();
  return trimmed.length === 0 ? "{}" : trimmed;
}

export function parseToolInputSafely(json: string): unknown {
  try { return parseToolInput(json); } catch { return {}; }
}

function parseToolInput(json: string): unknown {
  const trimmed = json.trim();
  if (trimmed.length === 0) return {};
  return JSON.parse(trimmed);
}

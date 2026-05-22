import type { ContentBlock, MessagesRequest } from "./types";

/**
 * Translation between the Anthropic Messages API and the OpenAI Chat
 * Completions API, so OpenAI-format providers (Ollama, OpenRouter, ...) can be
 * used transparently by Claude Code.
 */

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

function textFromBlocks(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
}

function systemText(system: MessagesRequest["system"]): string {
  if (!system) return "";
  return textFromBlocks(system);
}

function toolResultText(block: ContentBlock): string {
  const content = block.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((part) => (typeof part === "string" ? part : ((part as ContentBlock).text ?? "")))
      .join("\n");
  return "";
}

export function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

function mapStopReason(finish: string | null | undefined): string {
  switch (finish) {
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    default:
      return "end_turn";
  }
}

function mapToolChoice(choice: { type?: string; name?: string }): unknown {
  if (choice.type === "tool" && choice.name)
    return { type: "function", function: { name: choice.name } };
  if (choice.type === "any") return "required";
  if (choice.type === "none") return "none";
  return "auto";
}

/** Rough token estimate for the request, used to seed message_start usage. */
export function estimateTokens(req: MessagesRequest): number {
  const text = JSON.stringify({ system: req.system ?? "", messages: req.messages ?? [] });
  return Math.ceil(text.length / 4);
}

export function anthropicToOpenAI(req: MessagesRequest, model: string): Record<string, unknown> {
  const messages: OpenAIMessage[] = [];

  const system = systemText(req.system);
  if (system) messages.push({ role: "system", content: system });

  for (const message of req.messages ?? []) {
    if (typeof message.content === "string") {
      messages.push({ role: message.role, content: message.content });
      continue;
    }

    if (message.role === "assistant") {
      const toolCalls: OpenAIToolCall[] = [];
      for (const block of message.content) {
        if (block.type === "tool_use") {
          toolCalls.push({
            id: String(block.id ?? ""),
            type: "function",
            function: {
              name: String(block.name ?? ""),
              arguments: JSON.stringify(block.input ?? {}),
            },
          });
        }
      }
      const text = textFromBlocks(message.content);
      const openaiMessage: OpenAIMessage = { role: "assistant", content: text || null };
      if (toolCalls.length) openaiMessage.tool_calls = toolCalls;
      messages.push(openaiMessage);
      continue;
    }

    // user message: emit tool results first (OpenAI requires them right after
    // the assistant tool_calls), then any plain text.
    for (const block of message.content) {
      if (block.type === "tool_result") {
        messages.push({
          role: "tool",
          tool_call_id: String(block.tool_use_id ?? ""),
          content: toolResultText(block),
        });
      }
    }
    const text = textFromBlocks(message.content);
    if (text) messages.push({ role: "user", content: text });
  }

  const out: Record<string, unknown> = { model, messages, stream: req.stream === true };
  if (typeof req.max_tokens === "number") out.max_tokens = req.max_tokens;
  if (req.stream === true) out.stream_options = { include_usage: true };

  if (Array.isArray(req.tools) && req.tools.length) {
    out.tools = req.tools
      .filter((tool) => typeof tool.name === "string")
      .map((tool) => {
        const raw = tool as Record<string, unknown>;
        return {
          type: "function",
          function: {
            name: tool.name,
            description: raw.description ?? "",
            parameters: raw.input_schema ?? { type: "object" },
          },
        };
      });
    const toolChoice = (req as Record<string, unknown>).tool_choice as
      | { type?: string; name?: string }
      | undefined;
    if (toolChoice) out.tool_choice = mapToolChoice(toolChoice);
  }
  return out;
}

interface OpenAIResponse {
  id?: string;
  choices?: {
    message?: { content?: string | null; tool_calls?: OpenAIToolCall[] };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export function openaiResponseToAnthropic(
  data: OpenAIResponse,
  model: string,
): Record<string, unknown> {
  const choice = data.choices?.[0];
  const message = choice?.message;
  const content: Record<string, unknown>[] = [];

  if (message?.content) content.push({ type: "text", text: message.content });
  for (const call of message?.tool_calls ?? []) {
    content.push({
      type: "tool_use",
      id: call.id,
      name: call.function.name,
      input: safeParse(call.function.arguments),
    });
  }

  return {
    id: data.id ?? `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: mapStopReason(choice?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: data.usage?.prompt_tokens ?? 0,
      output_tokens: data.usage?.completion_tokens ?? 0,
    },
  };
}

type OpenAIChunk = Record<string, any>;

/**
 * Translates an OpenAI Chat Completions SSE stream into an Anthropic Messages
 * SSE stream. Drives a small state machine: text becomes a text content block,
 * each tool call becomes a tool_use block with input_json_delta deltas.
 */
export function openaiStreamToAnthropic(
  upstream: ReadableStream<Uint8Array>,
  model: string,
  estimatedInputTokens: number,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      send("message_start", {
        type: "message_start",
        message: {
          id: `msg_${Date.now()}`,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: estimatedInputTokens, output_tokens: 0 },
        },
      });

      let nextIndex = 0;
      let textIndex: number | null = null;
      let textOpen = false;
      const toolBlocks = new Map<number, number>();
      let finishReason: string | null = null;
      let inputTokens = estimatedInputTokens;
      let outputTokens = 0;

      const openText = () => {
        if (textOpen) return;
        textIndex = nextIndex++;
        textOpen = true;
        send("content_block_start", {
          type: "content_block_start",
          index: textIndex,
          content_block: { type: "text", text: "" },
        });
      };
      const closeText = () => {
        if (!textOpen || textIndex === null) return;
        send("content_block_stop", { type: "content_block_stop", index: textIndex });
        textOpen = false;
      };
      const finish = () => {
        closeText();
        for (const blockIndex of toolBlocks.values())
          send("content_block_stop", { type: "content_block_stop", index: blockIndex });
        send("message_delta", {
          type: "message_delta",
          delta: { stop_reason: mapStopReason(finishReason), stop_sequence: null },
          usage: { input_tokens: inputTokens, output_tokens: outputTokens },
        });
        send("message_stop", { type: "message_stop" });
      };

      const reader = upstream.getReader();
      let buffer = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const payload = trimmed.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;

            let chunk: OpenAIChunk;
            try {
              chunk = JSON.parse(payload);
            } catch {
              continue;
            }

            if (chunk.usage) {
              inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
              outputTokens = chunk.usage.completion_tokens ?? outputTokens;
            }

            const choice = chunk.choices?.[0];
            if (!choice) continue;
            const delta = choice.delta ?? {};

            if (typeof delta.content === "string" && delta.content.length) {
              openText();
              send("content_block_delta", {
                type: "content_block_delta",
                index: textIndex,
                delta: { type: "text_delta", text: delta.content },
              });
            }

            for (const toolCall of delta.tool_calls ?? []) {
              const openaiIndex: number = toolCall.index ?? 0;
              let blockIndex = toolBlocks.get(openaiIndex);
              if (blockIndex === undefined) {
                closeText();
                blockIndex = nextIndex++;
                toolBlocks.set(openaiIndex, blockIndex);
                send("content_block_start", {
                  type: "content_block_start",
                  index: blockIndex,
                  content_block: {
                    type: "tool_use",
                    id: toolCall.id ?? `call_${openaiIndex}`,
                    name: toolCall.function?.name ?? "",
                    input: {},
                  },
                });
              }
              const args = toolCall.function?.arguments;
              if (typeof args === "string" && args.length) {
                send("content_block_delta", {
                  type: "content_block_delta",
                  index: blockIndex,
                  delta: { type: "input_json_delta", partial_json: args },
                });
              }
            }

            if (choice.finish_reason) finishReason = choice.finish_reason;
          }
        }
        finish();
      } catch {
        finish();
      } finally {
        controller.close();
      }
    },
  });
}

/* ── Inbound: OpenAI Chat Completions clients -> Anthropic and back ────────
 * Mirror of the functions above, for OpenAI-format clients (e.g. the Codex
 * CLI) that point at the router's POST /v1/chat/completions endpoint.
 */

interface OpenAIChatRequest {
  model?: string;
  messages?: Record<string, unknown>[];
  tools?: Record<string, any>[];
  max_tokens?: number;
  max_completion_tokens?: number;
  stream?: boolean;
}

const DEFAULT_MAX_TOKENS = 4096;

function mapStopReasonToOpenAI(stop: string | null | undefined): string {
  switch (stop) {
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    default:
      return "stop";
  }
}

/** Flattens OpenAI message content (string or content-part array) to text. */
function openaiContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        const text = (part as Record<string, unknown> | null)?.text;
        return typeof text === "string" ? text : "";
      })
      .join("");
  return "";
}

/** Translates an OpenAI Chat Completions request into an Anthropic request. */
export function openaiRequestToAnthropic(raw: unknown): MessagesRequest {
  const body = (raw ?? {}) as OpenAIChatRequest;
  const systemParts: string[] = [];
  const messages: { role: "user" | "assistant"; content: ContentBlock[] }[] = [];

  const pushBlock = (role: "user" | "assistant", block: ContentBlock) => {
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content.push(block);
    else messages.push({ role, content: [block] });
  };

  for (const message of body.messages ?? []) {
    const role = message.role;
    const content = message.content;

    if (role === "system" || role === "developer") {
      const text = openaiContentToText(content);
      if (text) systemParts.push(text);
    } else if (role === "tool") {
      pushBlock("user", {
        type: "tool_result",
        tool_use_id: String(message.tool_call_id ?? ""),
        content: openaiContentToText(content),
      });
    } else if (role === "assistant") {
      const text = openaiContentToText(content);
      if (text) pushBlock("assistant", { type: "text", text });
      const calls = (message.tool_calls as Record<string, any>[] | undefined) ?? [];
      for (const call of calls) {
        pushBlock("assistant", {
          type: "tool_use",
          id: String(call.id ?? ""),
          name: String(call.function?.name ?? ""),
          input: safeParse(call.function?.arguments ?? "{}"),
        });
      }
    } else {
      const text = openaiContentToText(content);
      if (text) pushBlock("user", { type: "text", text });
    }
  }

  const out: MessagesRequest = {
    model: String(body.model ?? "route-sonnet"),
    messages,
    stream: body.stream === true,
    max_tokens: body.max_tokens ?? body.max_completion_tokens ?? DEFAULT_MAX_TOKENS,
  };
  if (systemParts.length) out.system = systemParts.join("\n\n");

  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools
      .filter((tool) => typeof tool.function?.name === "string")
      .map((tool) => ({
        name: tool.function.name as string,
        description: tool.function.description ?? "",
        input_schema: tool.function.parameters ?? { type: "object" },
      }));
  }
  return out;
}

/** Translates a non-streaming Anthropic response into an OpenAI response. */
export function anthropicResponseToOpenAI(
  data: Record<string, unknown>,
  model: string,
): Record<string, unknown> {
  const blocks = (data.content as ContentBlock[] | undefined) ?? [];
  const usage =
    (data.usage as { input_tokens?: number; output_tokens?: number } | undefined) ?? {};

  let text = "";
  const toolCalls: OpenAIToolCall[] = [];
  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string") {
      text += block.text;
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: String(block.id ?? ""),
        type: "function",
        function: {
          name: String(block.name ?? ""),
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
    }
  }

  const message: Record<string, unknown> = { role: "assistant", content: text || null };
  if (toolCalls.length) message.tool_calls = toolCalls;

  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;

  return {
    id: String(data.id ?? `chatcmpl-${Date.now()}`),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: mapStopReasonToOpenAI(data.stop_reason as string | null | undefined),
      },
    ],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };
}

/**
 * Translates an Anthropic Messages SSE stream into an OpenAI Chat Completions
 * SSE stream. Inverse of openaiStreamToAnthropic(): Anthropic content blocks
 * become OpenAI text/tool_call deltas; ends with a usage chunk and [DONE].
 */
export function anthropicStreamToOpenAI(
  upstream: ReadableStream<Uint8Array>,
  model: string,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const id = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (payload: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };
      const sendChoice = (delta: Record<string, unknown>, finishReason: string | null) => {
        emit({
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        });
      };

      const blockKind = new Map<number, "text" | "tool" | "ignore">();
      const toolIndexOf = new Map<number, number>();
      let nextToolIndex = 0;
      let roleSent = false;
      let stopReason: string | null = null;
      let inputTokens = 0;
      let outputTokens = 0;
      let finished = false;

      const ensureRole = () => {
        if (roleSent) return;
        sendChoice({ role: "assistant" }, null);
        roleSent = true;
      };
      const finish = () => {
        if (finished) return;
        finished = true;
        ensureRole();
        sendChoice({}, mapStopReasonToOpenAI(stopReason));
        emit({
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [],
          usage: {
            prompt_tokens: inputTokens,
            completion_tokens: outputTokens,
            total_tokens: inputTokens + outputTokens,
          },
        });
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      };

      const reader = upstream.getReader();
      let buffer = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const payload = trimmed.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;

            let ev: Record<string, any>;
            try {
              ev = JSON.parse(payload);
            } catch {
              continue;
            }

            if (ev.type === "message_start") {
              inputTokens = ev.message?.usage?.input_tokens ?? 0;
              ensureRole();
            } else if (ev.type === "content_block_start") {
              const index: number = ev.index ?? 0;
              const cb = ev.content_block ?? {};
              if (cb.type === "text") {
                blockKind.set(index, "text");
              } else if (cb.type === "tool_use") {
                blockKind.set(index, "tool");
                const toolIndex = nextToolIndex++;
                toolIndexOf.set(index, toolIndex);
                ensureRole();
                sendChoice(
                  {
                    tool_calls: [
                      {
                        index: toolIndex,
                        id: cb.id ?? `call_${toolIndex}`,
                        type: "function",
                        function: { name: cb.name ?? "", arguments: "" },
                      },
                    ],
                  },
                  null,
                );
              } else {
                blockKind.set(index, "ignore");
              }
            } else if (ev.type === "content_block_delta") {
              const index: number = ev.index ?? 0;
              const kind = blockKind.get(index);
              const delta = ev.delta ?? {};
              if (kind === "text" && delta.type === "text_delta" && typeof delta.text === "string") {
                ensureRole();
                sendChoice({ content: delta.text }, null);
              } else if (
                kind === "tool" &&
                delta.type === "input_json_delta" &&
                typeof delta.partial_json === "string"
              ) {
                sendChoice(
                  {
                    tool_calls: [
                      {
                        index: toolIndexOf.get(index) ?? 0,
                        function: { arguments: delta.partial_json },
                      },
                    ],
                  },
                  null,
                );
              }
            } else if (ev.type === "message_delta") {
              if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
              if (typeof ev.usage?.output_tokens === "number") outputTokens = ev.usage.output_tokens;
              if (typeof ev.usage?.input_tokens === "number") inputTokens = ev.usage.input_tokens;
            } else if (ev.type === "message_stop") {
              finish();
            }
          }
        }
        finish();
      } catch {
        finish();
      } finally {
        controller.close();
      }
    },
  });
}

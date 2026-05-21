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

function safeParse(raw: string): unknown {
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

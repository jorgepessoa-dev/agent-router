import assert from "node:assert/strict";
import { test } from "node:test";
import {
  anthropicResponseToOpenAI,
  anthropicStreamToOpenAI,
  anthropicToOpenAI,
  openaiRequestToAnthropic,
  openaiResponseToAnthropic,
  openaiStreamToAnthropic,
} from "../src/translate";
import type { MessagesRequest } from "../src/types";

test("anthropicToOpenAI maps system, messages, tool use and tool results", () => {
  const req: MessagesRequest = {
    model: "x",
    system: "be helpful",
    messages: [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "calling tool" },
          { type: "tool_use", id: "t1", name: "Read", input: { path: "a.ts" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "file contents" }],
      },
    ],
    tools: [{ name: "Read", description: "read a file", input_schema: { type: "object" } }],
    stream: true,
  };

  const out = anthropicToOpenAI(req, "gpt-x") as Record<string, any>;
  assert.equal(out.model, "gpt-x");
  assert.equal(out.messages[0].role, "system");
  assert.equal(out.messages[1].role, "user");
  assert.equal(out.messages[2].role, "assistant");
  assert.equal(out.messages[2].tool_calls[0].function.name, "Read");
  assert.equal(out.messages[3].role, "tool");
  assert.equal(out.messages[3].tool_call_id, "t1");
  assert.equal(out.messages[3].content, "file contents");
  assert.equal(out.tools[0].type, "function");
  assert.equal(out.tools[0].function.name, "Read");
  assert.deepEqual(out.stream_options, { include_usage: true });
});

test("openaiResponseToAnthropic maps content, tool calls and usage", () => {
  const result = openaiResponseToAnthropic(
    {
      id: "c1",
      choices: [
        {
          message: {
            content: "done",
            tool_calls: [
              { id: "t1", type: "function", function: { name: "Read", arguments: '{"path":"a"}' } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 4 },
    },
    "m",
  ) as Record<string, any>;

  assert.equal(result.type, "message");
  assert.equal(result.content[0].type, "text");
  assert.equal(result.content[1].type, "tool_use");
  assert.deepEqual(result.content[1].input, { path: "a" });
  assert.equal(result.stop_reason, "tool_use");
  assert.equal(result.usage.input_tokens, 10);
  assert.equal(result.usage.output_tokens, 4);
});

test("openaiStreamToAnthropic emits a valid Anthropic event sequence", async () => {
  const chunks =
    [
      'data: {"choices":[{"delta":{"role":"assistant","content":""},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{"content":"Hel"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":2}}',
      "data: [DONE]",
    ].join("\n\n") + "\n\n";

  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(chunks));
      controller.close();
    },
  });

  const out = openaiStreamToAnthropic(source, "m", 5);
  const reader = out.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }

  assert.ok(text.includes("event: message_start"));
  assert.ok(text.includes("event: content_block_start"));
  assert.ok(text.includes('"text":"Hel"'));
  assert.ok(text.includes('"text":"lo"'));
  assert.ok(text.includes("event: content_block_stop"));
  assert.ok(text.includes("event: message_delta"));
  assert.ok(text.includes('"output_tokens":2'));
  assert.ok(text.includes("event: message_stop"));
});

test("openaiStreamToAnthropic streams tool calls as input_json_delta", async () => {
  const chunks =
    [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"Read","arguments":""}}]},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":"}}]},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.ts\\"}"}}]},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      "data: [DONE]",
    ].join("\n\n") + "\n\n";

  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(chunks));
      controller.close();
    },
  });

  const out = openaiStreamToAnthropic(source, "m", 5);
  const reader = out.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }

  assert.ok(text.includes('"type":"tool_use"'));
  assert.ok(text.includes('"name":"Read"'));
  assert.ok(text.includes('"type":"input_json_delta"'));
  assert.ok(text.includes('"stop_reason":"tool_use"'));
});

test("openaiRequestToAnthropic maps system, messages and tools", () => {
  const out = openaiRequestToAnthropic({
    model: "route-sonnet",
    stream: true,
    messages: [
      { role: "system", content: "be helpful" },
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "calling",
        tool_calls: [
          { id: "t1", type: "function", function: { name: "Read", arguments: '{"path":"a"}' } },
        ],
      },
      { role: "tool", tool_call_id: "t1", content: "file contents" },
    ],
    tools: [
      {
        type: "function",
        function: { name: "Read", description: "read", parameters: { type: "object" } },
      },
    ],
  });

  assert.equal(out.model, "route-sonnet");
  assert.equal(out.stream, true);
  assert.equal(out.system, "be helpful");
  assert.equal(out.messages[0].role, "user");
  assert.equal(out.messages[1].role, "assistant");
  const assistant = out.messages[1].content as Record<string, unknown>[];
  assert.equal(assistant[0].type, "text");
  assert.equal(assistant[1].type, "tool_use");
  assert.equal(assistant[1].name, "Read");
  assert.equal(out.messages[2].role, "user");
  const toolResult = out.messages[2].content as Record<string, unknown>[];
  assert.equal(toolResult[0].type, "tool_result");
  assert.equal(toolResult[0].tool_use_id, "t1");
  assert.equal(out.tools?.[0].name, "Read");
  assert.equal((out.tools?.[0] as Record<string, any>).input_schema.type, "object");
});

test("anthropicResponseToOpenAI maps content, tool calls and usage", () => {
  const out = anthropicResponseToOpenAI(
    {
      id: "msg_1",
      content: [
        { type: "text", text: "done" },
        { type: "tool_use", id: "t1", name: "Read", input: { path: "a" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 12, output_tokens: 5 },
    },
    "route-sonnet",
  ) as Record<string, any>;

  assert.equal(out.object, "chat.completion");
  assert.equal(out.choices[0].message.content, "done");
  assert.equal(out.choices[0].message.tool_calls[0].function.name, "Read");
  assert.equal(out.choices[0].message.tool_calls[0].function.arguments, '{"path":"a"}');
  assert.equal(out.choices[0].finish_reason, "tool_calls");
  assert.equal(out.usage.prompt_tokens, 12);
  assert.equal(out.usage.completion_tokens, 5);
  assert.equal(out.usage.total_tokens, 17);
});

test("anthropicStreamToOpenAI emits a valid OpenAI chunk sequence", async () => {
  const events =
    [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":9,"output_tokens":0}}}',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}',
      'data: {"type":"content_block_stop","index":0}',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
      'data: {"type":"message_stop"}',
    ].join("\n\n") + "\n\n";

  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(events));
      controller.close();
    },
  });

  const out = anthropicStreamToOpenAI(source, "route-sonnet");
  const reader = out.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }

  assert.ok(text.includes('"chat.completion.chunk"'));
  assert.ok(text.includes('"role":"assistant"'));
  assert.ok(text.includes('"content":"Hel"'));
  assert.ok(text.includes('"content":"lo"'));
  assert.ok(text.includes('"finish_reason":"stop"'));
  assert.ok(text.includes('"completion_tokens":2'));
  assert.ok(text.includes("data: [DONE]"));
});

test("anthropicStreamToOpenAI streams tool calls", async () => {
  const events =
    [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":4}}}',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"Read"}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"a.ts\\"}"}}',
      'data: {"type":"content_block_stop","index":0}',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":8}}',
      'data: {"type":"message_stop"}',
    ].join("\n\n") + "\n\n";

  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(events));
      controller.close();
    },
  });

  const out = anthropicStreamToOpenAI(source, "m");
  const reader = out.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }

  assert.ok(text.includes('"tool_calls"'));
  assert.ok(text.includes('"name":"Read"'));
  assert.ok(text.includes('"finish_reason":"tool_calls"'));
});

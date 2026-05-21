import assert from "node:assert/strict";
import { test } from "node:test";
import {
  anthropicToOpenAI,
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

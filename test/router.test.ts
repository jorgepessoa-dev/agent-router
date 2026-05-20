import assert from "node:assert/strict";
import { test } from "node:test";
import type { Config } from "../src/config";
import { decideRoute, isPlanMode, tierFromModel } from "../src/router";
import { isNewUserTurn, turnKey } from "../src/turn";
import type { MessagesRequest } from "../src/types";

const config: Config = {
  port: 8787,
  providers: {
    minimax: { baseUrl: "x", apiKeyEnv: "X", auth: "bearer", model: "MiniMax-M2.7" },
    "anthropic-haiku": { baseUrl: "x", apiKeyEnv: "X", auth: "x-api-key", model: "claude-haiku-4-5" },
    "anthropic-opus": { baseUrl: "x", apiKeyEnv: "X", auth: "x-api-key", model: "claude-opus-4-7" },
  },
  routing: {
    tiers: {
      background: "anthropic-haiku",
      haiku: "anthropic-haiku",
      sonnet: "minimax",
      opus: "anthropic-opus",
    },
    planModeToOpus: true,
    classifier: { enabled: false, provider: "anthropic-haiku" },
  },
};

const noClassify = { classify: async () => "simple" as const };

test("tierFromModel maps route-* sentinels and real model names", () => {
  assert.equal(tierFromModel("route-background"), "background");
  assert.equal(tierFromModel("route-haiku"), "haiku");
  assert.equal(tierFromModel("route-sonnet"), "sonnet");
  assert.equal(tierFromModel("route-opus"), "opus");
  assert.equal(tierFromModel("claude-haiku-4-5"), "haiku");
  assert.equal(tierFromModel("claude-opus-4-7"), "opus");
  assert.equal(tierFromModel("something-unknown"), "sonnet");
});

test("background and haiku tiers route to the haiku provider", async () => {
  for (const model of ["route-background", "route-haiku"]) {
    const decision = await decideRoute({ model, messages: [] }, config, noClassify);
    assert.equal(decision.providerName, "anthropic-haiku");
  }
});

test("sonnet tier routes to minimax by default", async () => {
  const decision = await decideRoute({ model: "route-sonnet", messages: [] }, config, noClassify);
  assert.equal(decision.providerName, "minimax");
});

test("opus tier routes to the opus provider", async () => {
  const decision = await decideRoute({ model: "route-opus", messages: [] }, config, noClassify);
  assert.equal(decision.providerName, "anthropic-opus");
});

test("plan mode escalates the sonnet tier to opus", async () => {
  const req: MessagesRequest = {
    model: "route-sonnet",
    messages: [],
    tools: [{ name: "ExitPlanMode" }],
  };
  assert.equal(isPlanMode(req), true);
  const decision = await decideRoute(req, config, noClassify);
  assert.equal(decision.providerName, "anthropic-opus");
});

test("classifier escalates complex turns to opus, keeps simple on minimax", async () => {
  const withClassifier: Config = {
    ...config,
    routing: { ...config.routing, classifier: { enabled: true, provider: "anthropic-haiku" } },
  };
  const req: MessagesRequest = {
    model: "route-sonnet",
    messages: [{ role: "user", content: "design a distributed system" }],
  };
  const complex = await decideRoute(req, withClassifier, { classify: async () => "complex" });
  assert.equal(complex.providerName, "anthropic-opus");
  const simple = await decideRoute(req, withClassifier, { classify: async () => "simple" });
  assert.equal(simple.providerName, "minimax");
});

test("isNewUserTurn distinguishes text turns from tool_result continuations", () => {
  assert.equal(
    isNewUserTurn({ model: "x", messages: [{ role: "user", content: "hello" }] }),
    true,
  );
  assert.equal(
    isNewUserTurn({
      model: "x",
      messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "1" }] }],
    }),
    false,
  );
});

test("turnKey is stable across the tool round-trips of one turn", () => {
  const turnStart: MessagesRequest = {
    model: "x",
    messages: [{ role: "user", content: "do the thing" }],
  };
  const continuation: MessagesRequest = {
    model: "x",
    messages: [
      { role: "user", content: "do the thing" },
      { role: "assistant", content: [{ type: "tool_use", id: "1", name: "Read" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "1" }] },
    ],
  };
  assert.equal(turnKey(turnStart), turnKey(continuation));
});

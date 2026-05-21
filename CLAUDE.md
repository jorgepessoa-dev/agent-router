# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm start` — run the router on `http://localhost:8787` (`tsx src/index.ts`)
- `npm run dev` — run with watch/restart
- `npm run typecheck` — `tsc --noEmit` (no build step; `tsx` runs the TS directly)
- `npm test` — all tests (`node --import tsx --test test/*.test.ts`)
- Single test file: `node --import tsx --test test/router.test.ts`
- Single test by name: `node --import tsx --test --test-name-pattern="plan mode" test/*.test.ts`

`ROUTER_CONFIG=/path/to/config.json` overrides the config path — used to point
the router at mock upstreams for integration testing.

## What this is

An HTTP proxy that sits between Claude Code and LLM providers. Claude Code is
pointed at it via `ANTHROPIC_BASE_URL` (see `scripts/cc.sh`), so routing is
invisible to the user. It speaks the Anthropic Messages API on `POST
/v1/messages` and routes each request to a cheaper provider.

## Architecture

Request flow: `index.ts` → `server.ts` `handle()` → `router.ts` `decideRoute()`
→ `providers.ts` `forward()` → upstream provider → response streamed back.

**Two-layer routing** (`router.ts`):
1. Deterministic — `tierFromModel()` reads the request's `model` field (Claude
   Code tags each request's tier via the `route-*` sentinels set by
   `scripts/cc.sh`). Tiers map to providers via `config.routing.tiers`. Plan
   mode (`isPlanMode()`, detected by the `ExitPlanMode` tool) escalates to Opus.
2. Classifier — for the `sonnet` execution tier, `classifier.ts` calls a
   Haiku-class model to decide `simple` vs `complex` (escalate to Opus). It
   runs **once per user turn** and the verdict is pinned in `turn.ts` for the
   turn's tool round-trips. New-turn vs continuation is decided by whether the
   last message carries `tool_result` blocks; `turnKey()` hashes the
   conversation prefix so all round-trips of a turn share a cache key.

**Provider formats** (`config.json` `providers[].format`):
- `anthropic` — speaks the Anthropic Messages API; `forward()` is a pure
  streaming SSE passthrough.
- `openai` — speaks the OpenAI Chat Completions API; `translate.ts` converts
  request and response both ways, including the streaming SSE event sequence
  and tool calls.

Key invariant: `providers.ts` `forward()` **always returns Anthropic-format
output** (`ForwardResult`), so `server.ts` is format-agnostic — it just streams
whatever body it gets and taps the bytes for token usage.

`stats.ts` accumulates per-provider request/token/cost totals in memory;
`server.ts` exposes them at `GET /stats` and renders `dashboard.ts` HTML at
`GET /`.

## Riskiest code

`openaiStreamToAnthropic()` in `translate.ts` is a state machine that
reconstructs the full Anthropic SSE event sequence (`message_start` →
`content_block_*` → `message_delta` → `message_stop`) from OpenAI delta chunks.
Changes here need the streaming tests in `test/translate.test.ts`.

## Config

`config.json` defines providers, the tier→provider map, the classifier toggle,
and `baselinePricing` (reference rates for the dashboard's savings estimate).
API keys are resolved from env vars named by `provider.apiKeyEnv` (loaded from
`.env` by `loadEnv()`); `auth: "none"` providers (e.g. local Ollama) need no key.

# ClaudeCode_router

A transparent router for Claude Code. Claude Code works exactly as usual, but
requests are routed to cheaper models underneath:

| Tier (from Claude Code)        | Routed to        | Role                              |
| ------------------------------ | ---------------- | --------------------------------- |
| background / small-fast model  | **Haiku**        | trivial internal tasks            |
| sonnet (default execution)     | **MiniMax-M2.7** | reasoning + code (the real work)  |
| opus / plan mode / "complex"   | **Opus**         | orchestration / deep reasoning    |

## How routing works

Two layers, no LLM call on the hot path:

1. **Deterministic** — Claude Code tags every request with its tier via the
   `ANTHROPIC_DEFAULT_*_MODEL` / `ANTHROPIC_SMALL_FAST_MODEL` env vars (set to
   `route-*` sentinels by `scripts/cc.sh`). The router reads the request's
   `model` field and maps it to a provider. Plan mode (detected via the
   `ExitPlanMode` tool) escalates to Opus.
2. **Classifier** — for the `sonnet` execution tier, a Haiku call decides
   `simple` vs `complex` to escalate hard turns to Opus. It runs **once per
   user turn** and the verdict is pinned for that turn's tool round-trips, so
   prompt caching is preserved and Haiku is not called per request.

## Provider formats

Each provider has a `format`:

- `anthropic` — speaks the Anthropic Messages API (MiniMax, Anthropic). The
  router is a pure streaming SSE reverse proxy: no translation.
- `openai` — speaks the OpenAI Chat Completions API (Ollama, OpenRouter, ...).
  The router translates request and response (including the streaming SSE
  event sequence and tool calls) in both directions.

## Setup

1. Install dev dependencies: `npm install`
2. Copy `.env.example` to `.env` and fill in `MINIMAX_API_KEY` and
   `ANTHROPIC_API_KEY` (and `OPENROUTER_API_KEY` if you route to OpenRouter).
3. Review `config.json` — providers, tier mapping, and **`pricing`** /
   **`baselinePricing`** (the per-million-token rates are illustrative; set
   your real rates so the cost estimates are accurate).

## Usage

```sh
scripts/cc.sh            # starts the router if needed, then launches Claude Code
```

Inside Claude Code, use `/model` as normal (`sonnet` → MiniMax, `opus` → Opus).

## Dashboard

With the router running, open <http://localhost:8787/> for a live cost
dashboard: per-provider request counts, token usage, spend, and estimated
savings versus the `baselinePricing` (Sonnet) reference. Raw JSON is at
`/stats`; `/health` is a plain status check.

## Commands

- `npm start` — run the router (`http://localhost:8787`)
- `npm test` — unit tests (routing logic + OpenAI translation)
- `npm run typecheck` — TypeScript type-check

CI runs `typecheck` and `test` on every push and pull request
(`.github/workflows/ci.yml`).

## Configuration (`config.json`)

- `providers` — base URL, `format`, API key env var, auth scheme, model id,
  pricing. `auth` may be `bearer`, `x-api-key`, or `none` (keyless, e.g. local
  Ollama).
- `routing.tiers` — maps each tier to a provider.
- `routing.planModeToOpus` — escalate plan-mode requests to Opus.
- `routing.classifier` — enable/disable the Haiku escalation classifier.
- `baselinePricing` — reference rates for the dashboard's savings estimate.

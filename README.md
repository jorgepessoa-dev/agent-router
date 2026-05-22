# agent-router

> Guia de utilização em português: **[GUIA.md](GUIA.md)**

A transparent router for Claude Code and the Codex CLI. Both agents work
exactly as usual; their requests are routed to a cheaper model (MiniMax-M2.7)
underneath:

| Tier (from Claude Code)        | Routed to        | Role                              |
| ------------------------------ | ---------------- | --------------------------------- |
| background / haiku             | **MiniMax-M2.7** | trivial / light tasks             |
| sonnet (default execution)     | **MiniMax-M2.7** | reasoning + code (the real work)  |
| opus / plan mode               | **MiniMax-M2.7** | deep reasoning                    |

The shipped `config.json` routes **every tier to MiniMax**, so no Anthropic API
key is needed. Repoint individual tiers in `routing.tiers` to use other
providers — e.g. set `opus` to `anthropic-opus` for real Opus on hard turns.

## How routing works

Two layers, no LLM call on the hot path:

1. **Deterministic** — Claude Code tags every request with its tier via the
   `ANTHROPIC_DEFAULT_*_MODEL` / `ANTHROPIC_SMALL_FAST_MODEL` env vars (set to
   `route-*` sentinels by `scripts/cc.sh`). The router reads the request's
   `model` field and maps it to a provider. Plan mode (detected via the
   `ExitPlanMode` tool) can escalate to the `opus` tier — a config toggle
   (`routing.planModeToOpus`), off in the shipped config.
2. **Classifier** *(optional — disabled in the shipped config)* — for the
   `sonnet` execution tier, a Haiku call can decide `simple` vs `complex` to
   escalate hard turns to Opus. It runs **once per user turn** and the verdict
   is pinned for that turn's tool round-trips, so prompt caching is preserved
   and Haiku is not called per request.

## Provider formats

Each provider has a `format`:

- `anthropic` — speaks the Anthropic Messages API (MiniMax, Anthropic). The
  router is a pure streaming SSE reverse proxy: no translation.
- `openai` — speaks the OpenAI Chat Completions API (Ollama, OpenRouter, ...).
  The router translates request and response (including the streaming SSE
  event sequence and tool calls) in both directions.

## Setup

1. Install dev dependencies: `npm install`
2. Copy `.env.example` to `.env` and fill in `MINIMAX_API_KEY`. The shipped
   all-MiniMax config needs no other key — only add `ANTHROPIC_API_KEY` or
   `OPENROUTER_API_KEY` if you repoint a tier to those providers.
3. Review `config.json` — providers, tier mapping, and **`pricing`** /
   **`baselinePricing`** (the per-million-token rates are illustrative; set
   your real rates so the cost estimates are accurate).

## Usage

```sh
scripts/cc.sh            # macOS / Linux / WSL — starts the router, then launches Claude Code
scripts\cc.ps1           # Windows (PowerShell) — native-Windows equivalent
```

Inside Claude Code, use `/model` as normal — every tier routes to MiniMax.

OpenAI-format clients (e.g. the Codex CLI) can point at `POST
/v1/chat/completions`; the router translates to and from the Anthropic API.
See `GUIA.md` for the Codex setup.

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
- `routing.tiers` — maps each tier to a provider. Every tier ships pointed at
  `minimax`; repoint a tier (e.g. `opus` to `anthropic-opus`) to use another
  provider.
- `routing.planModeToOpus` — escalate plan-mode requests to the `opus` tier.
- `routing.classifier` — enable/disable the Haiku escalation classifier
  (disabled in the shipped config).
- `baselinePricing` — reference rates for the dashboard's savings estimate.
- `port` / `host` — the router binds `host` (default `127.0.0.1`, localhost
  only) on `port`. It has **no inbound authentication**, so only set `host` to
  `0.0.0.0` if a client genuinely must reach it across a network.

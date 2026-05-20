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

MiniMax and Anthropic both speak the Anthropic Messages API, so the router is a
streaming reverse proxy — SSE is passed through untouched, no format
translation.

## Setup

1. Install dev dependencies: `npm install`
2. Copy `.env.example` to `.env` and fill in `MINIMAX_API_KEY` and
   `ANTHROPIC_API_KEY`.
3. Review `config.json` — providers, tier mapping, and **`pricing`** (the
   per-million-token rates are illustrative; set your real rates so the cost
   estimates in the logs are accurate).

## Usage

```sh
scripts/cc.sh            # starts the router if needed, then launches Claude Code
```

Inside Claude Code, use `/model` as normal (`sonnet` → MiniMax, `opus` → Opus).
The router logs one line per request: tier, provider, reason, latency, token
usage, and estimated cost.

## Commands

- `npm start` — run the router (`http://localhost:8787`)
- `npm test` — unit tests for the routing logic
- `npm run typecheck` — TypeScript type-check

## Configuration (`config.json`)

- `providers` — base URL, API key env var, auth scheme, model id, pricing.
- `routing.tiers` — maps each tier to a provider.
- `routing.planModeToOpus` — escalate plan-mode requests to Opus.
- `routing.classifier` — enable/disable the Haiku escalation classifier.

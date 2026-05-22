# AGENTS.md

Guidance for the Codex CLI (and other coding agents) working in this
repository.

## Objective

This router exists to **split work by cost**. Route the bulk of coding work to
a cheap model (MiniMax-M2.7); reserve the subscription's expensive
reasoning/orchestration models (e.g. Claude Opus, Codex's GPT-5.x) for the hard
turns. The setup works the same on WSL and native Windows, and serves both the
Codex CLI (`POST /v1/chat/completions`) and Claude Code (`POST /v1/messages`).

- Routine, high-volume work → routed to MiniMax (cheap).
- Reasoning and orchestration → the Claude/Codex subscription's top model, used
  directly (not through the router).

## Working in this repo

`CLAUDE.md` and `README.md` hold the full commands, architecture, and
configuration — they apply equally to Codex. Key points:

- `npm start` runs the router; `npm test` runs the tests; `npm run typecheck`
  type-checks. No build step — `tsx` runs the TypeScript directly.
- The router exposes the Anthropic API (`POST /v1/messages`) and the OpenAI
  Chat Completions API (`POST /v1/chat/completions`); `src/translate.ts`
  converts between the two formats in both directions.
- `GUIA.md` explains how to point the Codex CLI at the router.

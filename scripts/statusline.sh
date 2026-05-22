#!/usr/bin/env bash
# Claude Code statusline — surfaces the real model when running through
# agent-router. Wire it into ~/.claude/settings.json:
#
#   {
#     "statusLine": {
#       "type": "command",
#       "command": "/absolute/path/to/agent-router/scripts/statusline.sh"
#     }
#   }
#
# It detects the routed mode from ANTHROPIC_BASE_URL (set by cc.sh / cc.ps1).
case "${ANTHROPIC_BASE_URL:-}" in
  http://localhost:8787*|http://127.0.0.1:8787*)
    printf 'router -> MiniMax-M2.7 (cheap)'
    ;;
  *)
    printf 'Claude (direct)'
    ;;
esac

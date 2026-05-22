# Launches Claude Code transparently through the local router (Windows / PowerShell).
# Usage: scripts\cc.ps1 [claude args...]
# PowerShell equivalent of scripts/cc.sh.
$ErrorActionPreference = "Stop"

$RouterPort = if ($env:ROUTER_PORT) { $env:ROUTER_PORT } else { "8787" }
$RouterUrl  = "http://localhost:$RouterPort"
$ProjectDir = Split-Path $PSScriptRoot -Parent
$LogFile    = Join-Path $env:TEMP "ccrouter.log"

function Test-Router {
  try {
    Invoke-WebRequest -UseBasicParsing "$RouterUrl/health" -TimeoutSec 2 | Out-Null
    return $true
  } catch {
    return $false
  }
}

# Start the router if it is not already listening.
if (-not (Test-Router)) {
  Write-Host "[cc] starting router on $RouterUrl ..."
  Start-Process -FilePath "cmd.exe" `
    -ArgumentList "/c npm start > `"$LogFile`" 2>&1" `
    -WorkingDirectory $ProjectDir -WindowStyle Hidden
  for ($i = 0; $i -lt 30; $i++) {
    if (Test-Router) { break }
    Start-Sleep -Milliseconds 500
  }
  if (-not (Test-Router)) {
    Write-Error "[cc] router failed to start; see $LogFile"
    exit 1
  }
}

# Point Claude Code at the router. The route-* sentinels let the router read
# each request's intended tier from its model field.
$env:ANTHROPIC_BASE_URL = $RouterUrl
$env:ANTHROPIC_AUTH_TOKEN = "router-local"
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL = "route-haiku"
$env:ANTHROPIC_DEFAULT_SONNET_MODEL = "route-sonnet"
$env:ANTHROPIC_DEFAULT_OPUS_MODEL = "route-opus"
$env:ANTHROPIC_SMALL_FAST_MODEL = "route-background"
$env:API_TIMEOUT_MS = "3000000"
$env:CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1"

& claude @args

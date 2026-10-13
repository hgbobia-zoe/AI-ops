#requires -Version 5
# Responder startup (office machine). Loads the AI bridge token into this session's AI_BRIDGE_TOKEN, then
# heartbeats the bridge + shows the pending queue + active runs. Run this, then drive the responder per
# docs/ai-bridge-responder.md.
#
#   .\scripts\responder\start.ps1
#
# Token source, in order: an already-set $env:AI_BRIDGE_TOKEN (e.g. a persistent user env var), else a local
# file ~/.zoe-responder/bridge.token (gitignored by living outside the repo). One-time setup is printed if
# neither exists.

$ErrorActionPreference = "Stop"
$tokenFile = Join-Path $HOME ".zoe-responder\bridge.token"

if ([string]::IsNullOrWhiteSpace($env:AI_BRIDGE_TOKEN)) {
  if (Test-Path $tokenFile) {
    $env:AI_BRIDGE_TOKEN = (Get-Content -Raw $tokenFile).Trim()
  }
}

if ([string]::IsNullOrWhiteSpace($env:AI_BRIDGE_TOKEN)) {
  Write-Host "AI_BRIDGE_TOKEN is not set and no token file at $tokenFile." -ForegroundColor Yellow
  Write-Host ""
  Write-Host "One-time setup (generates a token, sets it on Fly, persists it, and saves it locally):"
  Write-Host '  $tok = node -e "console.log(require(''crypto'').randomBytes(32).toString(''hex''))"'
  Write-Host '  flyctl secrets set AI_BRIDGE_TOKEN=$tok -a zoe-dispatch'
  Write-Host '  [Environment]::SetEnvironmentVariable(''AI_BRIDGE_TOKEN'', $tok, ''User'')'
  Write-Host '  New-Item -ItemType Directory -Force (Split-Path $HOME\.zoe-responder\bridge.token) | Out-Null'
  Write-Host '  $tok | Out-File -NoNewline -Encoding ascii $HOME\.zoe-responder\bridge.token'
  Write-Host ""
  Write-Host "Then re-run this script. (Setting it as a User env var means every NEW shell already has it.)"
  exit 1
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Write-Host ("AI_BRIDGE_TOKEN loaded ({0} chars). Heartbeat + queue:" -f $env:AI_BRIDGE_TOKEN.Length) -ForegroundColor Green
node (Join-Path $scriptDir "poll.mjs")

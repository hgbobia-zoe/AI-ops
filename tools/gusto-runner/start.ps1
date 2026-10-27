# Start the Gusto remote-browser runner in the foreground (reads config from .env).
#   .\start.ps1
# Keep this window open. For an always-on, survives-reboot setup, use install-service.ps1 instead.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Test-Path ".env")) {
  Write-Error "No .env found - run .\setup.ps1 first, then edit .env."
  exit 1
}
if (-not (Test-Path "node_modules")) {
  Write-Error "Dependencies not installed - run .\setup.ps1 first."
  exit 1
}

npm start

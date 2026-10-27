# One-time setup for the Gusto remote-browser runner (office machine).
#   Run once:  powershell -ExecutionPolicy Bypass -File .\setup.ps1
# Installs dependencies + the Chromium browser, and creates a .env you then fill in with your token.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Test-Path ".env")) {
  Copy-Item "env.example" ".env"
  Write-Host "Created .env - open it and set GUSTO_RUNNER_TOKEN (the SAME value you set on Fly)." -ForegroundColor Yellow
} else {
  Write-Host ".env already exists - leaving it as is." -ForegroundColor DarkGray
}

Write-Host "Installing dependencies..." -ForegroundColor Cyan
npm install
Write-Host "Installing Chromium..." -ForegroundColor Cyan
npx playwright install chromium

Write-Host ""
Write-Host "Setup done." -ForegroundColor Green
Write-Host "  1) Edit .env and paste your GUSTO_RUNNER_TOKEN."
Write-Host "  2) Run it once in the foreground to confirm:  .\start.ps1"
Write-Host "  3) Install it to run at startup + restart on failure:  .\install-service.ps1"

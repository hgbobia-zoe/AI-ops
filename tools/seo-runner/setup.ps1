# One-time setup for the SEO keyword-pull runner (office machine).
#   Run once:  powershell -ExecutionPolicy Bypass -File .\setup.ps1
# Installs dependencies and creates a .env you then fill in. Does NOT sign in — that happens in start.ps1.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Test-Path ".env")) {
  Copy-Item "env.example" ".env"
  Write-Host "Created .env - open it and set SEO_INGEST_TOKEN (the SAME value as the app's Fly secret)." -ForegroundColor Yellow
} else {
  Write-Host ".env already exists - leaving it as is." -ForegroundColor DarkGray
}

Write-Host "Installing dependencies..." -ForegroundColor Cyan
npm install

Write-Host ""
Write-Host "Setup done." -ForegroundColor Green
Write-Host "  1) Edit .env (set SEO_INGEST_TOKEN, SEO_ZOE_DOMAIN, SEO_COMPETITOR_DOMAINS)."
Write-Host "  2) Test one read in the foreground:        .\start.ps1"
Write-Host "  3) Install the scheduled drip:             .\install-service.ps1"

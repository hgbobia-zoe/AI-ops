# Run the SEO SERP-pull runner ONCE in the FOREGROUND (a test run). Reads config from .env.
#   .\start.ps1
# There is NO sign-in step anymore (the Ubersuggest OAuth is gone) — this just reads a small batch of Google
# SERPs and pushes them to the app so you can confirm it works, then watch boot.log / the SEO Overview.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Test-Path ".env")) { Write-Error "No .env found - run .\setup.ps1 first, then edit .env."; exit 1 }

npm start

Write-Host ""
Write-Host "Done. Check what it read:  Get-Content .\boot.log -Tail 30" -ForegroundColor Green
Write-Host "Then install the drip:     .\install-service.ps1"

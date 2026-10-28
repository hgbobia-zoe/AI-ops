# Run the SEO keyword-pull runner in the FOREGROUND (reads config from .env).
#   .\start.ps1
# Use this for the ONE-TIME sign-in: it sets SEO_ALLOW_INTERACTIVE so the runner may open a browser for the
# Ubersuggest OAuth. After you authorize once, the token is cached and the scheduled task runs headless.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Test-Path ".env")) { Write-Error "No .env found - run .\setup.ps1 first, then edit .env."; exit 1 }
if (-not (Test-Path "node_modules")) { Write-Error "Dependencies not installed - run .\setup.ps1 first."; exit 1 }

$env:SEO_ALLOW_INTERACTIVE = "1"
npm start

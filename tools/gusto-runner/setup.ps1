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

# Co-locate the Playwright browsers WITH the runner (not the per-user AppData default). This keeps the runner
# self-contained and portable, and avoids a class of failures where the scheduled task cannot resolve browsers
# installed under a different filesystem view (e.g. a redirected/sandboxed AppData). runner.js reads this same
# PLAYWRIGHT_BROWSERS_PATH from .env at launch, so the two must agree.
$browsersDir = Join-Path $PSScriptRoot ".pw-browsers"
$env:PLAYWRIGHT_BROWSERS_PATH = $browsersDir
if (-not (Select-String -Path ".env" -Pattern "^PLAYWRIGHT_BROWSERS_PATH=" -Quiet)) {
  Add-Content -Path ".env" -Value "PLAYWRIGHT_BROWSERS_PATH=$browsersDir" -Encoding ascii
}
Write-Host "Installing Chromium + headless shell into $browsersDir ..." -ForegroundColor Cyan
npx playwright install chromium chromium-headless-shell

Write-Host ""
Write-Host "Setup done." -ForegroundColor Green
Write-Host "  1) Edit .env and paste your GUSTO_RUNNER_TOKEN."
Write-Host "  2) Run it once in the foreground to confirm:  .\start.ps1"
Write-Host "  3) Install it to run at startup + restart on failure:  .\install-service.ps1"

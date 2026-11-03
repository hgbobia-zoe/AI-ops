# Start the Website Studio runner with settings from .env (next to this script). Run from any folder:
#   powershell -ExecutionPolicy Bypass -File C:\Git\zoe-website-studio\start.ps1
# .env holds KEY=VALUE lines (APP_URL, WEBSITE_RUNNER_TOKEN, WEBSITE_REPO_PATH, ANTHROPIC_API_KEY, ...).
# A variable already set in the environment wins over .env.
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$envFile = Join-Path $here '.env'
if (Test-Path $envFile) {
  foreach ($line in Get-Content $envFile) {
    if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$') {
      $name = $Matches[1]; $val = $Matches[2].Trim('"', "'")
      if (-not [Environment]::GetEnvironmentVariable($name)) { [Environment]::SetEnvironmentVariable($name, $val) }
    }
  }
} else {
  Write-Host "No .env next to start.ps1; using the current environment only."
}
Set-Location $here
node (Join-Path $here 'runner.js')

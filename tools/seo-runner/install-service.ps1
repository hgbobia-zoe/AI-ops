# Install the SEO keyword-pull runner as a Windows Scheduled Task that DRIPS: it runs a small batch at logon
# and then every few hours, each run pulling SEO_BATCH pending keywords and exiting (free-tier safe).
#   powershell -ExecutionPolicy Bypass -File .\install-service.ps1
# Run start.ps1 ONCE first to complete the Ubersuggest OAuth sign-in (the task runs headless with the cached
# token). Re-run to update. Remove with:  Unregister-ScheduledTask -TaskName ZoeSeoRunner -Confirm:$false
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Test-Path ".env")) { Write-Error "No .env found - run .\setup.ps1 first, then edit .env."; exit 1 }
if (-not (Test-Path "node_modules")) { Write-Error "Dependencies not installed - run .\setup.ps1 first."; exit 1 }
if (-not (Test-Path ".seo-oauth\tokens.json")) {
  Write-Warning "No cached OAuth token yet. Run .\start.ps1 once to sign into Ubersuggest, or the task will exit with 'sign-in required' until you do."
}

$taskName = "ZoeSeoRunner"
$node = (Get-Command node -ErrorAction Stop).Source
$intervalHours = 6  # free-tier drip; lower this (and raise SEO_BATCH) on a paid plan

# Absolute script path — Task Scheduler does not reliably honor the action's WorkingDirectory at logon.
$action = New-ScheduledTaskAction -Execute $node -Argument ('"' + (Join-Path $PSScriptRoot 'runner.mjs') + '"') -WorkingDirectory $PSScriptRoot

# Fire at logon, then repeat every $intervalHours indefinitely. (Copy the repetition spec off a dummy Once
# trigger — the supported way to attach an indefinite repetition to an AtLogOn trigger.)
$trigger = New-ScheduledTaskTrigger -AtLogOn
$trigger.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Hours $intervalHours) -RepetitionDuration (New-TimeSpan -Days 3650)).Repetition

$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 15) `
  -MultipleInstances IgnoreNew `
  -DontStopOnIdleEnd -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force -RunLevel Limited | Out-Null

Write-Host "Installed scheduled task '$taskName' (drips every $intervalHours h, at logon + repeating)." -ForegroundColor Green
Write-Host "  - Each run pulls SEO_BATCH pending keywords and pushes them to the app, then exits."
Write-Host "  - Keep this machine powered on and logged into Windows."
Write-Host ""
Write-Host "Run it now:  Start-ScheduledTask -TaskName $taskName"
Write-Host "Check it:    Get-ScheduledTaskInfo -TaskName $taskName ;  Get-Content .\boot.log -Tail 20"

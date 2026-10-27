# Install the Gusto remote-browser runner as a Windows Scheduled Task so it runs automatically and survives
# reboots: it starts when this user logs into Windows and restarts itself if it ever stops.
#   powershell -ExecutionPolicy Bypass -File .\install-service.ps1
# Run it as the SAME Windows user whose Chrome profile is (or will be) logged into Gusto. Re-run to update.
# Remove with:  Unregister-ScheduledTask -TaskName ZoeGustoRunner -Confirm:$false
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Test-Path ".env")) { Write-Error "No .env found - run .\setup.ps1 first, then edit .env."; exit 1 }
if (-not (Test-Path "node_modules")) { Write-Error "Dependencies not installed - run .\setup.ps1 first."; exit 1 }

$taskName = "ZoeGustoRunner"
$node = (Get-Command node -ErrorAction Stop).Source

# runner.js loads .env itself, so the task just runs node in this folder. No token on the command line.
$action   = New-ScheduledTaskAction -Execute $node -Argument "runner.js" -WorkingDirectory $PSScriptRoot
$trigger  = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew `
  -DontStopOnIdleEnd -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force -RunLevel Limited | Out-Null

Write-Host "Installed scheduled task '$taskName'." -ForegroundColor Green
Write-Host "  - Runs when this Windows user logs in, and restarts on failure."
Write-Host "  - Keep this machine powered on and logged into Windows."
Write-Host ""
Write-Host "Start it now (without logging out):" -ForegroundColor Cyan
Write-Host "  Start-ScheduledTask -TaskName $taskName"
Write-Host "Check it:  Get-ScheduledTask -TaskName $taskName ;  Get-ScheduledTaskInfo -TaskName $taskName"

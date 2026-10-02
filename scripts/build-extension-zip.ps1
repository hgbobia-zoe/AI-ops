# Rebuilds public/zoe-autopull-extension.zip from the extension/ source folder.
# RUN THIS whenever you edit anything under extension/ (and bump extension/manifest.json "version"),
# then commit the updated zip — the /admin/pull "Install extension" download serves this static file,
# so source edits alone do NOT reach the office browser until the zip is rebuilt.
#
#   pwsh scripts/build-extension-zip.ps1   (or run from the repo root in PowerShell)

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$ext = Join-Path $root "extension"
$out = Join-Path $root "public\zoe-autopull-extension.zip"

# Zip every file at the extension/ root (no subfolders), placing them at the archive root — Chrome's
# "Load unpacked" expects manifest.json at the top level after unzip.
$files = Get-ChildItem -Path $ext -File | Select-Object -ExpandProperty FullName
if (Test-Path $out) { Remove-Item $out -Force }
Compress-Archive -Path $files -DestinationPath $out -Force

$ver = (Get-Content (Join-Path $ext "manifest.json") | Select-String '"version"').ToString().Trim()
Write-Host "Built $out  ($ver)"

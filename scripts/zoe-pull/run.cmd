@echo off
REM Zoe Auto-Pull runner — the command Windows Task Scheduler runs on a timer.
REM It launches its own Chrome (dedicated profile logged into Goodshuffle), pulls routes/bookings,
REM and CREATES any queued project shells by navigation (no popup, no open tab needed).
REM
REM One-time setup: run this once by double-clicking it, then sign into Goodshuffle in the window that
REM opens. The session persists in the profile; scheduled runs after that need no interaction.
REM
REM Headless: once the profile is logged in you can try invisible runs by uncommenting the line below.
REM If Goodshuffle's Cloudflare challenges the headless browser (pull fails / "signed out"), leave it
REM commented and it runs headful (a brief Chrome window each run).

setlocal
cd /d "%~dp0..\.."
if not defined ZOE_API set "ZOE_API=https://zoe-dispatch.fly.dev"
REM set "ZOE_HEADLESS=1"
if not exist "%USERPROFILE%\ZoePull" mkdir "%USERPROFILE%\ZoePull"
call npx --yes tsx "scripts\zoe-pull\run.mts" >> "%USERPROFILE%\ZoePull\pull.log" 2>&1
endlocal

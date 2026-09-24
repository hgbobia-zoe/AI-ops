@echo off
REM Zoe Auto-Pull — persistent "sign in once, stays running" watcher.
REM
REM What it does: launches its OWN Chrome (a dedicated profile kept signed into Goodshuffle), pulls
REM routes/bookings and CREATES any queued project shells by navigation (no popup, no open tab needed),
REM then keeps the window open and repeats every ZOE_INTERVAL_MIN minutes forever. No scheduled task.
REM
REM First run: a Chrome window opens on the Goodshuffle sign-in page. Sign in once, then MINIMIZE the
REM window and leave it. It stays signed in and pulls on its own from then on. If the session ever drops,
REM it waits for you to sign in again in the same window.
REM
REM Auto-start on boot: put a shortcut to THIS file in your Startup folder
REM   (Win+R -> shell:startup -> paste a shortcut to scripts\zoe-pull\run.cmd).

setlocal
cd /d "%~dp0..\.."
if not defined ZOE_API set "ZOE_API=https://zoe-dispatch.fly.dev"
set "ZOE_WATCH=1"
if not defined ZOE_INTERVAL_MIN set "ZOE_INTERVAL_MIN=10"
if not exist "%USERPROFILE%\ZoePull" mkdir "%USERPROFILE%\ZoePull"
call npx --yes tsx "scripts\zoe-pull\run.mts" >> "%USERPROFILE%\ZoePull\pull.log" 2>&1
endlocal

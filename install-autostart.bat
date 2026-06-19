@echo off
REM ============================================================
REM  Signal Web App - install login autostart
REM  Adds a hidden launcher to your Startup folder so Signal
REM  (tray + debug port) and the server come up on every login.
REM  Remove it later by running:  npm run autostart:remove
REM ============================================================
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\install-autostart.ps1"
echo.
echo Tip: also pin the http://127.0.0.1:7700 tab in Chrome and set
echo      Settings - On startup - Continue where you left off.
echo.
pause

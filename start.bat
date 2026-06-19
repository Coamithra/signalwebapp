@echo off
REM ============================================================
REM  Signal Web App - one-click start
REM  Launches Signal Desktop (tray + debug port), starts the
REM  local server, and opens the tab in your default browser.
REM ============================================================
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [!] Node.js was not found on your PATH.
  echo     Install Node 22+ from https://nodejs.org and run this again.
  pause
  exit /b 1
)

echo === Signal Web App ===
echo.
echo Launching Signal Desktop in the system tray with remote debugging...
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\launch-signal.ps1"

echo Opening the Signal tab in your browser...
start "" http://127.0.0.1:7700

echo.
echo Starting the local server.
echo Keep this window open while you use Signal. Close it (or Ctrl+C) to stop.
echo.
node src/server.js

# Login plumbing for the Signal web app. Idempotent and safe to run repeatedly.
#
#   1. Ensures Signal Desktop is reachable via CDP. Signal's own "Open at login"
#      launches it WITHOUT the debug port, so if the port is closed we quietly
#      relaunch Signal into the system tray *with* --remote-debugging-port.
#   2. Ensures the Node bridge server is running (started hidden + detached).
#
# Designed to be invoked hidden by autostart.vbs from the Startup folder.

param(
  [int]$CdpPort = 9222,
  [int]$WebPort = 7700,
  [string]$SignalPath = "$env:LOCALAPPDATA\Programs\signal-desktop\Signal.exe"
)

$ErrorActionPreference = 'SilentlyContinue'
$repo = Split-Path -Parent $PSScriptRoot  # scripts\.. = repo root

function Test-Port([int]$p) {
  try {
    $c = New-Object Net.Sockets.TcpClient
    $c.Connect('127.0.0.1', $p)
    $ok = $c.Connected
    $c.Close()
    return $ok
  } catch { return $false }
}

# Let Signal's own "Open at login" come up first so we don't double-launch.
Start-Sleep -Seconds 6

# 1. Ensure Signal has the CDP debug port (relaunch into tray if needed).
if (-not (Test-Port $CdpPort)) {
  Get-Process -Name "Signal" -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Milliseconds 1500
  if (Test-Path $SignalPath) {
    Start-Process -FilePath $SignalPath -ArgumentList "--remote-debugging-port=$CdpPort", "--start-in-tray"
  }
}

# 2. Ensure the web server is running (hidden, detached).
if (-not (Test-Port $WebPort)) {
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) { $node = "node" }
  Start-Process -FilePath $node -ArgumentList "src/server.js" -WorkingDirectory $repo -WindowStyle Hidden
}

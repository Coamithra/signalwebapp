# Relaunch Signal Desktop with Chrome DevTools Protocol remote debugging enabled.
# The web app bridges to Signal through this port (localhost only).

param(
  [int]$Port = 9222,
  [string]$SignalPath = "$env:LOCALAPPDATA\Programs\signal-desktop\Signal.exe",
  # By default, start Signal hidden in the system tray (no taskbar window) so the
  # web tab is your only Signal surface. Pass -ShowWindow to keep the normal window.
  [switch]$ShowWindow
)

if (-not (Test-Path $SignalPath)) {
  Write-Error "Signal not found at $SignalPath. Pass -SignalPath '<path to Signal.exe>'."
  exit 1
}

# Quit any running Signal so it can be relaunched with the debug flag.
$running = Get-Process -Name "Signal" -ErrorAction SilentlyContinue
if ($running) {
  Write-Host "Stopping running Signal ($($running.Count) processes)..."
  Stop-Process -Name "Signal" -Force
  Start-Sleep -Milliseconds 1500
}

$signalArgs = @("--remote-debugging-port=$Port")
if (-not $ShowWindow) { $signalArgs += "--start-in-tray" }

Write-Host "Launching Signal: $($signalArgs -join ' ') ..."
Start-Process -FilePath $SignalPath -ArgumentList $signalArgs

# Wait for the debug endpoint to come up.
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline) {
  try {
    $r = Invoke-WebRequest -Uri "http://localhost:$Port/json/version" -UseBasicParsing -TimeoutSec 2
    if ($r.StatusCode -eq 200) {
      Write-Host "Signal CDP is up on port $Port." -ForegroundColor Green
      exit 0
    }
  } catch {
    Start-Sleep -Milliseconds 700
  }
}
Write-Warning "Signal launched but CDP port $Port did not respond within 30s."
exit 1

# Install (or remove) the Startup-folder launcher that brings the Signal web app
# up on login. The launcher runs autostart.ps1 completely hidden (no console flash)
# via a tiny VBScript shim placed in the user's Startup folder.
#
#   Install:    powershell -ExecutionPolicy Bypass -File scripts/install-autostart.ps1
#   Uninstall:  powershell -ExecutionPolicy Bypass -File scripts/install-autostart.ps1 -Uninstall

param([switch]$Uninstall)

$repo    = Split-Path -Parent $PSScriptRoot
$ps1     = Join-Path $repo "scripts\autostart.ps1"
$startup = [Environment]::GetFolderPath('Startup')
$vbsPath = Join-Path $startup "SignalWebApp.vbs"

if ($Uninstall) {
  if (Test-Path $vbsPath) {
    Remove-Item $vbsPath -Force
    Write-Host "Removed startup launcher: $vbsPath" -ForegroundColor Green
  } else {
    Write-Host "No startup launcher found."
  }
  return
}

if (-not (Test-Path $ps1)) { Write-Error "autostart.ps1 not found at $ps1"; exit 1 }

# Build the hidden-launch VBScript. WScript.Shell.Run with window style 0 = hidden.
$cmd = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $ps1 + '"'
$vbs = 'CreateObject("WScript.Shell").Run "' + ($cmd -replace '"', '""') + '", 0, False'
Set-Content -Path $vbsPath -Value $vbs -Encoding ASCII

Write-Host "Installed startup launcher:" -ForegroundColor Green
Write-Host "  $vbsPath"
Write-Host "On next login it will ensure Signal (tray + debug port) and the web server are running."
Write-Host "Remove it any time with:  npm run autostart:remove"

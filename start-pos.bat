@echo off
title BON el MOON POS Launcher
cd /d "%~dp0"

echo ====================================================
echo      BON el MOON POS - Starting Application
echo ====================================================
echo.

:: 1. Check if the server is already running and responding on port 3000
powershell -NoProfile -Command "$ErrorActionPreference='SilentlyContinue'; try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:3000' -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } } catch {}; if (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue) { exit 2 }; exit 1"
if errorlevel 2 (
  echo [!] Port 3000 is occupied. Restarting local server...
  powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Where-Object { $_.CommandLine -like '*next*start*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
  timeout /t 2 /nobreak >nul
)

:: 2. If server was not running, start it in the background
powershell -NoProfile -Command "$ErrorActionPreference='SilentlyContinue'; try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:3000' -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } } catch {}; exit 1"
if errorlevel 1 (
  echo [+] Starting BON el MOON POS Local Server...
  start "" /min node "node_modules\next\dist\bin\next" start
  
  echo [+] Waiting for server to initialize...
  powershell -NoProfile -Command "$ready = $false; for ($i=0; $i -lt 15; $i++) { try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:3000' -UseBasicParsing -TimeoutSec 1; if ($r.StatusCode -eq 200) { $ready = $true; break } } catch {}; Start-Sleep -Seconds 1 }; if (-not $ready) { Write-Host 'Warning: Server taking longer than expected to initialize.' }"
)

:: 3. Open POS in Kiosk Printing mode with dedicated profile (guarantees silent instant printing without preview dialog)
echo [+] Opening POS window with Silent Thermal Printing...
start msedge --kiosk-printing --user-data-dir="%LOCALAPPDATA%\BonElMoonPOS\edge-pos-profile" --app=http://localhost:3000 2>nul || start chrome --kiosk-printing --user-data-dir="%LOCALAPPDATA%\BonElMoonPOS\chrome-pos-profile" --app=http://localhost:3000 2>nul || start http://localhost:3000

exit
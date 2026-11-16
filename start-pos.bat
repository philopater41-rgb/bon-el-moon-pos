@echo off
title BON el MOON POS Launcher
cd /d "%~dp0"

echo ====================================================
echo      BON el MOON POS - Starting Application
echo ====================================================
echo.

:: Check the port without stopping other applications.
powershell -NoProfile -Command "try { $r = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/pos-init' -TimeoutSec 2; if (($null -ne $r.categories) -and ($null -ne $r.halls)) { exit 0 } } catch {}; if (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue) { exit 2 }; exit 1"
if errorlevel 2 (
  echo [!] Port 3000 is already used by another program.
  pause
  exit /b 1
)
if errorlevel 1 (
  echo [+] Starting POS Server...
  start "" /min node "node_modules\next\dist\bin\next" start
)

:: 3. Wait for Next.js server to start up
echo [+] Waiting for server to initialize...
timeout /t 5 /nobreak >nul

:: 4. Open POS in Kiosk Printing mode with dedicated profile (guarantees silent instant printing without preview dialog)
echo [+] Opening POS application window with Silent Thermal Printing...
start msedge --kiosk-printing --user-data-dir="%LOCALAPPDATA%\BonElMoonPOS\edge-pos-profile" --app=http://localhost:3000 2>nul || start chrome --kiosk-printing --user-data-dir="%LOCALAPPDATA%\BonElMoonPOS\chrome-pos-profile" --app=http://localhost:3000 2>nul || start http://localhost:3000

exit

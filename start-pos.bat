@echo off
title BON el MOON POS - Launcher
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:3000' -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } } catch {}; exit 1"
if errorlevel 1 (
  start "" /min node "node_modules\next\dist\bin\next" start
  timeout /t 5 /nobreak >nul
)
set "EDGE_FLAGS=--user-data-dir="%LOCALAPPDATA%\BonElMoonPOS\edge-pos-profile" --no-first-run --no-default-browser-check --disable-features=Translate --app=http://localhost:3000"
set "CHROME_FLAGS=--user-data-dir="%LOCALAPPDATA%\BonElMoonPOS\chrome-pos-profile" --no-first-run --no-default-browser-check --disable-features=Translate --app=http://localhost:3000"
start msedge %EDGE_FLAGS% 2>nul || start chrome %CHROME_FLAGS% 2>nul || start http://localhost:3000
exit

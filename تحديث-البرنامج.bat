@echo off
title BON el MOON POS - Updater
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0update-pos.ps1"
if errorlevel 1 (
  echo.
  echo [!] An error occurred during update.
  pause
)

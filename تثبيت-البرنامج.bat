@echo off
title BON el MOON POS - Installer
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-cafe-pos.ps1"
if errorlevel 1 (
  echo.
  echo [!] An error occurred during installation.
  pause
)

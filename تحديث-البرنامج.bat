@echo off
title BON el MOON - Update
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-cafe-pos.ps1"
if errorlevel 1 (echo. & echo Update failed. The old version is retained.)
pause

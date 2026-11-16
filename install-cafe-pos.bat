@echo off
title BON el MOON - Install or Update
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-cafe-pos.ps1"
if errorlevel 1 (echo. & echo Installation failed. See the message above.)
pause

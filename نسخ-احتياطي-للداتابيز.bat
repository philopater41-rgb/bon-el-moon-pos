@echo off
title BON el MOON - Database Backup
cd /d "%~dp0"

echo ====================================================
echo      BON el MOON - Local Automated Backup
echo ====================================================
echo.

node scripts/backup-db.mjs

echo.
echo ====================================================
echo   Backup finished! Check the "backups" folder.
echo ====================================================
timeout /t 5

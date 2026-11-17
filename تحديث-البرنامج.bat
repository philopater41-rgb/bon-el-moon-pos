@echo off
chcp 65001 >nul
title BON el MOON POS - تحديث البرنامج
cd /d "%~dp0"

echo ====================================================
echo       BON el MOON POS - جاري سحب أحدث التحديثات
echo ====================================================
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-cafe-pos.ps1"
if errorlevel 1 (
    echo.
    echo [!] فشل التحديث. تم الاحتفاظ بالنسخة الحالية بالكامل.
    pause
    exit /b 1
)

echo.
echo ====================================================
echo   تم التحديث بنجاح! يمكنك الآن تشغيل البرنامج.
echo ====================================================
echo.
pause
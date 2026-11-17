@echo off
chcp 65001 >nul
title BON el MOON POS - تثبيت وإعداد البرنامج
cd /d "%~dp0"

:: Auto-elevate to Administrator if not already elevated
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo [!] جاري طلب صلاحيات المسؤول (Administrator)...
    powershell -NoProfile -Command "Start-Process cmd -ArgumentList '/c \"\"%~f0\"\"' -Verb RunAs"
    exit /b
)

echo ====================================================
echo      BON el MOON POS - تثبيت وإعداد الكاشير
echo ====================================================
echo.
echo [+] جاري فحص وتثبيت المتطلبات (Node.js, Git)...
echo [+] جاري سحب أحدث نسخة وبناء البرنامج للعمل بدون نت...
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-cafe-pos.ps1"
if errorlevel 1 (
    echo.
    echo [!] حدث خطأ أثناء التثبيت.
    pause
    exit /b 1
)

echo.
echo ====================================================
echo   تم اكتمال التثبيت وتشغيل BON el MOON بنجاح!
echo ====================================================
echo.
pause
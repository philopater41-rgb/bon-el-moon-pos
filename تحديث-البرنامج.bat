@echo off
chcp 65001 >nul
title BON el MOON POS - سحب أحدث تحديثات النظام
cd /d "%~dp0"

:: Auto-elevate to Administrator if not already elevated
net session >nul 2>&1
if %errorLevel% neq 0 (
    powershell -NoProfile -Command "Start-Process cmd -ArgumentList '/c \"\"%~f0\"\"' -Verb RunAs"
    exit /b
)

echo ====================================================
echo       BON el MOON POS - جاري سحب التحديثات
echo ====================================================
echo.
echo [+] جاري الاتصال بـ GitHub وسحب آخر التعديلات...
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0update-pos.ps1"
if errorlevel 1 (
    echo.
    echo [!] حدث خطأ أثناء التحديث.
    pause
    exit /b 1
)

echo.
echo ====================================================
echo   تم التحديث وتشغيل البرنامج بنجاح!
echo ====================================================
echo.
pause
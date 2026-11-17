@echo off
chcp 65001 >nul
title BON el MOON POS - سحب أحدث تحديثات النظام
cd /d "%~dp0"

echo ====================================================
echo       BON el MOON POS - جاري سحب التحديثات
echo ====================================================
echo.
echo [+] جاري الاتصال بـ GitHub وسحب آخر التعديلات...
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0update-pos.ps1"
if errorlevel 1 (
    echo.
    echo [!] فشل التحديث. يرجى التأكد من اتصال الإنترنت والمحاولة مجدداً.
    pause
    exit /b 1
)

echo.
echo ====================================================
echo   تم التحديث وتشغيل البرنامج بنجاح!
echo ====================================================
echo.
timeout /t 5
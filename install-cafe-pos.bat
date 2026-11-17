@echo off
chcp 65001 >nul
title BON el MOON POS - تثبيت وتجهيز البرنامج
cd /d "%~dp0"

echo ====================================================
echo        BON el MOON POS - التثبيت الذكي للكاشير
echo ====================================================
echo.
echo [+] جاري فحص وتثبيت متطلبات التشغيل (Node.js LTS, Git)...
echo [+] جاري سحب أحدث نسخة وبناء البرنامج للعمل بدون إنترنت...
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-cafe-pos.ps1"
if errorlevel 1 (
    echo.
    echo [!] فشل التثبيت. يرجى مراجعة رسالة الخطأ الظاهرة أعلاه.
    pause
    exit /b 1
)

echo.
echo ====================================================
echo   تم اكتمال التثبيت بنجاح! تم إنشاء اختصار سطح المكتب.
echo ====================================================
echo.
pause
@echo off
chcp 65001 >nul
title BON el MOON POS - تثبيت وتشغيل البرنامج
cd /d "%~dp0"

echo ====================================================
echo    BON el MOON POS - المثبت الذكي والتشغيل الفوري
echo ====================================================
echo.
echo [+] جاري فحص وتثبيت متطلبات التشغيل (Node.js LTS, Git)...
echo [+] جاري سحب أحدث نسخة من السحابة وبناء النظام للعمل بدون نت...
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
echo   تم اكتمال التثبيت وتشغيل BON el MOON بنجاح!
echo ====================================================
echo.
pause
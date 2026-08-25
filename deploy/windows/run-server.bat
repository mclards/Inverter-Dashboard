@echo off
title ADSI Inverter Dashboard 2.0 — Server
cd /d "%~dp0\..\.."
echo ================================================================
echo   ADSI INVERTER DASHBOARD 2.0 — SERVER RUNNER
echo ================================================================
echo.

node -v >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Node.js is not installed or not in PATH!
    pause
    exit /b 1
)

echo Starting Inverter Dashboard 2.0 Server on Port 3500...
node backend/server.js
pause

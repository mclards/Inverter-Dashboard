@echo off
title ADSI Inverter Dashboard 2.0 — Desktop App
cd /d "%~dp0\..\.."
echo ================================================================
echo   ADSI INVERTER DASHBOARD 2.0 — DESKTOP APP
echo ================================================================
echo.

npx electron desktop/main.js

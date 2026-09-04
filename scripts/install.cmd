@echo off
REM ProcBoss (pboss) Windows CMD Installer Launcher
REM https://procboss.com
powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-Expression (Invoke-RestMethod -Uri 'https://procboss.com/install.ps1')"

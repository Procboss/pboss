@echo off
REM ProcBoss (pboss) Windows CMD Installer Launcher
REM https://procboss.com
REM No elevation required: a normal Command Prompt installs per-user
REM (%LOCALAPPDATA%\pboss + user PATH). An elevated prompt installs
REM machine-wide to %ProgramFiles%\pboss (legacy behavior).

powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-Expression (Invoke-RestMethod -Uri 'https://procboss.com/install.ps1')"

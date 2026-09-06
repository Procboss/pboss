@echo off
REM ProcBoss (pboss) Windows CMD Installer Launcher
REM https://procboss.com
REM Requires elevation: run from an Administrator Command Prompt.

net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [!] Administrator privileges are required to install pboss.
    echo     The installer compiles the executable, installs it to
    echo     %ProgramFiles%\pboss, and adds it to the system PATH.
    echo.
    echo     Right-click Command Prompt and choose "Run as Administrator",
    echo     then re-run:
    echo.
    echo         curl -fsSL https://procboss.com/install.cmd ^| cmd
    echo.
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-Expression (Invoke-RestMethod -Uri 'https://procboss.com/install.ps1')"

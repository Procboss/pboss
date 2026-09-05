# ProcBoss (pboss) Universal Installer for Windows
# https://procboss.com
# Usage (from an elevated PowerShell): powershell -c "irm https://procboss.com/install.ps1 | iex"
#
# The installer places the compiled pboss.exe in %ProgramFiles%\pboss and adds
# it to the system PATH, so it must run as Administrator. It checks for the
# required privileges itself and tells you exactly how to re-run it if
# elevation is missing.

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "  ⚡ ProcBoss (pboss) Windows Installer" -ForegroundColor Cyan
Write-Host "  https://procboss.com" -ForegroundColor DarkGray
Write-Host ""

# 1. Require Administrator privileges — the binary is installed machine-wide
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "✗ Administrator privileges are required to install pboss." -ForegroundColor Red
    Write-Host ""
    Write-Host "The installer compiles the standalone executable, installs it to" -ForegroundColor Yellow
    Write-Host "$env:ProgramFiles\pboss, and adds it to the system PATH — so it" -ForegroundColor Yellow
    Write-Host "must run elevated. To re-run it:" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  1. Right-click PowerShell (or Windows Terminal) and choose 'Run as Administrator'" -ForegroundColor Cyan
    Write-Host "  2. Run:" -ForegroundColor Cyan
    Write-Host "     powershell -c `"irm https://procboss.com/install.ps1 | iex`"" -ForegroundColor Cyan
    Write-Host ""
    exit 1
}
Write-Host "✓ Running with Administrator privileges" -ForegroundColor Green

# 2. Bun build toolchain.
#    Bun is only needed to COMPILE pboss — the final executable embeds the Bun
#    runtime, so the system does not need Bun installed once pboss is built.
$bunCmd = Get-Command bun -ErrorAction SilentlyContinue

# An elevated session may not have the user-level Bun on its PATH — check the
# default install location before deciding to (re)install.
if (-not $bunCmd) {
    $userBun = Join-Path $env:USERPROFILE ".bun\bin\bun.exe"
    if (Test-Path $userBun) {
        $env:PATH = "$(Split-Path $userBun -Parent);$env:PATH"
        $bunCmd = Get-Command bun -ErrorAction SilentlyContinue
    }
}

if (-not $bunCmd) {
    Write-Host "Bun runtime is not detected. Installing Bun..." -ForegroundColor Yellow
    Invoke-Expression (Invoke-RestMethod -Uri "https://bun.sh/install.ps1")

    $bunBinPath = Join-Path $env:USERPROFILE ".bun\bin"
    if (Test-Path $bunBinPath) {
        $env:PATH = "$bunBinPath;$env:PATH"
    }
} else {
    Write-Host "Updating Bun to the latest version..." -ForegroundColor Cyan
    try {
        & bun upgrade | Out-Null
    } catch {
        try {
            Invoke-Expression (Invoke-RestMethod -Uri "https://bun.sh/install.ps1")
        } catch {}
    }
}

$bunCmd = Get-Command bun -ErrorAction SilentlyContinue
if (-not $bunCmd) {
    Write-Host "Failed to locate Bun. Please open a new PowerShell terminal and run again." -ForegroundColor Red
    exit 1
}

$bunVersion = & bun --version
Write-Host "✓ Build toolchain ready: Bun v$bunVersion" -ForegroundColor Green

# 3. Target installation directory (machine-wide, requires elevation)
$installDir = Join-Path $env:ProgramFiles "pboss"

if (-not (Test-Path $installDir)) {
    New-Item -ItemType Directory -Path $installDir -Force | Out-Null
}

# 4. Temporary workspace: download source and compile the binary
$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("pboss-install-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tempDir -Force | Out-Null

try {
    Write-Host "Downloading latest pboss source..." -ForegroundColor Cyan
    $zipPath = Join-Path $tempDir "source.zip"
    Invoke-RestMethod -Uri "https://github.com/procboss/pboss/archive/refs/heads/main.zip" -OutFile $zipPath
    Expand-Archive -Path $zipPath -DestinationPath $tempDir -Force

    $sourceDir = Join-Path $tempDir "pboss-main"
    Set-Location $sourceDir

    Write-Host "Compiling standalone pboss executable for Windows..." -ForegroundColor Cyan
    & bun install | Out-Null

    $outputExe = Join-Path $installDir "pboss.exe"
    & bun build --compile --minify --bytecode .\src\index.ts --outfile $outputExe

    Write-Host "✓ Binary installed at $outputExe" -ForegroundColor Green
}
finally {
    Set-Location $env:USERPROFILE
    Remove-Item -Path $tempDir -Recurse -Force -ErrorAction SilentlyContinue
}

# 5. Add pboss to the system PATH (machine-wide) if needed
$machinePath = [System.Environment]::GetEnvironmentVariable("Path", [System.EnvironmentVariableTarget]::Machine)
$pathEntries = @($machinePath -split ';' | Where-Object { $_ -ne '' })

if ($pathEntries -notcontains $installDir) {
    Write-Host "Adding $installDir to the system PATH..." -ForegroundColor Yellow
    $newMachinePath = ($pathEntries + $installDir) -join ';'
    [System.Environment]::SetEnvironmentVariable("Path", $newMachinePath, [System.EnvironmentVariableTarget]::Machine)
    Write-Host "✓ Added $installDir to the system PATH" -ForegroundColor Green
}

$env:PATH = "$installDir;$env:PATH"

Write-Host ""
Write-Host "✓ ProcBoss (pboss) successfully installed to $installDir\pboss.exe!" -ForegroundColor Green
Write-Host "Open a NEW terminal (so the PATH refreshes) and run 'pboss --version' to verify." -ForegroundColor Cyan
Write-Host ""

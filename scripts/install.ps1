# ProcBoss (pboss) Universal Installer for Windows
# https://procboss.com
# Usage: powershell -c "irm https://procboss.com/install.ps1 | iex"

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "  ⚡ ProcBoss (pboss) Windows Installer" -ForegroundColor Cyan
Write-Host "  https://procboss.com" -ForegroundColor DarkGray
Write-Host ""

# 1. Check for Bun runtime; install if missing or update if present
$bunCmd = Get-Command bun -ErrorAction SilentlyContinue

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
Write-Host "✓ Ready with Bun v$bunVersion" -ForegroundColor Green

# 2. Target installation directory
$pbossHome = Join-Path $env:USERPROFILE ".pboss"
$installDir = Join-Path $pbossHome "bin"

if (-not (Test-Path $installDir)) {
    New-Item -ItemType Directory -Path $installDir -Force | Out-Null
}

# 3. Create temporary workspace and compile binary
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

    Write-Host "✓ Binary built at $outputExe" -ForegroundColor Green
}
finally {
    Set-Location $env:USERPROFILE
    Remove-Item -Path $tempDir -Recurse -Force -ErrorAction SilentlyContinue
}

# 4. Update Windows User PATH if needed
$userPath = [System.Environment]::GetEnvironmentVariable("Path", [System.EnvironmentVariableTarget]::User)
$pathEntries = $userPath -split ';'

if ($pathEntries -notcontains $installDir) {
    Write-Host "Adding $installDir to User PATH..." -ForegroundColor Yellow
    $newUserPath = ($pathEntries + $installDir) -join ';'
    [System.Environment]::SetEnvironmentVariable("Path", $newUserPath, [System.EnvironmentVariableTarget]::User)
    $env:PATH = "$installDir;$env:PATH"
    Write-Host "✓ Added $installDir to PATH" -ForegroundColor Green
}

Write-Host ""
Write-Host "✓ ProcBoss (pboss) successfully installed!" -ForegroundColor Green
Write-Host "Run 'pboss --help' in a new terminal window to get started." -ForegroundColor Cyan
Write-Host ""

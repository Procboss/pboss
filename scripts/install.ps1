# ProcBoss (pboss) Universal Installer for Windows
# https://procboss.com
# Usage: powershell -c "irm https://procboss.com/install.ps1 | iex"
#
# No Administrator required: by default the compiled pboss.exe goes to
# %LOCALAPPDATA%\pboss and is added to the USER PATH. Running the installer
# from an elevated shell still works and installs machine-wide to
# %ProgramFiles%\pboss with the system PATH (legacy behavior).

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "  ⚡ ProcBoss (pboss) Windows Installer" -ForegroundColor Cyan
Write-Host "  https://procboss.com" -ForegroundColor DarkGray
Write-Host ""

# 1. Install target — elevation only for the machine-wide legacy path.
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
$isAdmin = $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)

if ($isAdmin) {
    $installDir = Join-Path $env:ProgramFiles "pboss"
    $pathTarget = [System.EnvironmentVariableTarget]::Machine
    Write-Host "✓ Running elevated — installing machine-wide to $installDir" -ForegroundColor Green
    Write-Host "  (Administrator is NOT required: a normal shell installs per-user)" -ForegroundColor Yellow
} else {
    $installDir = Join-Path $env:LOCALAPPDATA "pboss"
    $pathTarget = [System.EnvironmentVariableTarget]::User
    Write-Host "✓ Installing per-user to $installDir — no Administrator required" -ForegroundColor Green
}

if (-not (Test-Path $installDir)) {
    New-Item -ItemType Directory -Path $installDir -Force | Out-Null
}

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

# 3. Target installation directory — created in step 1 (per-user default).

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

    # Stop a running daemon BEFORE compiling: Windows locks a running
    # executable, so `bun build --outfile $installDir\pboss.exe` fails with
    # "file in use" during an upgrade. Best-effort — the startup step at
    # the end brings the new binary back up.
    try { & schtasks /end /tn "PBOSS_Daemon" 2>$null } catch {}
    try { Stop-Process -Name "pboss" -ErrorAction SilentlyContinue } catch {}

    Write-Host "Compiling standalone pboss executable for Windows..." -ForegroundColor Cyan
    & bun install | Out-Null

    $outputExe = Join-Path $installDir "pboss.exe"
    & bun build --compile --minify --bytecode .\src\index.ts --outfile $outputExe

    Write-Host "✓ Binary installed at $outputExe" -ForegroundColor Green

    # Record the install channel — `pboss upgrade` re-runs THIS installer
    # (never npm/brew/snap) so the machine keeps exactly one pboss.
    $stampDir = Join-Path $env:USERPROFILE ".pboss"
    if (-not (Test-Path $stampDir)) {
        New-Item -ItemType Directory -Path $stampDir -Force | Out-Null
    }
    $stamp = @{
        channel    = "universal"
        by         = "install.ps1"
        stampedAt  = [int][double]::Parse((Get-Date -UFormat %s))
    } | ConvertTo-Json -Compress
    Set-Content -Path (Join-Path $stampDir "channel.json") -Value $stamp -Encoding ascii
    Write-Host "✓ Install channel recorded (universal)" -ForegroundColor Green
}
finally {
    Set-Location $env:USERPROFILE
    Remove-Item -Path $tempDir -Recurse -Force -ErrorAction SilentlyContinue
}

# 5. Add pboss to the PATH if needed — USER scope for per-user installs
#    (no elevation), Machine scope only for the elevated legacy path.
$scopePath = [System.Environment]::GetEnvironmentVariable("Path", $pathTarget)
$pathEntries = @($scopePath -split ';' | Where-Object { $_ -ne '' })

if ($pathEntries -notcontains $installDir) {
    Write-Host "Adding $installDir to the $pathTarget PATH..." -ForegroundColor Yellow
    $newPath = ($pathEntries + $installDir) -join ';'
    [System.Environment]::SetEnvironmentVariable("Path", $newPath, $pathTarget)
    Write-Host "✓ Added $installDir to the $pathTarget PATH" -ForegroundColor Green
}

$env:PATH = "$installDir;$env:PATH"

# 6. Boot persistence — installed automatically.
#    The whole point of pboss: processes survive reboots by default. The
#    Scheduled Task (PBOSS_Daemon) starts the daemon at THIS user's logon,
#    and the daemon resurrects the saved process list (auto-saved after every
#    pboss start/stop/delete). Best-effort: a failure prints the manual
#    command instead of failing the install.
Write-Host "Enabling boot persistence..." -ForegroundColor Cyan
try {
    # USERNAME identifies the invoking user even in the elevated session, so
    # the task fires at THEIR logon, running under their profile.
    & "$installDir\pboss.exe" startup install
    if ($LASTEXITCODE -eq 0) {
        Write-Host "✓ Boot persistence enabled — pboss starts at logon and resurrects saved processes." -ForegroundColor Green
    } else {
        Write-Host "⚠ Boot persistence could not be configured automatically (exit $LASTEXITCODE)." -ForegroundColor Yellow
        Write-Host "  Run it yourself:  pboss startup install" -ForegroundColor Cyan
    }
} catch {
    Write-Host "⚠ Boot persistence could not be configured automatically." -ForegroundColor Yellow
    Write-Host "  Run it yourself:  pboss startup install" -ForegroundColor Cyan
}

# Existing cloud link — the machine credential in ~\.pboss\cloud.json is the
# permanent cache: it outlives the binary across deletes, reinstalls and
# upgrades. The step above (re)started the daemon, which resumes the link.
# Say so instead of making a reinstalled machine look unlinked.
$cloudCred = Join-Path $env:USERPROFILE ".pboss\cloud.json"
if (Test-Path $cloudCred) {
    Write-Host "✓ Existing cloud link detected — the daemon will resume it automatically." -ForegroundColor Green
    Write-Host "  Check its state:  pboss cloud status" -ForegroundColor Cyan
}

Write-Host ""
Write-Host "✓ ProcBoss (pboss) successfully installed to $installDir\pboss.exe!" -ForegroundColor Green
Write-Host "Open a NEW terminal (so the PATH refreshes) and run 'pboss --version' to verify." -ForegroundColor Cyan
Write-Host ""

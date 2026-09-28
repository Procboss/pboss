# ProcBoss (pboss) Universal Installer for Windows
# https://procboss.com
# Usage: powershell -c "irm https://procboss.com/install.ps1 | iex"
#
# ProcBoss is runtime-agnostic: it runs under Bun, Node.js or Deno, using
# each runtime's native APIs. This installer has exactly ONE
# runtime-related responsibility:
#
#   Ensure at least one supported runtime exists on the machine.
#     - Bun OR Node OR Deno present  ->  do nothing, install nothing
#     - none present                 ->  install Bun
#
# It NEVER selects a runtime, NEVER persists a runtime preference, and
# NEVER compiles anything — pboss is installed from the PUBLISHED npm
# package, globally. The runtime executing `pboss` is decided at
# execution time. Shell and PowerShell installers share this policy.
#
# No Administrator required.

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "  ⚡ ProcBoss (pboss) Windows Installer" -ForegroundColor Cyan
Write-Host "  https://procboss.com" -ForegroundColor DarkGray
Write-Host ""

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
$isAdmin = $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)

# 1. Runtime presence — ANY ONE of Bun / Node / Deno is enough.
#    Multiple runtimes are NOT a conflict; nothing is chosen here.
$bunCmd = Get-Command bun -ErrorAction SilentlyContinue
# An elevated session may not have the user-level Bun on its PATH — check
# the default install location before deciding it is absent.
if (-not $bunCmd) {
    $userBun = Join-Path $env:USERPROFILE ".bun\bin\bun.exe"
    if (Test-Path $userBun) {
        $env:PATH = "$(Split-Path $userBun -Parent);$env:PATH"
        $bunCmd = Get-Command bun -ErrorAction SilentlyContinue
    }
}
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
$denoCmd = Get-Command deno -ErrorAction SilentlyContinue

Write-Host "Runtime check — pboss runs under Bun, Node.js or Deno:" -ForegroundColor Cyan
if ($bunCmd)  { Write-Host "  ✓ Bun found    ($($bunCmd.Source))" -ForegroundColor Green } else { Write-Host "  · Bun not found" -ForegroundColor Yellow }
if ($nodeCmd) { Write-Host "  ✓ Node found   ($($nodeCmd.Source))" -ForegroundColor Green } else { Write-Host "  · Node not found" -ForegroundColor Yellow }
if ($denoCmd) { Write-Host "  ✓ Deno found   ($($denoCmd.Source))" -ForegroundColor Green } else { Write-Host "  · Deno not found" -ForegroundColor Yellow }

# None at all -> install Bun (the ONLY runtime-side effect this script has).
if (-not ($bunCmd -or $nodeCmd -or $denoCmd)) {
    Write-Host "No supported runtime found — installing Bun (https://bun.sh)..." -ForegroundColor Yellow
    Invoke-Expression (Invoke-RestMethod -Uri "https://bun.sh/install.ps1")

    $bunBinPath = Join-Path $env:USERPROFILE ".bun\bin"
    if (Test-Path $bunBinPath) {
        $env:PATH = "$bunBinPath;$env:PATH"
    }
    $bunCmd = Get-Command bun -ErrorAction SilentlyContinue
    if (-not $bunCmd) {
        Write-Host "✗ Failed to install Bun." -ForegroundColor Red
        Write-Host "Install any one runtime manually and re-run:"
        Write-Host "  https://bun.sh  ·  https://nodejs.org  ·  https://deno.com" -ForegroundColor Cyan
        exit 1
    }
    Write-Host "✓ Bun installed — pboss will run under it until you choose otherwise." -ForegroundColor Green
} else {
    Write-Host "✓ A supported runtime is present — nothing installed, nothing selected." -ForegroundColor Green
}

# 2. Install the published pboss package, GLOBALLY. The package-manager
#    choice installs ONLY the npm package — it is not a runtime selection
#    and nothing is persisted. Preference: bun (user-writable global) >
#    npm > deno. PBOSS_VERSION pins the exact release for `pboss upgrade`.
$pkgSpec = "pboss"
if ($env:PBOSS_VERSION) { $pkgSpec = "pboss@$($env:PBOSS_VERSION)" }
$pmBinDir = ""
$pmChoice = ""
$npmCmd = Get-Command npm -ErrorAction SilentlyContinue

if ($bunCmd) {
    $pmChoice = "bun"
    Write-Host "Installing the published pboss package globally (bun install -g $pkgSpec)..." -ForegroundColor Cyan
    & bun install -g $pkgSpec
    if ($LASTEXITCODE -ne 0) {
        Write-Host "✗ bun install -g failed." -ForegroundColor Red
        exit 1
    }
    $pmBinDir = Join-Path $env:USERPROFILE ".bun\bin"
} elseif ($npmCmd) {
    $pmChoice = "npm"
    Write-Host "Installing the published pboss package globally (npm install -g $pkgSpec)..." -ForegroundColor Cyan
    & npm install -g $pkgSpec
    if ($LASTEXITCODE -ne 0) {
        Write-Host "✗ npm install -g failed." -ForegroundColor Red
        exit 1
    }
    $npmPrefix = (& npm config get prefix)
    $pmBinDir = $npmPrefix
} elseif ($denoCmd) {
    $pmChoice = "deno"
    Write-Host "Installing the published pboss package globally (deno install -g npm:$pkgSpec)..." -ForegroundColor Cyan
    & deno install -g "npm:$pkgSpec"
    if ($LASTEXITCODE -ne 0) {
        Write-Host "✗ deno install -g failed." -ForegroundColor Red
        exit 1
    }
    $pmBinDir = Join-Path $env:USERPROFILE ".deno\bin"
} else {
    Write-Host "✗ No package manager available to install the pboss package (bun/npm/deno)." -ForegroundColor Red
    exit 1
}

if ($pmBinDir) { $env:PATH = "$pmBinDir;$env:PATH" }

# 3. Verify — `pboss` must answer.
$pbossBin = (Get-Command pboss -ErrorAction SilentlyContinue).Source
if (-not $pbossBin -and $pmBinDir) {
    $candidate = Join-Path $pmBinDir "pboss"
    if (Test-Path "$candidate.cmd") { $pbossBin = "$candidate.cmd" }
    elseif (Test-Path "$candidate.ps1") { $pbossBin = "$candidate.ps1" }
    elseif (Test-Path $candidate) { $pbossBin = $candidate }
}
if (-not $pbossBin) {
    Write-Host "✗ pboss did not become available after the install." -ForegroundColor Red
    Write-Host "  Package manager: $pmChoice; expected bin in: $pmBinDir"
    Write-Host "  Open a NEW terminal (PATH heals below) and run:  pboss --version"
    exit 1
}
$installedV = (& pboss --version 2>$null | ForEach-Object { $_.Split(' ')[-1] }) -replace 'v', ''
Write-Host "✓ pboss is available: $pbossBin" -ForegroundColor Green

# 3b. Record the install channel — `pboss upgrade` re-runs THIS installer.
$stampDir = Join-Path $env:USERPROFILE ".pboss"
if (-not (Test-Path $stampDir)) {
    New-Item -ItemType Directory -Path $stampDir -Force | Out-Null
}
$stamp = @{
    channel   = "universal"
    by        = "install.ps1"
    stampedAt = [int][double]::Parse((Get-Date -UFormat %s))
} | ConvertTo-Json -Compress
Set-Content -Path (Join-Path $stampDir "channel.json") -Value $stamp -Encoding ascii
Write-Host "✓ Install channel recorded (universal)" -ForegroundColor Green

# 4. Add the package-manager bin dir to the PATH if needed — USER scope
#    for per-user installs (no elevation), Machine scope only for the
#    elevated legacy path.
$pathTarget = if ($isAdmin) { [System.EnvironmentVariableTarget]::Machine } else { [System.EnvironmentVariableTarget]::User }
if ($pmBinDir) {
    $scopePath = [System.Environment]::GetEnvironmentVariable("Path", $pathTarget)
    $pathEntries = @($scopePath -split ';' | Where-Object { $_ -ne '' })
    if ($pathEntries -notcontains $pmBinDir) {
        Write-Host "Adding $pmBinDir to the $pathTarget PATH..." -ForegroundColor Yellow
        $newPath = ($pathEntries + $pmBinDir) -join ';'
        [System.Environment]::SetEnvironmentVariable("Path", $newPath, $pathTarget)
        Write-Host "✓ Added $pmBinDir to the $pathTarget PATH" -ForegroundColor Green
    }
    $env:PATH = "$pmBinDir;$env:PATH"
}

# 5. Boot persistence — installed automatically, best-effort.
Write-Host "Enabling boot persistence..." -ForegroundColor Cyan
try {
    & pboss startup install
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
# permanent cache: it outlives the package across deletes, reinstalls and
# upgrades.
$cloudCred = Join-Path $env:USERPROFILE ".pboss\cloud.json"
if (Test-Path $cloudCred) {
    Write-Host "✓ Existing cloud link detected — the daemon will resume it automatically." -ForegroundColor Green
    Write-Host "  Check its state:  pboss cloud status" -ForegroundColor Cyan
}

Write-Host ""
if ($installedV) {
    Write-Host "✓ ProcBoss (pboss) v$installedV successfully installed!" -ForegroundColor Green
} else {
    Write-Host "✓ ProcBoss (pboss) successfully installed!" -ForegroundColor Green
}
# Which runtime is ACTUALLY executing pboss right now — a report, not a choice.
Write-Host "Executing runtime:  $(& pboss --runtime 2>$null)" -ForegroundColor Cyan
Write-Host "Open a NEW terminal (so the PATH refreshes) and run 'pboss --version' to verify." -ForegroundColor Cyan
Write-Host ""

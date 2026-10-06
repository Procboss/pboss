# ProcBoss (pboss) Universal Installer for Windows
# https://procboss.com
# Usage: powershell -c "irm https://procboss.com/install.ps1 | iex"
# Explicit runtime (inside PowerShell):
#   iex "& { $(irm https://procboss.com/install.ps1) } -Runtime node"
#   (node | bun | deno — the $() interpolates the script into the
#   scriptblock so & can bind -Runtime to its param(); without it the
#   script downloads but never executes. From cmd.exe or the Run box,
#   wrap the same payload in single quotes:
#   powershell -c "iex '& { $(irm https://procboss.com/install.ps1) } -Runtime node'")
#
# RUNTIME-AWARE ARCHITECTURE (the contract this installer implements):
#
#   The USER selects the runtime — explicitly (-Runtime) or through the
#   interactive prompt (Node is the default; Enter picks it). The selection
#   is persisted by pboss itself into ~\.pboss\.runtime and stays there
#   across upgrades until `pboss runtime change` says otherwise.
#
#   This installer NEVER infers a runtime from whatever happens to be
#   installed. The selected runtime is authoritative: if the user chose Bun
#   and only Node exists, Bun gets installed and used.
#
#   It installs the PUBLISHED package from the registry through the selected
#   runtime's own package ecosystem (npm / bun / deno) — never a git clone,
#   never a source build — then installs the pboss.cmd / pboss.ps1 wrapper
#   shims onto PATH (plain npm on Windows regenerates cmd shims that cannot
#   run the shell wrapper; the ProcBoss shims invoke PowerShell instead).
#
# No Administrator required.

param(
    [string]$Runtime = ""
)

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "  ⚡ ProcBoss (pboss) Windows Installer" -ForegroundColor Cyan
Write-Host "  https://procboss.com" -ForegroundColor DarkGray
Write-Host ""

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
$isAdmin = $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)

$pbossHomeDir = if ($env:PBOSS_HOME) { $env:PBOSS_HOME } else { Join-Path $env:USERPROFILE ".pboss" }
$runtimeFile = Join-Path $pbossHomeDir ".runtime"

function Normalize-Runtime([string]$value) {
    if ($null -eq $value) { return "" }
    return $value.Trim().ToLower()
}

function Test-Runtime([string]$value) {
    $n = Normalize-Runtime $value
    return ($n -eq "node" -or $n -eq "bun" -or $n -eq "deno")
}

# ── 1. Runtime selection: -Runtime, or the interactive prompt ─────────────
$selected = Normalize-Runtime $Runtime
if ($selected -and -not (Test-Runtime $selected)) {
    Write-Host "Unsupported runtime: $Runtime" -ForegroundColor Red
    Write-Host ""
    Write-Host "Supported runtimes:"
    Write-Host "  node"
    Write-Host "  bun"
    Write-Host "  deno"
    exit 1
}

if (-not $selected) {
    $interactive = [Environment]::UserInteractive -and -not [Console]::IsInputRedirected
    if (-not $interactive) {
        Write-Host "ProcBoss needs a runtime selection." -ForegroundColor Red
        Write-Host ""
        Write-Host "Run the installer with one of:" 
        Write-Host ""
        Write-Host "  -Runtime node"
        Write-Host "  -Runtime bun"
        Write-Host "  -Runtime deno"
        Write-Host ""
        exit 1
    }
    Write-Host "Kindly select your runtime:"
    Write-Host ""
    Write-Host "  1. Node"
    Write-Host "  2. Bun"
    Write-Host "  3. Deno"
    Write-Host ""
    $answer = Read-Host "Select runtime [1]"
    switch -Regex ($answer.Trim().ToLower()) {
        "^(|1|node)$" { $selected = "node" }
        "^(2|bun)$" { $selected = "bun" }
        "^(3|deno)$" { $selected = "deno" }
        default {
            Write-Host "Unsupported runtime: $answer" -ForegroundColor Red
            Write-Host ""
            Write-Host "Supported runtimes:"
            Write-Host "  node"
            Write-Host "  bun"
            Write-Host "  deno"
            exit 1
        }
    }
}

Write-Host "Selected runtime: $selected" -ForegroundColor Green

# ── 2. Ensure the selected runtime exists — install it when missing ──────
function Find-Runtime([string]$name) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    # Well-known per-user locations (a PATH not yet healed by the shell).
    $candidates = @{
        bun  = Join-Path $env:USERPROFILE ".bun\bin\bun.exe"
        deno = Join-Path $env:USERPROFILE ".deno\bin\deno.exe"
        node = Join-Path $env:USERPROFILE ".local\bin\node.exe"
    }
    if (Test-Path $candidates[$name]) { return $candidates[$name] }
    return $null
}

$runtimeBin = Find-Runtime $selected
if ($runtimeBin) {
    Write-Host "✓ $selected found ($runtimeBin)" -ForegroundColor Green
} else {
    Write-Host "ProcBoss requires $selected, but $selected was not found." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Attempting to install $selected..." -ForegroundColor Yellow
    Write-Host ""
    switch ($selected) {
        "bun" {
            Invoke-Expression (Invoke-RestMethod -Uri "https://bun.sh/install.ps1")
            $bunBin = Join-Path $env:USERPROFILE ".bun\bin"
            if (Test-Path $bunBin) { $env:PATH = "$bunBin;$env:PATH" }
        }
        "deno" {
            Invoke-Expression (Invoke-RestMethod -Uri "https://deno.land/install.ps1")
            $denoBin = Join-Path $env:USERPROFILE ".deno\bin"
            if (Test-Path $denoBin) { $env:PATH = "$denoBin;$env:PATH" }
        }
        "node" {
            # No official one-line installer: download the official zip and
            # unpack rootlessly into ~\.pboss\runtimes\node, shims in ~\.pboss\bin.
            $dist = "https://nodejs.org/dist/latest-v22.x"
            $listing = (Invoke-WebRequest -Uri "$dist/" -UseBasicParsing).Content
            $arch = if ([Environment]::Is64BitOperatingSystem) {
                if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "win-arm64" } else { "win-x64" }
            } else { $null }
            if (-not $arch) {
                Write-Host "Unable to install Node.js automatically on this architecture." -ForegroundColor Red
                Write-Host "Please install Node.js from https://nodejs.org and re-run." -ForegroundColor Red
                exit 1
            }
            if ($listing -notmatch "node-v(\d+\.\d+\.\d+)-$arch\.zip") {
                Write-Host "Unable to install Node.js automatically (could not read the dist listing)." -ForegroundColor Red
                Write-Host "Please install Node.js from https://nodejs.org and re-run." -ForegroundColor Red
                exit 1
            }
            $nodeVersion = $Matches[1]
            $zipName = "node-v$nodeVersion-$arch.zip"
            $nodeRoot = Join-Path $pbossHomeDir "runtimes\node"
            $nodeBinDir = Join-Path $pbossHomeDir "bin"
            $tmpZip = Join-Path $env:TEMP $zipName
            Invoke-WebRequest -Uri "$dist/$zipName" -OutFile $tmpZip -UseBasicParsing
            Expand-Archive -Path $tmpZip -DestinationPath "$nodeRoot-tmp" -Force
            if (Test-Path $nodeRoot) { Remove-Item -Recurse -Force $nodeRoot }
            Move-Item (Join-Path "$nodeRoot-tmp" "node-v$nodeVersion-$arch") $nodeRoot
            Remove-Item -Recurse -Force "$nodeRoot-tmp"
            New-Item -ItemType Directory -Path $nodeBinDir -Force | Out-Null
            foreach ($b in @("node.exe", "npm.cmd", "npx.cmd", "corepack.cmd")) {
                $src = Join-Path $nodeRoot $b
                if (Test-Path $src) {
                    $dst = Join-Path $nodeBinDir $b
                    if (Test-Path $dst) { Remove-Item -Force $dst }
                    Copy-Item $src $dst
                }
            }
            Remove-Item -Force $tmpZip
            $env:PATH = "$nodeBinDir;$env:PATH"
            $runtimeBin = Join-Path $nodeBinDir "node.exe"
        }
    }
    $runtimeBin = Find-Runtime $selected
    if (-not $runtimeBin) {
        Write-Host "Unable to install $selected automatically." -ForegroundColor Red
        Write-Host ""
        Write-Host "Please install $selected and run:"
        Write-Host ""
        Write-Host "  pboss runtime change"
        Write-Host ""
        exit 1
    }
    Write-Host "✓ $selected installed ($runtimeBin)" -ForegroundColor Green
}

# ── 3. Install the PUBLISHED pboss package through the runtime's own ──────
#    package ecosystem (never a clone, never a source build).
$pkgSpec = "pboss"
if ($env:PBOSS_VERSION) { $pkgSpec = "pboss@$($env:PBOSS_VERSION)" }
$pmBinDir = ""
$pmChoice = ""

switch ($selected) {
    "node" {
        $pmChoice = "npm"
        Write-Host "Installing the published pboss package globally (npm install -g $pkgSpec)..." -ForegroundColor Cyan
        & npm install -g $pkgSpec
        if ($LASTEXITCODE -ne 0) { Write-Host "✗ npm install -g failed." -ForegroundColor Red; exit 1 }
        $npmPrefix = (& npm config get prefix)
        $pmBinDir = $npmPrefix
    }
    "bun" {
        $pmChoice = "bun"
        # Heal Bun's global state FIRST: a `bun add -g .` run inside a
        # package directory leaves a nameless ("") entry in Bun's global
        # package.json, and from Bun 1.4 on every later `bun install -g`
        # (any package) dies with "refusing to install dependency with
        # unsafe name". The machine looks broken; only this state is.
        $bunHome = if ($env:BUN_INSTALL) { $env:BUN_INSTALL } else { Join-Path $env:USERPROFILE ".bun" }
        $bunGlobalPkg = Join-Path $bunHome "install\global\package.json"
        if (Test-Path $bunGlobalPkg) {
            $bunGlobalRaw = Get-Content $bunGlobalPkg -Raw
            if ($bunGlobalRaw -match '""\s*:') {
                Write-Host "Detected a corrupted Bun global state: $bunGlobalPkg has a nameless (`"`") entry." -ForegroundColor Yellow
                Write-Host "(It comes from a 'bun add -g .' inside a package directory — every later 'bun install -g' fails with 'refusing to install dependency with unsafe name' until healed.)" -ForegroundColor Yellow
                try {
                    $bunPkgJson = $bunGlobalRaw | ConvertFrom-Json
                    if ($bunPkgJson.dependencies -and $bunPkgJson.dependencies.PSObject.Properties[""]) {
                        $bunPkgJson.dependencies.PSObject.Properties.Remove("")
                    }
                    $bunPkgJson | ConvertTo-Json -Depth 10 | Set-Content -Path $bunGlobalPkg -Encoding utf8
                    $bunGlobalLock = Join-Path $bunHome "install\global\bun.lock"
                    if (Test-Path $bunGlobalLock) { Remove-Item $bunGlobalLock -Force }
                    Write-Host "✓ Bun global state healed (the invalid entry and the stale lockfile are gone)." -ForegroundColor Green
                } catch {
                    Write-Host "⚠ Could not heal it automatically ($($_.Exception.Message))." -ForegroundColor Yellow
                    Write-Host "  Fix it manually: edit $bunGlobalPkg, delete the `"`" line, delete bun.lock beside it, re-run." -ForegroundColor Yellow
                }
            }
        }
        Write-Host "Installing the published pboss package globally (bun install -g $pkgSpec)..." -ForegroundColor Cyan
        & bun install -g $pkgSpec
        if ($LASTEXITCODE -ne 0) {
            # npm fallback — the wrapper still dispatches to Bun at run time;
            # npm is only the delivery vehicle. The channel stamp records npm
            # because that is what can upgrade pboss on this machine.
            $npmCmd = Get-Command npm -ErrorAction SilentlyContinue
            if ($npmCmd) {
                Write-Host "⚠ bun install -g failed — falling back to npm (pboss still runs on Bun; the runtime selection is unchanged)." -ForegroundColor Yellow
                & npm install -g $pkgSpec
                if ($LASTEXITCODE -ne 0) { Write-Host "✗ npm install -g failed." -ForegroundColor Red; exit 1 }
                $pmChoice = "npm"
                $pmBinDir = (& npm config get prefix)
            } else {
                Write-Host "✗ bun install -g failed, and npm was not found to fall back on." -ForegroundColor Red
                Write-Host ""
                Write-Host "Bun's global state may still be corrupted. Fix it manually and re-run:"
                Write-Host "  1. Edit  $bunGlobalPkg  and delete the nameless (`"`") line"
                Write-Host "  2. Delete  $(Join-Path $bunHome 'install\global\bun.lock')"
                Write-Host "  3. Re-run this installer"
                exit 1
            }
        } else {
            $pmBinDir = Join-Path $env:USERPROFILE ".bun\bin"
        }
    }
    "deno" {
        $pmChoice = "deno"
        # Deno executes package bins as modules — the .sh wrapper cannot
        # serve that path — so deno installs the published entry subpath.
        #
        # Version policy — Deno's 24-hour supply-chain window rejects npm
        # versions published within the last day (ranges fall back
        # silently, exact pins error), so a naive unpinned npm:pboss
        # installs the PREVIOUS release (and before 1.6.0, one without
        # ./deno-entry — a broken shim). Deno ships its own escape hatch:
        # --minimum-dependency-age=0 disables the hold for this
        # resolution. When the local deno knows the flag (probed from its
        # own help text — never version-parsed), the spec is pinned to the
        # registry's TRUE latest and fresh installs get the current
        # release immediately. Older denos keep the window-aware pin.
        # Every deno install also carries --reload --force (2026-10-06):
        # a stale cached packument keeps serving the previous resolution
        # even past the hold, so --reload re-resolves against the live
        # registry, and --force overwrites an existing pboss installation
        # — the same command installs, reinstalls, and upgrades in place.
        $denoSpec = "npm:pboss/deno-entry"
        $denoPinSet = $false
        $denoAgeFlag = $null
        try {
            $denoHelp = (& deno install --help 2>&1 | Out-String)
            if ($denoHelp -match "--min-dep-age") { $denoAgeFlag = "--minimum-dependency-age=0" }
        } catch { $denoAgeFlag = $null }
        if ($pkgSpec -ne "pboss") {
            # An explicit PBOSS_VERSION is the user's own pin — honored
            # as-is (the flag keeps a freshly published pin installable).
            $denoSpec = "npm:pboss@$($pkgSpec.Split('@')[1])/deno-entry"
            $denoPinSet = $true
            if ($denoAgeFlag) {
                Write-Host "Installing the published pboss package globally (deno install -g $denoAgeFlag --reload --force $denoSpec)..." -ForegroundColor Cyan
            } else {
                Write-Host "Installing the published pboss package globally (deno install -g --reload --force $denoSpec)..." -ForegroundColor Cyan
            }
        } elseif ($denoAgeFlag) {
            # Deno >= 2.9: the age hold is disabled for this resolution —
            # install the registry's latest, not yesterday's fallback.
            $denoLatest = $null
            try {
                $packument = Invoke-RestMethod -Uri "https://registry.npmjs.org/pboss" -TimeoutSec 15
                $denoLatest = $packument.'dist-tags'.latest
            } catch { $denoLatest = $null }
            if ($denoLatest) {
                $denoSpec = "npm:pboss@$denoLatest/deno-entry"
                $denoPinSet = $true
                Write-Host "Installing the published pboss package globally (deno install -g $denoAgeFlag --reload --force $denoSpec)..." -ForegroundColor Cyan
                Write-Host "Deno's 24-hour supply-chain hold is bypassed for this install — v$denoLatest is the newest release." -ForegroundColor Yellow
            } else {
                # Registry unreachable, but the flag still beats the silent
                # fallback to an older version.
                Write-Host "Installing the published pboss package globally (deno install -g $denoAgeFlag --reload --force $denoSpec)..." -ForegroundColor Cyan
                Write-Host "Could not read the registry ahead of the install — installing the unpinned spec with Deno's age hold disabled." -ForegroundColor Yellow
            }
        } else {
            # Older deno — the window-aware pin.
            $denoBest = $null
            $denoLatest = $null
            $denoLatestEpoch = $null
            $denoRegistryOk = $false
            try {
                $packument = Invoke-RestMethod -Uri "https://registry.npmjs.org/pboss" -TimeoutSec 15
                $denoRegistryOk = $true
                $cutoff = [DateTimeOffset]::UtcNow.AddHours(-25).ToUnixTimeSeconds()
                $denoLatest = $packument.'dist-tags'.latest
                foreach ($prop in $packument.time.PSObject.Properties) {
                    if ($prop.Name -notmatch '^\d+\.\d+\.\d+$') { continue }
                    $epoch = [DateTimeOffset]::Parse($prop.Value).ToUnixTimeSeconds()
                    if ($epoch -gt $cutoff) { continue }
                    if ([version]$prop.Name -lt [version]"1.6.0") { continue }
                    if (-not $denoBest -or [version]$prop.Name -gt [version]$denoBest) { $denoBest = $prop.Name }
                }
                if ($denoLatest -and $packument.time.$denoLatest) {
                    $denoLatestEpoch = [DateTimeOffset]::Parse($packument.time.$denoLatest).ToUnixTimeSeconds()
                }
            } catch {
                $denoRegistryOk = $false
            }

            if ($denoBest) {
                $denoSpec = "npm:pboss@$denoBest/deno-entry"
                $denoPinSet = $true
                if ($denoLatest -and $denoBest -ne $denoLatest) {
                    Write-Host "Deno's 24-hour supply-chain hold: installing v$denoBest (latest is v$denoLatest)." -ForegroundColor Yellow
                }
            } elseif ($denoRegistryOk) {
                # No deno-resolvable version exports ./deno-entry yet — the
                # one-time transition after a deno-support release. npm
                # delivers the package; the wrapper shims dispatch to Deno
                # at run time; the selection stays deno.
                $holdText = "within the next 24 hours"
                if ($denoLatestEpoch) {
                    $holdText = [DateTimeOffset]::FromUnixTimeSeconds($denoLatestEpoch + 90000).UtcDateTime.ToString("yyyy-MM-dd HH:mm UTC")
                }
                Write-Host "Deno's 24-hour supply-chain protection is holding back every pboss version that supports Deno" -ForegroundColor Yellow
                Write-Host "  (latest v$denoLatest becomes resolvable $holdText)." -ForegroundColor Yellow
                Write-Host "  Tip: upgrade Deno (deno upgrade) — current releases install the newest pboss immediately." -ForegroundColor Yellow
                $npmCmd = Get-Command npm -ErrorAction SilentlyContinue
                if ($npmCmd) {
                    Write-Host "  Falling back to npm as the delivery vehicle — pboss still RUNS on Deno (the runtime selection stays deno)." -ForegroundColor Yellow
                    & npm install -g $pkgSpec
                    if ($LASTEXITCODE -ne 0) { Write-Host "npm install -g failed." -ForegroundColor Red; exit 1 }
                    $pmChoice = "npm"
                    $pmBinDir = (& npm config get prefix)
                } else {
                    Write-Host "npm was not found to fall back on. Re-run this installer after $holdText, or use -Runtime node|bun now." -ForegroundColor Red
                    exit 1
                }
            } else {
                Write-Host "Could not read the registry ahead of the install — installing the unpinned spec; Deno may resolve an older version." -ForegroundColor Yellow
            }
        }
        if ($pmChoice -eq "deno") {
            if ($denoAgeFlag) {
                & deno install -g -A $denoAgeFlag --name pboss --reload --force $denoSpec
            } else {
                & deno install -g -A --name pboss --reload --force $denoSpec
            }
            if ($LASTEXITCODE -ne 0) { Write-Host "✗ deno install -g failed." -ForegroundColor Red; exit 1 }
            $pmBinDir = Join-Path $env:USERPROFILE ".deno\bin"
        }
    }
}

if ($pmBinDir -and (Test-Path $pmBinDir)) { $env:PATH = "$pmBinDir;$env:PATH" }

# ── 4. Install the ProcBoss wrapper shims onto PATH ──────────────────────
# Plain npm on Windows generates its own pboss.cmd from the .sh bin — which
# cannot run without a shell. The ProcBoss shims invoke PowerShell instead:
#   pboss.cmd — a two-line bootstrap that runs pboss.ps1 (the wrapper twin)
#   pboss.ps1 — the real wrapper (copied from the installed package's bin/)
# Skipped ONLY on the pure-deno delivery (deno's own --name pboss shim runs
# the entry module directly); the deno→npm fallback NEEDS the shims.
if (-not ($selected -eq "deno" -and $pmChoice -eq "deno")) {
    $pkgDir = $null
    try {
        # npm root -g → node_modules; the package sits under pboss\
        if ($pmChoice -eq "npm") {
            $npmRoot = (& npm root -g)
            if ($npmRoot -and (Test-Path (Join-Path $npmRoot "pboss\bin\pboss.ps1"))) {
                $pkgDir = Join-Path $npmRoot "pboss"
            }
        } elseif ($pmChoice -eq "bun") {
            $bunRoot = Join-Path $env:USERPROFILE ".bun\install\global\node_modules\pboss"
            if (Test-Path (Join-Path $bunRoot "bin\pboss.ps1")) { $pkgDir = $bunRoot }
        }
        if ($pkgDir -and $pmBinDir -and (Test-Path $pmBinDir)) {
            $wrapperPs1 = Join-Path $pkgDir "bin\pboss.ps1"
            $targetPs1 = Join-Path $pmBinDir "pboss.ps1"
            Copy-Item $wrapperPs1 $targetPs1 -Force
            $cmdShim = "@echo off`r`npowershell -NoProfile -ExecutionPolicy Bypass -File `"%~dp0pboss.ps1`" %*`r`n"
            Set-Content -Path (Join-Path $pmBinDir "pboss.cmd") -Value $cmdShim -Encoding ascii
            Write-Host "✓ ProcBoss wrapper shims installed ($pmBinDir\pboss.cmd → pboss.ps1)" -ForegroundColor Green
        }
    } catch {
        Write-Host "⚠ Could not install the wrapper shims: $($_.Exception.Message)" -ForegroundColor Yellow
        Write-Host "  pboss will still run via: powershell -File <package>\bin\pboss.ps1" -ForegroundColor Yellow
    }
}

# ── 5. Verify + initialize the persistent runtime selection ─────────────
$pbossBin = (Get-Command pboss -ErrorAction SilentlyContinue).Source
if (-not $pbossBin -and $pmBinDir) {
    foreach ($cand in @("pboss.cmd", "pboss.ps1", "pboss")) {
        $p = Join-Path $pmBinDir $cand
        if (Test-Path $p) { $pbossBin = $p; break }
    }
}
if (-not $pbossBin) {
    Write-Host "✗ pboss did not become available after the install." -ForegroundColor Red
    Write-Host "  Package manager: $pmChoice; expected bin in: $pmBinDir"
    Write-Host "  Open a NEW terminal (PATH heals below) and run:  pboss --version"
    exit 1
}

Write-Host "Initializing the runtime selection..." -ForegroundColor Cyan
& $pbossBin --runtime=$selected --version | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host "⚠ Could not initialize the runtime selection — run:  pboss --runtime=$selected" -ForegroundColor Yellow
}
if ((Test-Path $runtimeFile) -and ((Get-Content $runtimeFile -Raw).Trim().ToLower() -eq $selected)) {
    Write-Host "✓ Runtime persisted: $selected ($runtimeFile)" -ForegroundColor Green
}

$installedV = (& $pbossBin --version 2>$null | ForEach-Object { $_.Split(' ')[-1] }) -replace 'v', ''
Write-Host "✓ pboss is available: $pbossBin" -ForegroundColor Green

# ── 6. Record the install channel — `pboss upgrade` upgrades in place ────
if (-not (Test-Path $pbossHomeDir)) {
    New-Item -ItemType Directory -Path $pbossHomeDir -Force | Out-Null
}
$stamp = @{
    channel   = "universal"
    pm         = $pmChoice
    by         = "install.ps1"
    stampedAt  = [int][double]::Parse((Get-Date -UFormat %s))
} | ConvertTo-Json -Compress
Set-Content -Path (Join-Path $pbossHomeDir "channel.json") -Value $stamp -Encoding ascii
Write-Host "✓ Install channel recorded (universal)" -ForegroundColor Green

# ── 7. Add the bin dir to the user PATH if needed (no elevation) ──────────
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

# ── 8. Boot persistence — best-effort, per-user, no elevation ────────────
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

# Existing cloud link — the permanent machine credential.
$cloudCred = Join-Path $pbossHomeDir "cloud.json"
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
Write-Host "Runtime:  $selected (persisted to $runtimeFile)" -ForegroundColor Cyan
Write-Host "Change it any time:  pboss runtime change" -ForegroundColor Cyan
Write-Host "Windows rule: install through this installer, and upgrade ONLY through pboss itself —" -ForegroundColor Cyan
Write-Host "             pboss upgrade   (never npm/bun update -g: the channel that installed pboss upgrades it)" -ForegroundColor Cyan
Write-Host "Open a NEW terminal (so the PATH refreshes) and run 'pboss --version' to verify." -ForegroundColor Cyan
Write-Host ""

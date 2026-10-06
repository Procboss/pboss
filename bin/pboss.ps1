#!/usr/bin/env pwsh
# ProcBoss (pboss) — the bin wrapper for Windows (PowerShell twin of pboss.sh)
# https://procboss.com
# License: GPL-3.0-only
#
# THE ARCHITECTURE — identical contract to bin/pboss.sh:
#
#   1. --runtime=<x> / --runtime <x>   anywhere before the `--` sentinel —
#      explicit per-invocation override. This flag belongs to THE WRAPPER
#      (owner spec, 2026-10-07): the bin script consumes it — validates,
#      persists when no selection exists yet, prints the override notice,
#      and STRIPS it from the argv below. The JavaScript CLI never sees it.
#      On a start the wrapper also hands the value down via
#      PBOSS_LAUNCHER_RUNTIME so the daemon can PIN the process/ecosystem
#      (issue #40) in ~\.pboss\runtime-overrides — restarts, reloads and
#      reboots keep using it, while .runtime keeps the untouched default.
#   2. ~\.pboss\runtime-overrides      a SAVED override for this invocation's
#      target (issue #40): `pboss restart my-api` where my-api was pinned
#      to bun, or a pinned ecosystem config. Resolved BEFORE .runtime —
#      the launcher must know the runtime before the JS entry runs.
#   3. ~\.pboss\.runtime              the persistent selection (PBOSS_HOME
#      overrides the directory).
#   4. Interactive selection           first run only; Enter = Node.
#
# Dispatch: node → dist\cli.node.js, bun → dist\cli.bun.js,
#           deno → deno run -A dist\cli.deno.js.
#
# Windows reaches this file through the PowerShell installer (install.ps1
# writes a pboss.cmd that invokes it) or by calling pboss.ps1 directly.
# Every other argument is forwarded with PowerShell's native splatting
# (@cliArgs) — byte-exact, spaces, quotes, empty strings and everything
# after `--` included.

$ErrorActionPreference = "Stop"

# ── 0. ProcBoss home (tests + portability: PBOSS_HOME overrides) ──────────
$pbossHomeDir = if ($env:PBOSS_HOME) { $env:PBOSS_HOME } else { Join-Path $env:USERPROFILE ".pboss" }
$runtimeFile = Join-Path $pbossHomeDir ".runtime"
$overridesFile = Join-Path $pbossHomeDir "runtime-overrides"

function Fail([string]$message) {
    Write-Host $message -ForegroundColor Red
    exit 1
}

# ── 1. Locate this package (the wrapper sits in <package>\bin) ────────────
$pkgDir = Split-Path -Parent $PSScriptRoot

# ── 2. Scan the arguments for an explicit --runtime (before `--`) ──────────
$runtimeFlag = $null
$expectValue = $false
foreach ($arg in $args) {
    if ($expectValue) { $runtimeFlag = "$arg"; $expectValue = $false; continue }
    if ($arg -eq "--") { break }
    if ($arg -like "--runtime=*") { $runtimeFlag = $arg.Substring(10) }
    elseif ($arg -eq "--runtime") { $expectValue = $true }
}
if ($expectValue) { Fail "--runtime requires a value: node | bun | deno" }

function Normalize-Runtime([string]$value) {
    if ($null -eq $value) { return "" }
    return $value.Trim().ToLower()
}

function Test-Runtime([string]$value) {
    $n = Normalize-Runtime $value
    return ($n -eq "node" -or $n -eq "bun" -or $n -eq "deno")
}

function Runtime-Display([string]$value) {
    switch ($value) {
        "node" { return "Node" }
        "bun" { return "Bun" }
        "deno" { return "Deno" }
        default { return $value }
    }
}

# ── 2c. The saved-override target scan (issue #40) ─────────────────────
# The launcher resolves runtime_overrides BEFORE .runtime — it cannot wait
# for the JS entry to decide. The candidate is the invocation's target: the
# first positional after the subcommand, or the value of --config (its
# sibling flag). A miss is not an error — it falls through to .runtime. The
# scan is a HINT, not a parser (mirrors pboss.sh's find_launch_target).
function Find-LaunchTarget([string[]]$argv) {
    $seenCmd = $false
    $expectConfig = $false
    foreach ($arg in $argv) {
        if ($arg -eq "--") { return $null }
        if ($expectConfig) { return "$arg" }
        if ($arg -eq "--config") { $expectConfig = $true; continue }
        if ($arg -like "--config=*") { return $arg.Substring(9) }
        if ($arg.StartsWith("-")) { continue }
        if (-not $seenCmd) { $seenCmd = $true; continue }
        return "$arg"
    }
    return $null
}

# Absolutize a path-looking candidate so it matches the store's absolute
# ecosystem keys. A bare token is absolutized only when it names an existing
# FILE in the cwd (a process NAME never collides); names and non-existent
# paths stay as typed (mirrors pboss.sh's absolutize_candidate).
function Get-AbsoluteCandidate([string]$candidate) {
    $hasSlash = $candidate.Contains("/") -or $candidate.Contains("\")
    if (-not $hasSlash) {
        if (-not (Test-Path $candidate -PathType Leaf)) { return $null }
    }
    try { return [System.IO.Path]::GetFullPath($candidate) } catch { return $null }
}

# One store lookup: the value for KEY, or null (mirrors pboss.sh's awk).
function Get-SavedOverride([string]$key) {
    if (-not (Test-Path $overridesFile -PathType Leaf)) { return $null }
    try {
        foreach ($line in [System.IO.File]::ReadLines($overridesFile)) {
            $tab = $line.IndexOf("`t")
            if ($tab -le 0) { continue }
            if ($line.Substring(0, $tab).Trim() -eq $key) {
                return $line.Substring($tab + 1).Trim().ToLower()
            }
        }
    } catch { return $null }
    return $null
}

# ── 2b. Strip the flag — the CLI never sees --runtime ──────────────────────
# The flag is the WRAPPER's (owner spec, 2026-10-07): rebuild the argv
# without it (and its value). Everything from `--` onward is the command's
# own argv and is never touched (the sentinel itself is kept).
$cliArgs = @()
$stripSkipValue = $false
$stripPastSentinel = $false
foreach ($arg in $args) {
    if ($stripSkipValue) { $stripSkipValue = $false; continue }
    if ($stripPastSentinel) { $cliArgs += $arg; continue }
    if ($arg -eq "--runtime") { $stripSkipValue = $true; continue }
    if ($arg -like "--runtime=*") { continue }
    if ($arg -eq "--") { $stripPastSentinel = $true }
    $cliArgs += $arg
}

# ── 2d. Resolve the saved override for this invocation's target ───────
# Only when the flag was NOT supplied — the flag is the freshest, most
# explicit choice and beats the store by definition.
$savedOverride = $null
$launchTarget = $null
if (-not $runtimeFlag) {
    $launchTarget = Find-LaunchTarget $cliArgs
    if ($launchTarget) {
        $value = Get-SavedOverride $launchTarget
        if (-not $value) {
            $abs = Get-AbsoluteCandidate $launchTarget
            if ($abs) { $value = Get-SavedOverride $abs }
        }
        if ($value -eq "node" -or $value -eq "bun" -or $value -eq "deno") {
            $savedOverride = $value
        }
    }
}

# ── 3. Resolve the runtime: flag → persisted selection → prompt ────────────
$runtime = $null

if ($runtimeFlag) {
    # 3a. Explicit override — validate, never silently guess.
    $runtime = Normalize-Runtime $runtimeFlag
    if (-not (Test-Runtime $runtime)) {
        Fail "Unsupported runtime: $runtimeFlag`n`nSupported runtimes:`n  node`n  bun`n  deno"
    }
    if (Test-Path $runtimeFile -PathType Leaf) {
        # A DIFFERENT valid selection is overridden for this invocation only:
        # say so and name the permanent switch — the file is never touched.
        $configured = Normalize-Runtime (Get-Content $runtimeFile -Raw)
        if ((Test-Runtime $configured) -and $configured -ne $runtime) {
            Write-Host "Using $(Runtime-Display $runtime) for this invocation."
            Write-Host ""
            Write-Host "Configured runtime remains: $(Runtime-Display $configured)"
            Write-Host ""
            Write-Host "To permanently change the runtime:"
            Write-Host "  pboss runtime change"
            Write-Host ""
        }
    } else {
        # No selection yet — the flag initializes it: plain text, one
        # lowercase word, the same discipline as the first-run prompt.
        New-Item -ItemType Directory -Path $pbossHomeDir -Force | Out-Null
        Set-Content -Path $runtimeFile -Value $runtime -Encoding ascii
    }
    # Issue #40: hand the flag's value down to the CLI (the ONLY channel —
    # the JS level never parses --runtime). cmdStart reads it so a pinned
    # start can persist the process/ecosystem override. Not set on the other
    # branches: an invocation without the flag must never look pinned.
    $env:PBOSS_LAUNCHER_RUNTIME = $runtime
} elseif ($savedOverride) {
    # 3b. A SAVED override for this invocation's target (issue #40) —
    # resolved BEFORE .runtime: the launcher must know the runtime before
    # the JS entry point is launched. The store's entry — never .runtime —
    # decides; the default file is not even read here.
    $runtime = $savedOverride
    $configuredRaw = $null
    if (Test-Path $runtimeFile -PathType Leaf) {
        $configuredRaw = Normalize-Runtime (Get-Content $runtimeFile -Raw)
    }
    if ($configuredRaw -eq "node" -or $configuredRaw -eq "bun" -or $configuredRaw -eq "deno") {
        if ($configuredRaw -ne $runtime) {
            Write-Host "Using $(Runtime-Display $runtime) for `"$launchTarget`" (saved runtime override)."
            Write-Host ""
            Write-Host "Default runtime remains: $(Runtime-Display $configuredRaw)"
            Write-Host ""
        }
    } else {
        Write-Host "Using $(Runtime-Display $runtime) for `"$launchTarget`" (saved runtime override)."
        Write-Host ""
    }
} elseif (Test-Path $runtimeFile) {
    # 3c. The persistent selection.
    $raw = (Get-Content $runtimeFile -Raw)
    $runtime = Normalize-Runtime "$raw"
    if (-not (Test-Runtime $runtime)) {
        $shown = if ($null -ne $raw) { $raw.Trim() } else { "" }
        Fail "Invalid ProcBoss runtime configuration: $shown`n`nSupported runtimes:`n  node`n  bun`n  deno"
    }
} else {
    # 3d. First run: interactive selection, Node on Enter.
    $interactive = [Environment]::UserInteractive -and -not [Console]::IsInputRedirected
    if (-not $interactive) {
        Fail ("ProcBoss needs a runtime selection.`n`nRun pboss with one of:`n`n" +
              "  --runtime=node`n  --runtime=bun`n  --runtime=deno`n`n" +
              "(or run `pboss` in an interactive terminal once — the choice is saved to`n" +
              "~\.pboss\.runtime and never asked again)")
    }
    Write-Host "Kindly select your runtime:"
    Write-Host ""
    Write-Host "  1. Node"
    Write-Host "  2. Bun"
    Write-Host "  3. Deno"
    Write-Host ""
    $answer = Read-Host "Select runtime [1]"
    switch -Regex ($answer.Trim().ToLower()) {
        "^(|1|node)$" { $runtime = "node" }
        "^(2|bun)$" { $runtime = "bun" }
        "^(3|deno)$" { $runtime = "deno" }
        default {
            Fail "Unsupported runtime: $answer`n`nSupported runtimes:`n  node`n  bun`n  deno"
        }
    }
    # Persist the choice — plain text, one lowercase word.
    New-Item -ItemType Directory -Path $pbossHomeDir -Force | Out-Null
    Set-Content -Path $runtimeFile -Value $runtime -Encoding ascii
}

# ── 4. Dispatch to the runtime-specific entrypoint ─────────────────────────
switch ($runtime) {
    "node" {
        $cli = Join-Path $pkgDir "dist\cli.node.js"
        if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
            Fail ("ProcBoss requires Node, but Node was not found.`n`n" +
                  "Install Node (https://nodejs.org), or switch runtimes:`n" +
                  "  pboss --runtime=bun   (or deno) for one invocation`n" +
                  "  remove '$runtimeFile' to choose again")
        }
        if (-not (Test-Path $cli)) { Fail "pboss install incomplete: $cli is missing — reinstall pboss." }
        & node $cli @cliArgs
        exit $LASTEXITCODE
    }
    "bun" {
        $cli = Join-Path $pkgDir "dist\cli.bun.js"
        if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
            Fail ("ProcBoss requires Bun, but Bun was not found.`n`n" +
                  "Install Bun (https://bun.sh), or switch runtimes:`n" +
                  "  pboss --runtime=node  (or deno) for one invocation`n" +
                  "  remove '$runtimeFile' to choose again")
        }
        if (-not (Test-Path $cli)) { Fail "pboss install incomplete: $cli is missing — reinstall pboss." }
        & bun $cli @cliArgs
        exit $LASTEXITCODE
    }
    "deno" {
        $cli = Join-Path $pkgDir "dist\cli.deno.js"
        if (-not (Get-Command deno -ErrorAction SilentlyContinue)) {
            Fail ("ProcBoss requires Deno, but Deno was not found.`n`n" +
                  "Install Deno (https://deno.com), or switch runtimes:`n" +
                  "  pboss --runtime=node  (or bun) for one invocation`n" +
                  "  remove '$runtimeFile' to choose again")
        }
        if (-not (Test-Path $cli)) { Fail "pboss install incomplete: $cli is missing — reinstall pboss." }
        & deno run -A $cli @cliArgs
        exit $LASTEXITCODE
    }
    default {
        Fail "Invalid ProcBoss runtime: $runtime"
    }
}

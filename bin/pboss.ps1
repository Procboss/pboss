#!/usr/bin/env pwsh
# ProcBoss (pboss) — the bin wrapper for Windows (PowerShell twin of pboss.sh)
# https://procboss.com
# License: GPL-3.0-only
#
# THE ARCHITECTURE — identical contract to bin/pboss.sh:
#
#   1. --runtime=<x> / --runtime <x>   anywhere before the `--` sentinel —
#      explicit per-invocation override (the CLI prints the notice and
#      initializes the selection when none exists yet).
#   2. ~\.pboss\.runtime              the persistent selection (PBOSS_HOME
#      overrides the directory).
#   3. Interactive selection           first run only; Enter = Node.
#
# Dispatch: node → dist\cli.node.js, bun → dist\cli.bun.js,
#           deno → deno run -A dist\cli.deno.js.
#
# Windows reaches this file through the PowerShell installer (install.ps1
# writes a pboss.cmd that invokes it) or by calling pboss.ps1 directly.
# Arguments are forwarded with PowerShell's native splatting (@args).

$ErrorActionPreference = "Stop"

# ── 0. ProcBoss home (tests + portability: PBOSS_HOME overrides) ──────────
$pbossHomeDir = if ($env:PBOSS_HOME) { $env:PBOSS_HOME } else { Join-Path $env:USERPROFILE ".pboss" }
$runtimeFile = Join-Path $pbossHomeDir ".runtime"

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

# ── 3. Resolve the runtime: flag → persisted selection → prompt ────────────
$runtime = $null

if ($runtimeFlag) {
    # 3a. Explicit override — validate, never silently guess.
    $runtime = Normalize-Runtime $runtimeFlag
    if (-not (Test-Runtime $runtime)) {
        Fail "Unsupported runtime: $runtimeFlag`n`nSupported runtimes:`n  node`n  bun`n  deno"
    }
} elseif (Test-Path $runtimeFile) {
    # 3b. The persistent selection.
    $raw = (Get-Content $runtimeFile -Raw)
    $runtime = Normalize-Runtime "$raw"
    if (-not (Test-Runtime $runtime)) {
        $shown = if ($null -ne $raw) { $raw.Trim() } else { "" }
        Fail "Invalid ProcBoss runtime configuration: $shown`n`nSupported runtimes:`n  node`n  bun`n  deno"
    }
} else {
    # 3c. First run: interactive selection, Node on Enter.
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
        & node $cli @args
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
        & bun --bun run $cli @args
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
        & deno run -A $cli @args
        exit $LASTEXITCODE
    }
    default {
        Fail "Invalid ProcBoss runtime: $runtime"
    }
}

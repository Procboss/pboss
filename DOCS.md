# ⚡ ProcBoss (pboss)

**A blazing-fast, universal production process manager built on Bun native APIs.**
Run, cluster, monitor, and manage any application — Node.js, Bun, Go, Python, Rust, Ruby, PHP, Java, native binaries, and shell scripts — with pure performance and zero overhead.
By [procboss.com](https://procboss.com).

![Runtime](https://img.shields.io/badge/runtime-Bun-f472b6?style=flat-square)
![Language](https://img.shields.io/badge/language-TypeScript-3178c6?style=flat-square)
![License](https://img.shields.io/badge/license-GPLv3-green?style=flat-square)
[![Tests](https://github.com/procboss/pboss/actions/workflows/test.yml/badge.svg)](https://github.com/procboss/pboss/actions/workflows/test.yml)


---

### Support ProcBoss

ProcBoss (pboss) is free and open-source software built for the developer community by [docs.procboss.com](https://docs.procboss.com). If ProcBoss saves you time or powers your production services, please consider supporting its development:

- ⭐ **Star the Repo:** Star us on [GitHub](https://github.com/procboss/pboss) to help more developers discover ProcBoss.
- 🐛 **Contribute:** Open issues, suggest features, or submit pull requests.


---

## Table of Contents

- [Support & Sponsor](#support-procboss)
- [Why ProcBoss?](#why-procboss)
- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Multi-Language & Runtime Support](#multi-language--runtime-support)
- [CLI Reference](#cli-reference)
  - [Process Management](#process-management)
  - [Cluster Mode](#cluster-mode)
  - [Log Management](#log-management)
  - [Monitoring and Metrics](#monitoring-and-metrics)
  - [Dashboard](#dashboard)
  - [Ecosystem Files](#ecosystem-files)
  - [Environment Management](#environment-management)
  - [Deployment](#deployment)
  - [Cron Jobs](#cron-jobs)
  - [Startup Scripts](#startup-scripts)
  - [Modules](#modules)
  - [Daemon Control](#daemon-control)
- [ProcBoss Cloud](#procboss-cloud)
  - [Linking a server — the device-code flow](#linking-a-server--the-device-code-flow)
  - [User login (pboss login / whoami / logout)](#user-login-pboss-login--whoami--logout)
  - [Updating pboss (pboss upgrade)](#updating-pboss-pboss-upgrade)
  - [What the cloud link does](#what-the-cloud-link-does)
  - [Cloud security model](#cloud-security-model)
  - [Self-hosting / custom cloud endpoint](#self-hosting--custom-cloud-endpoint)
- [Foreground Mode (Docker & Containers)](#foreground-mode-docker--containers)
- [Configuration Reference](#configuration-reference)
  - [Ecosystem File Format](#ecosystem-file-format)
  - [Process Options](#process-options)
  - [Cluster Options](#cluster-options)
  - [Log Options](#log-options)
  - [Health Check Options](#health-check-options)
  - [Watch Options](#watch-options)
  - [Deploy Configuration](#deploy-configuration)
- [Web Dashboard](#web-dashboard)
  - [Dashboard Features](#dashboard-features)
  - [REST API](#rest-api)
  - [WebSocket API](#websocket-api)
- [Prometheus and Grafana Integration](#prometheus-and-grafana-integration)
- [Programmatic API](#programmatic-api)
  - [Zero-Ceremony Quick Start](#zero-ceremony-quick-start)
  - [Reading Processes Without Initialization](#reading-existing-processes-without-initialization)
  - [Connection Lifecycle](#connection-lifecycle)
  - [Process Management](#programmatic-process-management)
  - [Introspection](#introspection)
  - [Logs](#logs)
  - [Monitoring and Metrics](#programmatic-monitoring-and-metrics)
  - [Persistence](#persistence)
  - [Dashboard Control](#dashboard-control)
  - [Module Management](#module-management)
  - [Daemon Lifecycle](#daemon-lifecycle)
  - [Low-Level Transport](#low-level-transport)
  - [Events](#events)
  - [Error Handling](#error-handling)
  - [Direct ProcessManager Usage](#direct-processmanager-usage)
- [Architecture](#architecture)
- [Recipes and Examples](#recipes-and-examples)
- [Troubleshooting](#troubleshooting)
- [File Structure](#file-structure)
- [Contributing](#contributing)
- [License](#license)

---

## Why ProcBoss?

ProcBoss (pboss) is a universal, production-grade process manager built from the ground up for modern developer and DevOps workflows. While engineered on native Bun APIs for maximum throughput and minimal memory overhead, ProcBoss is completely **runtime-agnostic** and manages any program, language, or software stack.

ProcBoss replaces complex, heavyweight process managers with a clean, ultra-fast architecture. It uses `Bun.spawn` for lightning-fast process orchestration, `Bun.serve` for the real-time web dashboard and IPC, native `WebSocket` over Unix sockets, `Bun.file` for high-performance I/O, and `Bun.gzipSync` for automatic log compression. The result is a single machine-level daemon that starts in under 50ms, uses only ~12MB of RAM, and manages your entire infrastructure seamlessly.

---

## Features

**Universal Multi-Language Support** — Native auto-detection and execution for Node.js, Bun, Go, Python, Rust, Ruby, PHP, Java JARs, Shell scripts, Windows scripts, and compiled binaries.

**Core Process Management** — Start, stop, restart, reload, delete, and scale processes with automatic restart on crash, configurable restart strategies, memory-limit restarts, and tree killing.

**Cluster Mode** — Run multiple instances of your application with per-worker environment injection, automatic port assignment, and round-robin-ready configuration using `PBOSS_WORKER_ID` and `NODE_APP_INSTANCE` conventions.

**Zero-Downtime Reload** — Graceful reload cycles through instances sequentially, starting the new process before stopping the old one, ensuring your application never drops a request.

**Foreground / No-Daemon Mode** — Run ProcBoss in blocking foreground mode without spawning a background daemon. Designed for containerized environments like Docker, Kubernetes, and any platform that expects PID 1 to remain in the foreground.

**Real-Time Web Dashboard** — A built-in dark-themed web dashboard with live WebSocket updates, CPU/memory charts, process control buttons, and a log viewer. No external dependencies.

**Prometheus Metrics** — A dedicated metrics endpoint exports process and system telemetry in Prometheus exposition format, ready for scraping by Prometheus and visualization in Grafana.

**Log Management** — Automatic log capture with buffered writes, size-based rotation, configurable retention, optional gzip compression, log flushing, and real-time tailing.

**Health Checks** — HTTP health check probes with configurable intervals, timeouts, and failure thresholds that automatically restart unhealthy processes.

**Cron Restarts** — Schedule periodic restarts using standard cron expressions for applications that benefit from regular recycling.

**Standalone Cron Jobs** — Schedule any shell command or script with human-friendly syntax (`everyday@9:11`, `every-second`, `every-sunday@10:10`, `on-date@24-10-2026-23:10`) — no managed process required. Jobs persist across daemon restarts and reboots, run with output logs, and survive missed runs gracefully. See [Cron Jobs](#cron-jobs).

**File Watching** — Automatic restart on file changes with configurable watch paths and ignore patterns. Ideal for development workflows.

**Ecosystem Files** — Declare your entire application topology in a single JSON or TypeScript configuration file and start everything with one command.

**Process Persistence** — Save the current process list and resurrect it after a daemon restart or system reboot. Combined with startup script generation, your applications survive server reboots.

**Startup Script Generation** — Automatically generate and install systemd (Linux), launchd (macOS), or Task Scheduler (Windows) service configurations so the ProcBoss daemon starts at boot.

**Remote Deployment** — A built-in deploy system that handles SSH-based deployment with git pull, release directory management, symlink rotation, and pre/post-deploy hooks.

**Module/Plugin System** — Extend ProcBoss with custom modules that hook into the process manager lifecycle.

**Environment Management** — Store, retrieve, and inject environment variables per process with `.env` file loading support.

**Full IPC Architecture** — A daemonized architecture where the CLI communicates with a long-running daemon process over a Unix domain socket using WebSocket protocol.

---

## Installation

### One-Line Universal Install

Install and compile the native standalone `pboss` executable directly on your device. The installer installs system-wide (`/usr/local/bin`) and therefore requires root — pipe it through `sudo`:

**Linux / macOS:**
```bash
curl -fsSL https://procboss.com/install.sh | sudo bash
```

**Windows (PowerShell, run as Administrator):**
```powershell
powershell -c "irm https://procboss.com/install.ps1 | iex"
```

**Windows (Command Prompt, run as Administrator):**
```cmd
curl -fsSL https://procboss.com/install.cmd | cmd
```

The installers check for the required privileges themselves and tell you exactly how to re-run them if `sudo` / Administrator rights are missing.

---

### Bun Global Install

If you already use Bun, install pboss **system-wide** — `pboss startup install` needs sudo on Linux, and sudo's PATH does not include per-user directories like `~/.bun/bin` (that's why plain `sudo pboss` says "command not found"):

```bash
sudo BUN_INSTALL=/usr/local bun add -g pboss
```

This expects a system-wide Bun. To install one, put the sudo on the **bash** side of the pipe — `sudo curl … | bash` still runs the installer as your normal user, because sudo would only apply to curl:

```bash
curl -fsSL https://bun.sh/install | sudo BUN_INSTALL=/usr/local bash
```

Update later with `sudo BUN_INSTALL=/usr/local bun update -g pboss`.

Both `BUN_INSTALL=/usr/local` flags are load-bearing: the global `pboss` shim is a symlink whose target starts with `#!/usr/bin/env bun`, so `sudo pboss` must find the shim **and** bun itself on root's PATH. The variable puts bun in `/usr/local/bin` (installer line) and the shim in `$BUN_INSTALL/bin` (add/update lines); without it, everything sits in `~/.bun/bin`, invisible to sudo.

A user-local install (`bun add -g pboss` without sudo) works too — whenever a command needs root, keep your PATH visible to sudo: `sudo env PATH="$PATH" pboss startup install`.

On Windows, elevated shells keep your user PATH, so a regular `bun add -g pboss` is fine — just open the shell as Administrator for `pboss startup install`.

---

### Build From Source

```bash
git clone https://github.com/procboss/pboss.git
cd pboss
bun install
bun run build:bin
```

---

### Verify Installation

```bash
pboss --version
```

---

## Quick Start

### Start a process

```
pboss start app.ts
```

### Start with a name and options

```
pboss start app.ts --name my-api --instances 4 --port 3000
```

### List all processes

```
pboss list
```

### List processes with live updates

```
pboss list --live
```

Output:

```
┌────┬──────────┬──────────┬──────┬───────┬──────────┬──────────┬──────────┐
│ ID │ Name     │ Status   │ PID  │ CPU   │ Memory   │ Restarts │ Uptime   │
├────┼──────────┼──────────┼──────┼───────┼──────────┼──────────┼──────────┤
│ 0  │ my-api-0 │ online   │ 4521 │ 0.3%  │ 42.1 MB  │ 0        │ 5m 23s  │
│ 1  │ my-api-1 │ online   │ 4522 │ 0.2%  │ 39.8 MB  │ 0        │ 5m 23s  │
│ 2  │ my-api-2 │ online   │ 4523 │ 0.4%  │ 41.3 MB  │ 0        │ 5m 23s  │
│ 3  │ my-api-3 │ online   │ 4524 │ 0.1%  │ 40.5 MB  │ 0        │ 5m 23s  │
└────┴──────────┴──────────┴──────┴───────┴──────────┴──────────┴──────────┘
```

### Open the dashboard

```
pboss dashboard
```

Output:

```
⚡ Dashboard running at http://localhost:9615
📊 Prometheus metrics at http://localhost:9616/metrics
```

### Survive a reboot (default on)

```
pboss start server.ts
```

That is the whole setup. The process list is saved automatically to `~/.pboss/dump.json` after **every** change (start, stop, restart, delete, scale), and the boot service — installed automatically by the one-line installer at install time — starts the daemon at boot and resurrects the list: running processes come back running, stopped ones come back stopped, deleted ones don't come back. The first `pboss start` states where persistence stands in one line, so the default is never a silent surprise.

`pboss startup status` shows the whole picture read-only: whether the boot service is installed and enabled, whether the daemon is up, and exactly what a reboot would restore from the dump.

If the boot service could not be installed automatically (user-level install without root, or a host without systemd), one command enables it:

```
sudo env PATH="$PATH" pboss startup install
```

(The env form keeps your PATH visible to sudo; on macOS plain `pboss startup install` works, and on a compiled one-line install plain `sudo pboss startup install` is enough.)

---

## Multi-Language & Runtime Support

ProcBoss runs and supervises any application, programming language, runtime, or compiled binary:

| Runtime / Language | File Extension | Auto-detected Runner | Example |
|---|---|---|---|
| **TypeScript / JSX** | `.ts`, `.tsx`, `.jsx`, `.mjs`, `.cjs` | `bun run <file>` | `pboss start server.ts` |
| **JavaScript (Bun)** | `.js` | `bun run <file>` | `pboss start app.js` |
| **JavaScript (Node.js)** | `.js` | `node <file>` (via `--interpreter`) | `pboss start app.js --interpreter node` |
| **Python** | `.py` | `python3 <file>` (or `python`) | `pboss start worker.py` |
| **Go** | `.go` | `go run <file>` | `pboss start main.go` |
| **Compiled Binaries (Go / Rust / C / C++)** | *(no ext)*, `.bin`, `.exe` | Direct binary execution | `pboss start ./my-go-server` |
| **Ruby** | `.rb` | `ruby <file>` | `pboss start app.rb` |
| **PHP** | `.php` | `php <file>` | `pboss start server.php` |
| **Java** | `.jar` | `java -jar <file>` | `pboss start app.jar` |
| **Shell / Bash** | `.sh`, `.bash` | `sh <file>` / `bash <file>` | `pboss start job.sh` |
| **Windows Scripts** | `.bat`, `.cmd`, `.ps1` | `cmd.exe` / `powershell.exe` | `pboss start script.bat` |
| **Custom Interpreter** | *any* | Custom runtime via `--interpreter` | `pboss start app.ts --interpreter "deno run -A"` |

### Running Native Binaries (Go, Rust, C/C++)

Compiled executables are executed directly with zero interpreter wrapper:

```bash
# Start a compiled Go or Rust binary
pboss start ./dist/my-go-api --name api --instances 4

# Run with explicit direct binary mode
pboss start ./my-binary --interpreter none
```

### Runtime discovery — how pboss finds `bun` (and why it matters)

JavaScript/TypeScript workers are spawned by the **daemon**, and the daemon often runs where no login shell ever set a `PATH` — as a systemd service on Linux, a launchd agent on macOS, or a scheduled task on Windows. A PATH-only lookup therefore misses the most common Bun install location, `~/.bun/bin`, even though `which bun` finds it perfectly in your shell. pboss resolves the interpreter through a full chain, in order:

1. `PATH` (as seen by the current process — the CLI inherits your shell's)
2. `$BUN_INSTALL/bin` (set by the official `bun.sh` installer)
3. `~/.bun/bin` (the default user install — the one daemons can't see)
4. `/usr/local/bin`, `/usr/bin`, `/opt/bun/bin`
5. `/opt/homebrew/bin` (macOS Homebrew on Apple Silicon — not on a launchd PATH)

Three layers make this work everywhere: the absolute resolved path is used for the worker spawn (surviving any PATH), the generated boot service's `PATH` includes the target user's `~/.bun/bin` when present (workers that call `bun` by name), and the daemon prepends the discovered bun directory to its own `PATH` at startup (healing daemons started by older unit files). If no Bun exists at all, the error message lists every location that was checked before suggesting `--interpreter node` or `--interpreter none`.

### Running Python Services

```bash
# Auto-detects python3 on Linux/macOS or python on Windows
pboss start worker.py --name py-worker

# Custom virtualenv Python interpreter
pboss start worker.py --interpreter ./venv/bin/python
```

### Running Node.js Applications

```bash
# Run with Node.js interpreter
pboss start server.js --interpreter node --name node-api

# Pass Node.js / V8 flags
pboss start server.js --interpreter node --node-args "--max-old-space-size=4096"
```

---

## CLI Reference

### Process Management

#### pboss start

Start a new process or processes.

```
pboss start server.ts
```

`pboss start <name|namespace>` (when the positional is not an existing script or config file) **resumes** processes that already exist: every stopped member of the group comes back online, online ones are untouched, nothing new is created.

```
pboss start stellarforge   # resume every stopped process in the namespace
pboss start api            # resume one stopped process by name
```

```
pboss start server.ts --name api -- --port 8080 --host 0.0.0.0
```

```
pboss start server.ts --name api --env NODE_ENV=production --env API_KEY=xxx
```

```
pboss start server.ts --name api --max-memory-restart 512M
```

```
pboss start script.py --interpreter python3
```

```
pboss start server.ts --name api --wait-ready --listen-timeout 10000
```

**Options:**

| Flag | Description | Default |
|---|---|---|
| `--name <name>` | Process name | Script filename |
| `--instances <n>` | Number of instances. Use `max` for all CPUs | `1` |
| `--exec-mode <mode>` | `fork` or `cluster` | `fork` |
| `--cwd <path>` | Working directory | Current directory |
| `--env <KEY=VAL>` | Environment variable (repeatable) | — |
| `--interpreter <bin>` | Custom interpreter binary | Auto-detected |
| `--interpreter-args <args>` | Arguments for the interpreter | — |
| `--node-args <args>` | Additional runtime arguments | — |
| `--max-memory-restart <size>` | Restart when memory exceeds limit | — |
| `--max-restarts <n>` | Maximum consecutive restarts | `16` |
| `--min-uptime <ms>` | Minimum uptime before a restart is considered stable | `1000` |
| `--restart-delay <ms>` | Delay between restarts | `0` |
| `--kill-timeout <ms>` | Grace period before SIGKILL | `5000` |
| `--no-autorestart` | Disable automatic restart | `false` |
| `--cron <expression>` | Cron expression for scheduled restarts | — |
| `--watch` | Enable file watching | `false` |
| `--ignore-watch <dirs>` | Directories to ignore | `node_modules,.git` |
| `--port <n>` | Base port (auto-incremented in cluster mode) | — |
| `--namespace <ns>` | Process namespace for grouping | — |
| `--wait-ready` | Wait for process ready signal | `false` |
| `--listen-timeout <ms>` | Timeout waiting for ready signal | `3000` |
| `--source-map-support` | Enable source map support | `false` |
| `--merge-logs` | Merge all instance logs into one file | `false` |
| `--log-date-format <fmt>` | Date format prefix for log lines | — |
| `--output <file>` | Custom stdout log path | `~/.pboss/logs/<name>-<id>-out.log` |
| `--error <file>` | Custom stderr log path | `~/.pboss/logs/<name>-<id>-error.log` |
| `--log-max-size <size>` | Max log file size before rotation | `10M` |
| `--log-retain <n>` | Number of rotated log files to keep | `5` |
| `--log-compress` | Gzip rotated log files | `false` |
| `--health-check-url <url>` | HTTP endpoint for health probes | — |
| `--health-check-interval <ms>` | Probe interval | `30000` |
| `--health-check-timeout <ms>` | Probe timeout | `5000` |
| `--health-check-max-fails <n>` | Failures before restart | `3` |
| `--no-daemon`, `-d` | Run in foreground without a daemon (blocks) | `false` |
| `--raw` | Also send child logs to stdout/stderr while retaining log files | `false` |

> **Flags are position-independent.** `--no-daemon` (and all other flags) may appear anywhere relative to the script path:
> ```
> pboss start --no-daemon app.ts
> pboss start app.ts --no-daemon
> pboss start --name api --no-daemon app.ts --watch
> ```

---

#### pboss stop

Stop a process, all processes with a name, or all processes.

```
pboss stop 0
pboss stop my-api
pboss stop my-namespace
pboss stop all
```

When the target is a **namespace**, every process in that namespace stops (and only those), with a one-line summary naming the group. Operating on an unknown name or namespace is a clear error — `Process or namespace "x" not found — nothing to stop` — instead of a silent empty table; `all` on an empty list stays a no-op.

---

#### pboss restart

Stop and restart a process. The process is fully stopped and then re-spawned.

```
pboss restart my-api
pboss restart my-namespace
pboss restart all
```

A namespace target restarts every member of the group — including members that were stopped (restart on a stopped process starts it).

---

#### pboss reload

Graceful zero-downtime reload. New instances start before old ones are killed, ensuring your application always has live workers handling requests.

```
pboss reload my-api
pboss reload my-namespace
pboss reload all
```

The reload process works as follows for each instance. First, a new process is spawned. Then ProcBoss waits for the new process to become stable or emit a ready signal if `--wait-ready` is enabled. Next, the old process receives SIGTERM and is given the kill timeout to shut down gracefully. Finally, the cycle moves to the next instance.

---

#### pboss delete

Stop and remove a process from ProcBoss's management.

```
pboss delete 0
pboss delete my-api
pboss delete my-namespace
pboss delete my-namespace --force
pboss delete all
```

Deleting a **namespace** removes every process in the group. Because that can take several processes at once, pboss asks for confirmation first — `[y/N]` in a terminal, and a hard refusal with a `--force` hint when stdin is not a TTY (scripts, CI, pipes). Name and cluster deletes keep their old unconfirmed behavior, as does `delete all`.

---

#### Namespaces — group-level lifecycle

A namespace is a first-class grouping mechanism, not just metadata. Assign one at start (`--namespace stellarforge` or the `namespace` field in an ecosystem file), and every lifecycle verb accepts it as a target:

```
pboss start ./web.ts      --name web    --namespace stellarforge
pboss start ./collab.ts   --name collab --namespace stellarforge
pboss start ./lsp.ts      --name lsp    --namespace stellarforge
pboss start ./worker.ts   --name worker --namespace stellarforge

pboss restart stellarforge   # the whole group, in one command
pboss stop stellarforge
pboss start stellarforge     # resume every stopped member (online ones untouched)
pboss delete stellarforge    # confirmed, or --force
```

Resolution rules:

- A target that matches a **process name** (or its cluster instances, `name-0`, `name-1`, …) always wins — existing per-process commands behave exactly as before, even if a namespace shares the name.
- Otherwise the target operates on every process in the **namespace**.
- Unknown targets are clear errors: `Process or namespace "x" not found — nothing to <verb>`. Run `pboss list` to see registered names and namespaces (the table has a namespace column).
- Group operations report what they touched — `✓ Stopped 4 processes in namespace "stellarforge"` — above the usual process table, and the auto-saved dump follows immediately, so the group state survives reboots by default.

---

#### pboss scale

Dynamically scale a process group up or down.

```
pboss scale my-api 8
pboss scale my-api 2
```

When scaling up, new instances inherit the configuration of the existing instances. When scaling down, the highest-numbered instances are stopped and removed first.

---

#### pboss describe

Show detailed information about a process.

```
pboss describe my-api
```

Output:

```
┌─────────────────────┬──────────────────────────────────────────┐
│ Name                │ my-api-0                                 │
│ ID                  │ 0                                        │
│ Status              │ online                                   │
│ PID                 │ 4521                                     │
│ Exec Mode           │ cluster                                  │
│ Instances           │ 4                                        │
│ Uptime              │ 2h 15m                                   │
│ Restarts            │ 0                                        │
│ Unstable Restarts   │ 0                                        │
│ CPU                 │ 0.3%                                     │
│ Memory              │ 42.1 MB                                  │
│ File Handles        │ 24                                       │
│ Script              │ /home/user/app/server.ts                 │
│ CWD                 │ /home/user/app                           │
│ Interpreter         │ bun                                      │
│ Watch               │ disabled                                 │
│ Max Memory Restart  │ 512 MB                                   │
│ Health Check        │ http://localhost:3000/health (healthy)    │
│ Cron Restart        │ disabled                                 │
│ Namespace           │ production                               │
│ Created             │ 2025-02-11T10:30:00.000Z                 │
│ Out Log             │ /home/user/.pboss/logs/my-api-0-out.log    │
│ Error Log           │ /home/user/.pboss/logs/my-api-0-error.log  │
└─────────────────────┴──────────────────────────────────────────┘
```

---

#### pboss list

List all managed processes with their status, resource usage, and uptime.  
Supports a **live mode** with auto-refresh and interactive keyboard shortcuts.

```bash
pboss list
```

## Live Mode Keyboard Shortcuts

```
R : Reload table manually
M : Sort by Memory usage
C : Sort by CPU usage
U : Sort by Uptime
Q : Quit live mode
```

## Examples

```bash
# List all processes once
pboss list

# List processes with live updates
pboss list --live
```

## Notes

* Live mode automatically refreshes the table every second (default interval).
* Sorting can be changed on the fly using the keyboard shortcuts.
* Press `R` to reload manually, `Q` to quit live mode.

---

#### pboss signal

Send an OS signal to a process.

```
pboss signal my-api SIGUSR2
```

---

#### pboss reset

Reset the restart counter for a process.

```
pboss reset my-api
pboss reset all
```

---

### Cluster Mode

Cluster mode spawns multiple instances of your application, each running in its own process. This is ideal for CPU-bound workloads and for taking full advantage of multi-core servers.

```bash
pboss start server.ts --name api --instances max
```

```bash
pboss start server.ts --name api --instances 4
```

```bash
pboss start server.ts --name api --instances 4 --port 3000
```

#### ⚠️ Current Status & Limitations

While `pboss` provides the orchestration for clustering, please note that **Bun's native cluster implementation is currently limited by the underlying OS:**

* **Linux Only:** Port sharing via `reusePort` is only fully supported on **Linux**.
* **macOS & Windows:** Due to OS-level limitations with `SO_REUSEPORT`, these platforms ignore the `reusePort` option. On these systems, clustering may result in "Address already in use" errors if attempting to bind multiple workers to the same port.

`pboss` leverages the native [Bun.serve cluster logic](https://bun.sh/docs/api/http#cluster) to ensure maximum performance, but it remains subject to the runtime's maturity.


#### Environment Variables

Each cluster worker receives the following environment variables:

| Variable | Description |
| --- | --- |
| `PBOSS_CLUSTER` | Set to `"true"` in cluster mode |
| `PBOSS_WORKER_ID` | Zero-indexed worker ID |
| `PBOSS_INSTANCES` | Total number of instances |
| `NODE_APP_INSTANCE` | Standard cluster worker index (`PBOSS_WORKER_ID`) |
| `PORT` | `basePort + workerIndex` (if `--port` is specified) |

---

#### Example: Cluster-Aware Port Binding

To enable clustering in Bun, you must explicitly set `reusePort: true`. This allows multiple processes to listen on the same port (on supported OSs).

```typescript
// server.ts
const workerId = parseInt(process.env.PBOSS_WORKER_ID || "0");
const port = parseInt(process.env.PORT || "3000");

Bun.serve({
  port,
  // Share the same port across multiple processes
  // This is the important part!
  reusePort: true,
  fetch(req) {
    return new Response(`Hello from worker ${workerId} on port ${port}`);
  },
});

console.log(`Worker ${workerId} listening on :${port}`);
```

---

### Log Management

#### pboss logs

Display recent logs for a process.

```
pboss logs
```

```
pboss logs my-api --lines 100
```

```
pboss logs my-api --err
```

```
pboss logs my-api --follow
pboss logs my-api -f
pboss logs -f
```

---

#### pboss flush

Clear log files.

```
pboss flush my-api
pboss flush
```

---

#### Log Rotation

Log rotation runs automatically in the background. It checks log file sizes once per minute and rotates when the configured threshold is exceeded.

```
pboss start server.ts --log-max-size 50M --log-retain 10 --log-compress
```

Rotation behavior: When a log file exceeds `--log-max-size`, it is renamed with a numeric suffix. Existing rotated files are shifted up by one number. Files beyond the `--log-retain` count are deleted. If `--log-compress` is enabled, rotated files are gzip-compressed using Bun's native `Bun.gzipSync`.

Default values:

| Setting | Default |
|---|---|
| `log-max-size` | `10 MB` |
| `log-retain` | `5` |
| `log-compress` | `false` |

---

### Monitoring and Metrics

#### pboss monit

Open an interactive terminal monitor showing real-time CPU, memory, and event loop data for all processes.

```
pboss monit
```

---

#### pboss metrics

Dump a current metrics snapshot as JSON.

```
pboss metrics
```

Output:

```
{
  "timestamp": 1707650400000,
  "processes": [
    {
      "id": 0,
      "name": "my-api-0",
      "pid": 4521,
      "cpu": 0.3,
      "memory": 44150784,
      "handles": 24,
      "status": "online",
      "restarts": 0,
      "uptime": 8100000
    }
  ],
  "system": {
    "totalMemory": 17179869184,
    "freeMemory": 8589934592,
    "cpuCount": 8,
    "loadAvg": [1.23, 1.45, 1.67],
    "platform": "linux"
  }
}
```

---

#### pboss metrics --history

Retrieve historical metrics. ProcBoss retains up to 1 hour of per-second snapshots in memory.

```
pboss metrics --history 600
```

---

#### pboss prometheus

Output current metrics in Prometheus exposition format.

```
pboss prometheus
```

Output:

```
# HELP pboss_process_cpu CPU usage percentage
# TYPE pboss_process_cpu gauge
pboss_process_cpu{name="my-api-0",id="0"} 0.3
# HELP pboss_process_memory_bytes Memory usage in bytes
# TYPE pboss_process_memory_bytes gauge
pboss_process_memory_bytes{name="my-api-0",id="0"} 44150784
# HELP pboss_process_restarts_total Total restart count
# TYPE pboss_process_restarts_total counter
pboss_process_restarts_total{name="my-api-0",id="0"} 0
# HELP pboss_process_uptime_seconds Process uptime in seconds
# TYPE pboss_process_uptime_seconds gauge
pboss_process_uptime_seconds{name="my-api-0",id="0"} 8100
# HELP pboss_process_status Process status (1=online)
# TYPE pboss_process_status gauge
pboss_process_status{name="my-api-0",id="0",status="online"} 1
# HELP pboss_system_memory_total_bytes Total system memory
# TYPE pboss_system_memory_total_bytes gauge
pboss_system_memory_total_bytes 17179869184
# HELP pboss_system_memory_free_bytes Free system memory
# TYPE pboss_system_memory_free_bytes gauge
pboss_system_memory_free_bytes 8589934592
# HELP pboss_system_load_average System load average
# TYPE pboss_system_load_average gauge
pboss_system_load_average{period="1m"} 1.23
pboss_system_load_average{period="5m"} 1.45
pboss_system_load_average{period="15m"} 1.67
```

---

### Dashboard

#### pboss dashboard

Launch the built-in web dashboard.

```
pboss dashboard
```

```
pboss dashboard --port 8080 --metrics-port 8081
```

#### pboss dashboard stop

Stop the web dashboard.

```
pboss dashboard stop
```

See the Web Dashboard section below for a detailed description of dashboard capabilities.

---

### Ecosystem Files

An ecosystem file defines your entire application topology in a single configuration. ProcBoss supports JSON and TypeScript ecosystem files.

```
pboss start ecosystem.config.json
```

```
pboss start ecosystem.config.ts
```

Example `ecosystem.config.json`:

```
{
  "apps": [
    {
      "name": "api",
      "script": "./src/api/server.ts",
      "instances": 4,
      "execMode": "cluster",
      "port": 3000,
      "env": {
        "NODE_ENV": "production",
        "DATABASE_URL": "postgres://localhost/mydb"
      },
      "maxMemoryRestart": "512M",
      "healthCheckUrl": "http://localhost:3000/health",
      "healthCheckInterval": 15000,
      "logMaxSize": "50M",
      "logRetain": 10,
      "logCompress": true
    },
    {
      "name": "worker",
      "script": "./src/worker/index.ts",
      "instances": 2,
      "env": {
        "NODE_ENV": "production",
        "REDIS_URL": "redis://localhost:6379"
      },
      "cron": "0 */6 * * *",
      "maxRestarts": 50
    },
    {
      "name": "scheduler",
      "script": "./src/scheduler/cron.ts",
      "instances": 1,
      "autorestart": true,
      "watch": ["./src/scheduler"]
    }
  ],
  "deploy": {
    "production": {
      "user": "deploy",
      "host": ["web1.example.com", "web2.example.com"],
      "ref": "origin/main",
      "repo": "git@github.com:your-org/your-app.git",
      "path": "/var/www/app",
      "preDeploy": "bun test",
      "postDeploy": "bun install && pboss reload ecosystem.config.json --env production"
    }
  }
}
```

Example `ecosystem.config.ts`:

```
// ecosystem.config.ts
import type { EcosystemConfig } from "pboss/types";

const config: EcosystemConfig = {
  apps: [
    {
      name: "api",
      script: "./src/server.ts",
      instances: "max",
      execMode: "cluster",
      port: 3000,
      env: {
        NODE_ENV: "production",
      },
      maxMemoryRestart: "1G",
      healthCheckUrl: "http://localhost:3000/health",
    },
  ],
};

export default config;
```

---

### Environment Management

#### pboss env set

Set an environment variable for a process.

```
pboss env set my-api DATABASE_URL postgres://localhost/mydb
```

#### pboss env get

List all stored environment variables for a process.

```
pboss env get my-api
```

#### pboss env delete

Remove an environment variable or all environment variables.

```
pboss env delete my-api DATABASE_URL
pboss env delete my-api
```

#### .env File Support

ProcBoss can load environment variables from `.env` files:

```
pboss start server.ts --env-file .env.production
```

---

### Deployment

ProcBoss includes a built-in deployment system for SSH-based deployments with release management.

#### pboss deploy setup

Initial setup of the remote server. Creates the directory structure and clones the repository.

```
pboss deploy ecosystem.config.json production setup
```

This creates the following remote directory structure:

```
/var/www/app/
├── source/
├── releases/
│   ├── 2025-02-11T10-30-00-000Z/
│   └── 2025-02-10T15-45-00-000Z/
├── current -> releases/2025-02-11T10-30-00-000Z/
└── shared/
```

#### pboss deploy

Deploy a new release.

```
pboss deploy ecosystem.config.json production
```

The deploy process works as follows. It runs the `preDeploy` hook locally such as running tests. It connects via SSH to each configured host. It pulls the latest code from the configured ref. It creates a new timestamped release directory. It updates the current symlink to the new release. It runs the `postDeploy` hook remotely such as installing dependencies and reloading processes. It cleans up old releases, keeping only the 5 most recent.

Multi-host deployment is supported. Specify an array of hosts to deploy to all of them sequentially:

```
{
  "host": ["web1.example.com", "web2.example.com", "web3.example.com"]
}
```

---

### Cron Jobs

Standalone cron jobs run any shell command on a schedule — **without a managed process**. Unlike `--cron` restart schedules (which recycle a running app), cron jobs are first-class citizens of the daemon: they are persisted in `~/.pboss/cron.json`, survive daemon restarts and reboots, and log every run to `~/.pboss/logs/cron/<name>.log`.

#### pboss cron run

Schedule a command using human-friendly syntax:

```bash
pboss cron run everyday@9:11 "bun /srv/backup.ts"
```

```bash
pboss cron run every-sunday@10:10 "sh /srv/cleanup.sh" --name cleanup
```

```bash
pboss cron run on-date@24-10-2026-23:10 "node migrate.js"
```

The full schedule grammar (24-hour clock, day-month-year dates):

| Schedule | Meaning |
|---|---|
| `everyday` | every day at 00:00 |
| `everyday@10` | every day at 10:00 |
| `everyday@9:11` | every day at 09:11 |
| `everyday@24:30` | every day at 00:30 (`24:xx` = the next day) |
| `everysecond` | every second |
| `every-15-seconds` | every 15 seconds (1–59) |
| `everyhour` / `everyhour@30` | every hour at :00 / :30 |
| `everyminute` | every minute |
| `everyweek` / `everyweek@10:10` | every Sunday |
| `every-sunday` / `everyMonday@10:10` / `onSunday@23:10` | weekly on a weekday (full or 3-letter names) |
| `everymonth` / `everymonth@10:10` | every 1st |
| `every-15th` / `every-15@10:10` | every 15th of the month |
| `every-6-hours` / `every-6-hours@30` | every 6 hours |
| `every-30-minutes` | every 30 minutes |
| `every-2-days` / `every-2-days@8` | every 2nd day |
| `today@23:10` | once, today (must be in the future) |
| `tomorrow@8:00` | once, tomorrow |
| `on-date@24-10-2026` | once, 24 Oct 2026 at 00:00 |
| `on-date@24-10-2026-23:10` | once, 24 Oct 2026 at 23:10 |
| `"*/5 * * * *"` | raw 5-field cron expression (escape hatch) |
| `"*/10 * * * * *"` | raw 6-field cron — first field is seconds |

Notes:

- Times use the 24-hour clock. Hour **24** is accepted and means "the following day": `24:30` is `00:30` the next day.
- Dates are **day-month-year** (`24-10-2026` = October 24, 2026) and are calendar-validated (leap years included).
- Keywords tolerate hyphens, underscores and camelCase: `on-date@`, `onDate@` and `on_date@` are the same word; so are `every-second` and `everySecond`.
- Next-run times are computed by the mature [cron-parser](https://www.npmjs.com/package/cron-parser) library — the same engine validates raw cron expressions, and 6-field ones get a seconds field.
- Jobs missed while the machine or daemon was down are **skipped** (like classic cron), not back-filled; recurring jobs simply reschedule to their next future occurrence.
- If a time has already passed for `today@…` or `on-date@…`, pboss rejects it with a suggestion instead of scheduling a job that never fires.

Options for `cron run`:

- `--name, -n <name>` — job name (default: derived from the command)
- `--cwd <path>` — working directory for the command (default: current directory)

#### pboss cron list

List all scheduled jobs with their next run, run counts, and last exit status:

```bash
pboss cron list
```

```
┌────┬─────────┬─────────────┬──────────────────┬───────────────────────────┬──────┬──────┬──────────┐
│ id │ name    │ schedule    │ command          │ next run                  │ runs │ last │ status   │
├────┼─────────┼─────────────┼──────────────────┼───────────────────────────┼──────┼──────┼──────────┤
│  1 │ backup  │ everyday@9  │ bun backup.ts    │ 2026-09-07 09:00 Mon      │   14 │ ✓    │ ● online │
│  2 │ cleanup │ every-sunday│ sh cleanup.sh    │ 2026-09-13 00:00 Sun      │    3 │ ✓    │ ● online │
│  3 │ migrate │ on-date@24-10-2026-23:10 │ node migrate.js │ 2026-10-24 23:10 │ 0  │ -    │ ● done   │
└────┴─────────┴─────────────┴──────────────────┴───────────────────────────┴──────┴──────┴──────────┘
```

One-shot jobs stay in the list with a `done` status after firing so you can inspect their exit code; remove them when you no longer need the record.

#### pboss cron next

Preview upcoming runs without waiting for them:

```bash
pboss cron next backup --count 5
```

#### pboss cron trigger

Run a job immediately, without waiting for its schedule (the schedule itself is unaffected):

```bash
pboss cron trigger backup
```

#### pboss cron remove

Remove a job by id or name:

```bash
pboss cron remove backup
pboss cron remove 3
```

#### Cron jobs in ecosystem files

Declare cron jobs alongside your apps in `pboss.config.ts` / `ecosystem.config.{ts,json}`. Starting the file registers the jobs (and re-running it updates changed schedules in place — jobs are matched by name):

```ts
export default {
  crons: [
    {
      name: "backup",
      schedule: "everyday@2:00",
      command: "bun /srv/backup.ts",
    },
    {
      name: "report",
      schedule: "every-15th@10:10",
      command: "sh /srv/report.sh",
    },
    {
      // paused until you enable it later
      name: "maintenance",
      schedule: "every-sunday@5:00",
      command: "sh /srv/maintenance.sh",
      enabled: false,
    },
  ],
  apps: [/* … */],
};
```

| Field | Type | Description |
|---|---|---|
| `name` | string? | Job name — defaults to a slug of the command. Used to match/update jobs on re-start. |
| `schedule` | string | Friendly schedule or raw cron expression (same grammar as `pboss cron run`). |
| `command` | string | Shell command to run. |
| `cwd` | string? | Working directory — defaults to the ecosystem file's directory. |
| `enabled` | boolean? | Set `false` to keep the job defined but paused (default `true`). |

Jobs run through the system shell (`/bin/sh -c` on Unix, `cmd /c` on Windows), so pipes, redirects, and compound commands work:

```bash
pboss cron run everyday@3 "bun report.ts | mail -s 'daily report' ops@example.com"
```

---

### Startup Scripts

`pboss startup` requires an option — bare `pboss startup` prints the list instead of guessing:

```bash
pboss startup
# Usage: pboss startup <install | uninstall | status> [generate [os]]
#   install      Install the boot startup service
#   uninstall    Remove the boot startup service (alias: remove)
#   status       Show boot-persistence state: service installed/enabled,
#                daemon up, and what a reboot would restore
#   generate [os]  Print the service config without installing
```

The boot service is normally installed **automatically** — the one-line installer does it as its final step, and global npm installs attempt it (printing the exact manual command when privileges are missing). These commands are for the cases the automation could not cover: a user-level install without root, a host without systemd at install time, or re-enabling after an uninstall.

#### pboss startup install

Install the boot startup service:

- **Linux:** writes and enables a `systemd` service (`/etc/systemd/system/pboss.service`). Requires root — when run without sudo, pboss exits with the exact command to re-run, `sudo env PATH="$PATH" pboss startup install`. The env form keeps your PATH visible to sudo, so it finds pboss even in per-user locations like `~/.bun/bin` (plain `sudo pboss` cannot see those directories). The start is submitted with `--no-block` and health is verified with a hard deadline — the unit state plus a ping on the socket the unit's daemon actually binds (`SUDO_USER`'s `~/.pboss/daemon.sock` under sudo, not root's) — with the recent journal output printed when the unit does not come up. `pboss startup install` therefore always returns; a failing daemon produces a diagnosis, never a hang (the unit also rate-limits its own restarts, so a failing daemon cannot loop forever).
- **macOS:** writes and loads a `launchd` LaunchAgent (`~/Library/LaunchAgents/com.pboss.daemon.plist`). No root needed — and if you do use sudo, pboss targets the `SUDO_USER`'s home, creates their `~/.pboss/logs` (launchd opens the log paths before starting the program), and loads the agent as that user. The plist pins `PATH`, `HOME`, and `PBOSS_HOME` so the daemon resolves the same `~/.pboss` as your interactive commands.
- **Windows:** registers a Scheduled Task (`PBOSS_Daemon`) that starts the daemon at **this user's logon** with highest privileges. Requires an elevated shell (Run as Administrator) — pboss checks and tells you when the shell is not elevated. Registration goes through PowerShell's `Register-ScheduledTask`, which passes the executable and its arguments as separate values (no `schtasks /tr` nested-quoting to break on paths with spaces).

When installed with sudo on Linux/macOS, the generated service runs as the invoking user (resolved from `SUDO_USER`), not as root — the boot daemon then uses the same `~/.pboss` data as your daily `pboss` commands instead of silently splitting off into `/root/.pboss`.

```bash
# Linux (script installs — keeps your PATH visible to sudo)
sudo env PATH="$PATH" pboss startup install

# Linux (compiled one-line install — pboss is already system-wide)
sudo pboss startup install

# macOS / Windows (elevated shell)
pboss startup install
```

The generated file detects how pboss was installed and adapts the daemon command accordingly. On a **compiled standalone install** (one-line installer, `build:bin`) the service re-executes the pboss binary itself (`ExecStart=/usr/local/bin/pboss __daemon`) — the Bun runtime is embedded in the binary and is **not required** on the system. On a **script install** (`bun add -g pboss`, npm) the service runs the source on the system Bun runtime (`ExecStart=/usr/local/bin/bun run .../daemon.ts`). The generated file's header comment states which mode was detected.

The unit/agent `PATH` deliberately includes the target user's `~/.bun/bin` whenever it exists (even on compiled installs): worker processes inherit the service's environment, so a worker shelling out to `bun` by name must resolve it. Independently of the unit file, the daemon self-heals its own `PATH` at startup (prepending the directory of the Bun it discovered) — so daemons started by **older** unit files also find Bun after a binary upgrade. See [Runtime discovery](#multi-language--runtime-support) for the full Bun discovery chain.

#### pboss startup status

A read-only report of boot persistence — nothing is started, installed, or changed:

```bash
pboss startup status
# Boot startup service (systemd)
#   Service:    /etc/systemd/system/pboss.service
#   Installed:  yes
#   Enabled:    yes — starts at boot (multi-user.target)
#   Active:     active
#   Daemon:     reachable (pid 1234) at /home/ra/.pboss/daemon.sock
#
# Reboot persistence:
#   Dump:       /home/ra/.pboss/dump.json
#   On boot:    3 process(es) come back running, 1 stopped
```

When the service is missing, the report says so and prints the exact install command; saved processes are reported as *waiting* for the service. When the dump is absent or empty, it says "nothing to restore yet" — starts are saved automatically, so the count appears the moment you run `pboss start`. The daemon socket and dump are read from the home the daemon actually uses (an explicit `PBOSS_HOME` wins; otherwise the target user's `~/.pboss`, `SUDO_USER`-aware under sudo).

The first `pboss start` on an empty machine also states where persistence stands — one line, only on a TTY (piped output stays clean for scripts): `✓ Persistence on: this process is saved and will come back after reboot` when the boot service is active, or the one command that enables it when it is not.

#### pboss startup generate

Print the service config for review (or to install by hand) without touching the system:

```bash
pboss startup generate
pboss startup generate win32   # generate for another OS
```

#### pboss startup uninstall (alias: pboss startup remove)

Remove the installed startup service (root on Linux — `sudo env PATH="$PATH" pboss startup uninstall`):

```bash
pboss startup uninstall
pboss startup remove   # same thing
```

On Windows, `schtasks /delete` reporting "cannot find" is surfaced honestly ("No PBOSS_Daemon scheduled task found — nothing to remove") instead of a fake success line.

#### pboss save

Save the current process list to `~/.pboss/dump.json`:

```
pboss save
```

This is now a manual re-save of an **automatic** mechanism — the list is persisted after every change (start, stop, restart, reload, delete, scale), so the dump always mirrors the live process list. You only need `pboss save` if you edited `dump.json` by hand or want to be extra sure.

The dump records whether each process was stopped. `pboss stop` means "keep it configured, but it should not run" — after a reboot it comes back in the stopped state, ready to `pboss restart <name>`. `pboss delete` removes the process from the list entirely — it never comes back. `pboss kill` (stopping the daemon itself) deliberately leaves the dump untouched, so the next boot (or `systemctl start pboss`) resurrects everything as it was.

#### pboss resurrect

Restore previously saved processes:

```
pboss resurrect
```

Running processes are kept as-is (no duplicates); saved-stopped processes are restored stopped; everything else is started. The systemd unit's `ExecStartPost` runs this automatically after every daemon start, including systemd-triggered restarts — a crashed daemon comes back and takes its process list with it.

#### What a reboot looks like

```
# once, at install time (the one-line installer does all of this):
curl -fsSL https://procboss.com/install.sh | sudo bash

# then just use pboss — every change is already persisted:
pboss start ecosystem.config.json
```

On reboot (or `systemctl start pboss` after a stop), the OS service starts the ProcBoss daemon, immediately resurrects the saved process list, and supervises it from there.

---

### Modules

ProcBoss supports a plugin system for extending functionality.

#### pboss module install

Install a module from a git URL, local path, or npm package name.

```
pboss module install https://github.com/user/pboss-logrotate.git
pboss module install ./my-pboss-module
pboss module install pboss-prometheus-pushgateway
```

#### pboss module list

List installed modules.

```
pboss module list
```

#### pboss module uninstall

Remove an installed module.

```
pboss module uninstall pboss-prometheus-pushgateway
```

#### Writing a ProcBoss Module

A ProcBoss module is a package with a default export implementing the PBossModule interface:

```
// my-module/index.ts
import type { ProcessManager } from "pboss";

export default {
  name: "my-module",
  version: "1.0.0",

  init(pm: ProcessManager) {
    console.log("[my-module] Initialized with", pm.list().length, "processes");
  },

  destroy() {
    console.log("[my-module] Destroyed");
  },
};
```

---

### Daemon Control

#### pboss ping

Check if the daemon is running.

```
pboss ping
```

#### pboss kill

Stop all processes and kill the daemon.

```
pboss kill
```

---

## ProcBoss Cloud

ProcBoss Cloud (procboss.com) is the optional hosted layer on top of pboss. Link a machine once and it streams live state to your dashboard — fleet view, CPU/memory, process lists, crash alerts — and accepts remote process commands. Every local feature keeps working without an account; the connection is **outbound-only** (the cloud can never reach into your network — the agent opens an SSE stream and posts state over HTTPS, and commands ride that same stream back).

### Linking a server — the device-code flow

Servers are headless, so the login can't be "open a browser here." Instead it's an RFC-8628-style device code, approved from **any** device:

```bash
sudo pboss cloud connect

# ⚡ ProcBoss Cloud — connect this server
#
#   Open:  https://procboss.com/connect
#   Code:  3RJD-TZJD-K2M4
#
#   No browser here — open the URL on any device (laptop/phone) and enter the code.
# Waiting for authorization… (code expires in 10 min)
# ✓ Server authorized and connected
```

What happens: the CLI requests a device code (`POST /api/device/code`, carrying hostname/OS/arch/agent version — the approval card shows exactly these facts), prints the URL plus the short human code, and polls. You open the URL anywhere, sign in with GitHub or Google, and approve or deny the card. On approval the cloud links (or re-links) the Server row, and the CLI's next poll claims the per-server credential — minted at that moment, handed over **exactly once**. The CLI then hands it to the daemon via the local socket: the daemon writes `~/.pboss/cloud.json` (0600) and owns the connection from there on. Denials, expiries (10 minutes), and the single-claim rule are all honest errors at the terminal.

Flags: `--url <cloud>` overrides the endpoint (else `PBOSS_CLOUD_URL`, else `https://procboss.com`); `--no-browser` (or `PBOSS_NO_BROWSER=1`) skips the auto-open attempt. On a machine with a desktop session the CLI tries to open the tab for you — over SSH without `DISPLAY` it stays print-only, which is exactly right for servers.

The legacy pasted-token flow still works: mint a single-use token in the dashboard and run `pboss cloud connect pbc_…` — useful when the terminal can't reach the approval URL interactively.

Other commands:

```bash
pboss cloud status              # link state: connected / backoff, server id, last report
pboss cloud servers             # the fleet this account sees, with live presence
pboss cloud reconnect           # retry the link now (resets backoff)
pboss cloud disconnect          # unlink: revoke the credential + remove cloud.json
```

### User login (pboss login / whoami / logout)

Machine identity (cloud.json) and user identity (cloud-user.json) are deliberately separate. `pboss login` runs the same device flow with **user scope** and stores a CLI token in `~/.pboss/cloud-user.json` (0600) — whoami/logout work from any machine and never link the daemon:

```bash
pboss login                     # device flow, user scope
pboss whoami                    # email, name, provider, cloud URL
pboss logout                    # revokes the CLI token server-side (this device only)
```

Revoking a server in the dashboard never logs you out of your CLI, and logging out never unlinks a server — each credential dies alone.

### Updating pboss (pboss upgrade)

`pboss upgrade` self-updates the CLI through the **same channel that installed it**, so a machine never accumulates two copies of pboss. The installers record their channel in `~/.pboss/channel.json` at install time, and the upgrade honors it:

| Installed via | Upgrade runs |
|---|---|
| universal installer (curl \| sudo bash / install.ps1) | the same installer, again — it's idempotent |
| `npm i -g pboss` | `npm install -g pboss@latest` |
| `bun add -g pboss` | `bun add -g pboss@latest` |
| Homebrew | `brew upgrade pboss` |
| snap | `sudo snap refresh pboss` |

Machines installed before the stamp existed are covered by runtime detection from the executable's own location (`/usr/local/bin/pboss` → universal, `…/Cellar/pboss/…` → brew, `/snap/pboss/…` → snap, a `node_modules` path → npm/bun, a repo checkout → source). If the detection is wrong, `pboss upgrade --channel brew` repairs it and persists the answer.

```bash
pboss upgrade --check       # dry run: current/latest/channel/command, changes nothing
pboss upgrade                # confirm, then upgrade through the detected channel
pboss upgrade --yes          # scripted — skip the [y/N] prompt
pboss upgrade --channel npm  # fix a misdetected channel (persists)
```

Version numbers come from the npm registry (the canonical source every channel builds from). After an upgrade the daemon keeps running the previous code until you restart it — `pboss upgrade` detects a live daemon and prints the exact `pboss kill && pboss resurrect` line to run.

### What the cloud link does

Once linked, the daemon's cloud agent:

- keeps ONE **WebSocket** open to the cloud (`wss://…/ws/agent`, outbound-only) — commands, state reports, results and live log frames all flow over it, with automatic reconnect (exponential backoff, reset on success);
- sends a **full state report** every 10 seconds (and immediately after every command): server metrics (CPU, memory, uptime) and the process list with per-process CPU/mem/restarts/crashes/uptime;
- derives **events** from consecutive snapshots — crashes (with exit code, signal and a 30-line log tail for the cloud's crash reports), restarts, on/offline transitions — which the cloud turns into alerts;
- executes **remote commands** from the dashboard: `process.list`, `process.start`, `process.stop`, `process.restart`, `process.delete`, `process.logs`, `process.deploy`, `server.info`, `server.deploy` — each answered with a result and followed by a fresh state report;
- **tails logs live** when a dashboard opens them (`log.watch` / `log.unwatch` control frames; new lines are pushed as they land on disk);
- **deploys** by running `git pull --ff-only` in the process's working directory and restarting it — the dashboard's Deploy button reports the real commit, message and duration. Working directories that aren't git checkouts fail honestly;
- answers `pboss cloud servers` with the fleet view (fetched daemon-side with the machine credential — the CLI never holds the secret).

If the credential is revoked from the dashboard, the cloud closes the WebSocket with code 4001: the agent stops, clears `cloud.json`, and says so — re-link with `pboss cloud connect`.

### Cloud security model

- **No inbound anything.** The agent makes outbound HTTPS/WSS connections only; there is no port to open and no attack surface facing the internet.
- **Secrets never rest in plaintext server-side.** Machine secrets and CLI tokens are stored as sha256 hashes; raw forms exist only in the local 0600 files and in memory.
- **Single-claim device codes.** A credential is minted at claim time and handed over exactly once; a raced second poller gets nothing. Codes expire in 10 minutes and are denied on the approval card.
- **Separate revocable identities.** Server credentials, CLI tokens, and browser sessions are three independent credential spaces — revoke one, the others don't flinch.
- **Approval shows the machine facts.** The /connect card displays hostname, OS, arch, and agent version before you approve, so you always know what you're linking.

### Self-hosting / custom cloud endpoint

Everything cloud-related resolves through one knob: `--url` on `connect`/`login`, else the `PBOSS_CLOUD_URL` environment variable, else `https://procboss.com`. The full HTTP contract the agent and CLI speak (device flow, agent stream, state, commands) is documented at [docs.procboss.com/cloud](https://docs.procboss.com/cloud) — point `PBOSS_CLOUD_URL` at a compatible implementation and pboss won't know the difference.

---

## Foreground Mode (Docker & Containers)

By default, ProcBoss spawns a background daemon process and returns immediately — ideal for long-running servers. However, containerized environments like **Docker**, **Kubernetes**, and **Railway** expect the entrypoint process to stay in the **foreground**. If ProcBoss daemonizes and exits, the container stops.

Use `--no-daemon` (alias `-d`) to run ProcBoss in **foreground / blocking mode**. In this mode:

- No background daemon is spawned.
- The `pboss start` process itself stays alive, blocking the terminal (or container).
- All managed child processes are supervised in-process.
- Auto-restart and crash recovery still work normally.
- The process exits only when all child processes stop or a signal (e.g. `SIGTERM`) is received.

### Flags

| Flag | Alias | Description |
|---|---|---|
| `--no-daemon` | `-d` | Run in foreground without spawning a background daemon |

### Usage

```bash
# Foreground — blocks until the process exits
pboss start --no-daemon server.ts

# Flag order is flexible — these are all equivalent
pboss start server.ts --no-daemon
pboss start --no-daemon server.ts --name api
pboss start --name api --no-daemon server.ts
```

### Docker

This is the recommended pattern for running ProcBoss inside a Docker container. The `CMD` instruction should use `--no-daemon` so ProcBoss stays as PID 1 (or the foreground entrypoint) and Docker can track its lifecycle correctly.

**Dockerfile**

```dockerfile
FROM oven/bun:latest

WORKDIR /app

COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile

COPY . .

# Install ProcBoss globally
RUN bun add -g pboss

# Use --no-daemon so ProcBoss stays in the foreground
CMD ["pboss", "start", "--no-daemon", "./server.ts"]
```

### Docker logs and log files

Use `--raw` with `--no-daemon` to keep ProcBoss log files while also exposing the
managed process output to the container runtime:

```dockerfile
CMD ["pboss", "start", "--no-daemon", "--raw", "ecosystem.config.cjs"]
```

`--raw` mirrors child stdout to ProcBoss stdout and child stderr to ProcBoss stderr. It
does not disable `outFile` or `errorFile`.

**With additional options**

```dockerfile
CMD ["pboss", "start", "--no-daemon", "--name", "api", "--instances", "2", "./server.ts"]
```

**With an ecosystem file**

```dockerfile
CMD ["pboss", "start", "--no-daemon", "ecosystem.config.json"]
```

> **Note:** Ecosystem file support with `--no-daemon` behaves identically to normal mode — all `apps` entries are started and supervised in-process.

### Docker Compose

```yaml
services:
  api:
    build: .
    ports:
      - "3000:3000"
    command: ["pboss", "start", "--no-daemon", "./server.ts"]
    restart: unless-stopped
```

### Kubernetes

```yaml
containers:
  - name: api
    image: your-org/api:latest
    command: ["pboss", "start", "--no-daemon", "./server.ts"]
```

### Behaviour Differences vs. Daemon Mode

| Behaviour | Daemon mode (default) | Foreground mode (`--no-daemon`) |
|---|---|---|
| CLI returns immediately | ✅ | ❌ — blocks |
| Background daemon spawned | ✅ | ❌ |
| Unix socket IPC | ✅ | ❌ |
| Auto-restart on crash | ✅ | ✅ |
| `pboss list` / `pboss logs` from another shell | ✅ | ❌ — no daemon to query |
| Suitable for Docker / containers | ❌ | ✅ |
| Suitable for long-running servers | ✅ | ✅ |

---

## Configuration Reference

### Ecosystem File Format

The ecosystem file is a JSON or TypeScript file with the following top-level structure:

```
interface EcosystemConfig {
  apps: StartOptions[];
  deploy?: Record<string, DeployConfig>;
}
```

---

### Process Options

The complete set of options available for each entry in the apps array:

| Option | Type | Default | Description |
|---|---|---|---|
| `name` | `string` | Filename | Process name |
| `script` | `string` | required | Path to the script to execute |
| `args` | `string[]` | `[]` | Arguments passed to the script |
| `cwd` | `string` | `process.cwd()` | Working directory |
| `env` | `Record<string, string>` | `{}` | Environment variables |
| `instances` | `number` or `"max"` | `1` | Number of instances |
| `execMode` | `"fork"` or `"cluster"` | `"fork"` | Execution mode |
| `autorestart` | `boolean` | `true` | Restart on crash |
| `maxRestarts` | `number` | `16` | Maximum restart attempts before giving up |
| `minUptime` | `number` | `1000` | Minimum ms a process must be up to be considered stable |
| `maxMemoryRestart` | `string` or `number` | — | Memory threshold for restart |
| `restartDelay` | `number` | `0` | Delay in ms between restart attempts |
| `killTimeout` | `number` | `5000` | Grace period in ms before SIGKILL |
| `interpreter` | `string` | Auto | Custom interpreter |
| `interpreterArgs` | `string[]` | — | Arguments for the interpreter |
| `nodeArgs` | `string[]` | — | Additional runtime arguments |
| `namespace` | `string` | — | Namespace for grouping processes |
| `sourceMapSupport` | `boolean` | `false` | Enable source map support |
| `waitReady` | `boolean` | `false` | Wait for process to emit ready signal |
| `listenTimeout` | `number` | `3000` | Timeout when waiting for ready signal |
| `noDaemon` | `boolean` | `false` | Run in foreground without a daemon |

---

### Cluster Options

| Option | Type | Default | Description |
|---|---|---|---|
| `instances` | `number` or `"max"` | `1` | Worker count |
| `execMode` | `"cluster"` | `"fork"` | Set to cluster for multi-instance mode |
| `port` | `number` | — | Base port. Worker i gets port + i |

---

### Log Options

| Option | Type | Default | Description |
|---|---|---|---|
| `outFile` | `string` | `~/.pboss/logs/<name>-<id>-out.log` | Custom stdout log path |
| `errorFile` | `string` | `~/.pboss/logs/<name>-<id>-error.log` | Custom stderr log path |
| `mergeLogs` | `boolean` | `false` | Merge all instance logs into one file |
| `raw` | `boolean` | `false` | Mirror child stdout and stderr to ProcBoss stdout and stderr |
| `logDateFormat` | `string` | — | Date format for log line prefixes |
| `logMaxSize` | `string` or `number` | `"10M"` | Max log file size before rotation |
| `logRetain` | `number` | `5` | Number of rotated files to keep |
| `logCompress` | `boolean` | `false` | Gzip-compress rotated log files |

---

### Health Check Options

| Option | Type | Default | Description |
|---|---|---|---|
| `healthCheckUrl` | `string` | — | URL to probe |
| `healthCheckInterval` | `number` | `30000` | Probe interval in ms |
| `healthCheckTimeout` | `number` | `5000` | Probe timeout in ms |
| `healthCheckMaxFails` | `number` | `3` | Consecutive failures before restart |

---

### Watch Options

| Option | Type | Default | Description |
|---|---|---|---|
| `watch` | `boolean` or `string[]` | `false` | Enable file watching |
| `ignoreWatch` | `string[]` | `["node_modules", ".git", ".pboss"]` | Patterns to ignore |

---

### Deploy Configuration

| Option | Type | Description |
|---|---|---|
| `user` | `string` | SSH user |
| `host` | `string` or `string[]` | Remote host(s) |
| `ref` | `string` | Git ref to deploy |
| `repo` | `string` | Git repository URL |
| `path` | `string` | Remote deployment path |
| `preDeploy` | `string` | Command to run locally before deploy |
| `postDeploy` | `string` | Command to run remotely after deploy |
| `preSetup` | `string` | Command to run remotely during setup |
| `postSetup` | `string` | Command to run remotely after setup |
| `ssh_options` | `string` | Additional SSH options |
| `env` | `Record<string, string>` | Environment variables for remote commands |

---

## Web Dashboard

The ProcBoss dashboard is a self-contained web application served directly by the daemon. It requires no external dependencies. The HTML, CSS, JavaScript, and WebSocket server are all built in.

### Dashboard Features

**Process Overview** — Four summary cards showing counts of online and errored processes, total CPU usage, and aggregate memory consumption.

**System Information** — Platform, CPU count, load average, and memory usage with a visual progress bar.

**CPU and Memory Chart** — A real-time canvas-rendered chart showing aggregate CPU percentage and memory usage over the last 60 data points, updating every 2 seconds.

**Process Table** — A detailed table showing every managed process with columns for ID, name, status with color-coded badges, PID, CPU, memory, restart count, uptime, and action buttons for restart, stop, and log viewing.

**Log Viewer** — A tabbed log panel that streams stdout and stderr from any selected process, with syntax highlighting for timestamps and error output. Logs auto-scroll to the latest entry.

**Live Updates** — All data is streamed over WebSocket with a visual pulse indicator confirming the live connection. If the connection drops, the dashboard automatically reconnects within 2 seconds.

---

### REST API

The dashboard exposes a REST API on the same port:

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/` | Dashboard HTML |
| `GET` | `/api/processes` | List all processes as JSON |
| `GET` | `/api/metrics` | Current metrics snapshot |
| `GET` | `/api/metrics/history?seconds=300` | Historical metrics |
| `GET` | `/api/prometheus` or `/metrics` | Prometheus text format |
| `POST` | `/api/restart` | Restart process |
| `POST` | `/api/stop` | Stop process |
| `POST` | `/api/reload` | Graceful reload |
| `POST` | `/api/delete` | Delete process |
| `POST` | `/api/scale` | Scale process |
| `POST` | `/api/flush` | Flush logs |

POST endpoints accept JSON body with `target` field for process identification and additional fields where applicable such as `count` for scaling.

Example using curl:

```
curl http://localhost:9615/api/processes
```

```
curl -X POST http://localhost:9615/api/restart \
  -H "Content-Type: application/json" \
  -d '{"target": "my-api"}'
```

```
curl -X POST http://localhost:9615/api/scale \
  -H "Content-Type: application/json" \
  -d '{"target": "my-api", "count": 8}'
```

```
curl http://localhost:9615/metrics
```

---

### WebSocket API

Connect to `ws://localhost:9615/ws` for real-time bidirectional communication.

Client to server messages:

```
{ "type": "getState", "data": {} }
```

```
{ "type": "getLogs", "data": { "target": 0, "lines": 50 } }
```

```
{ "type": "restart", "data": { "target": "my-api" } }
```

```
{ "type": "stop", "data": { "target": 0 } }
```

```
{ "type": "reload", "data": { "target": "all" } }
```

```
{ "type": "scale", "data": { "target": "my-api", "count": 4 } }
```

Server to client messages:

```
{
  "type": "state",
  "data": {
    "processes": [],
    "metrics": {
      "timestamp": 1707650400000,
      "processes": [],
      "system": {}
    }
  }
}
```

```
{
  "type": "logs",
  "data": [
    { "name": "my-api-0", "id": 0, "out": "...", "err": "..." }
  ]
}
```

---

## Prometheus and Grafana Integration

ProcBoss runs a dedicated Prometheus metrics server on default port 9616 separately from the dashboard, following best practices for metrics collection.

### Prometheus Configuration

Add the following to your `prometheus.yml`:

```
scrape_configs:
  - job_name: "pboss"
    scrape_interval: 5s
    static_configs:
      - targets: ["localhost:9616"]
```

### Available Metrics

| Metric | Type | Labels | Description |
|---|---|---|---|
| `pboss_process_cpu` | gauge | `name`, `id` | CPU usage percentage |
| `pboss_process_memory_bytes` | gauge | `name`, `id` | Memory usage in bytes |
| `pboss_process_restarts_total` | counter | `name`, `id` | Total restart count |
| `pboss_process_uptime_seconds` | gauge | `name`, `id` | Uptime in seconds |
| `pboss_process_status` | gauge | `name`, `id`, `status` | 1 if online, 0 otherwise |
| `pboss_system_memory_total_bytes` | gauge | — | Total system memory |
| `pboss_system_memory_free_bytes` | gauge | — | Free system memory |
| `pboss_system_load_average` | gauge | `period` | Load average (1m, 5m, 15m) |

### Grafana Dashboard

Import a dashboard with the following panels for comprehensive monitoring: Process Status Overview as a stat panel colored by status, CPU Usage per Process as a time series with `pboss_process_cpu` grouped by name, Memory Usage per Process as a time series with `pboss_process_memory_bytes` grouped by name, Restart Rate as a graph of `rate(pboss_process_restarts_total[5m])` to detect instability, System Load as a time series of `pboss_system_load_average` across all periods, and Memory Pressure as a gauge computing `1 - (pboss_system_memory_free_bytes / pboss_system_memory_total_bytes)`.

### Alert Rules Example

```
groups:
  - name: pboss
    rules:
      - alert: ProcessDown
        expr: pboss_process_status == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Process {{ $labels.name }} is down"

      - alert: HighRestartRate
        expr: rate(pboss_process_restarts_total[5m]) > 0.1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Process {{ $labels.name }} is restarting frequently"

      - alert: HighMemoryUsage
        expr: pboss_process_memory_bytes > 1e9
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Process {{ $labels.name }} using > 1GB memory"
```

---

## Programmatic API

ProcBoss exposes a complete programmatic API. A single machine only needs **one instance** of the process manager — every API function, static method, and singleton instance automatically communicates with that single machine-level daemon.

### Zero-Ceremony Quick Start

You can import and call API methods directly without any initialization, construction (`new`), or connection ceremony:

```ts
// 1. Direct function exports (Zero initialization needed)
import { getProcesses, list, describe, start, stop, restart } from "pboss";

// Read existing processes immediately
const processes = await getProcesses();
console.log(processes);

// Start, stop, or manage processes
await start({ script: "./server.ts", name: "api", instances: 4, port: 3000 });
await restart("api");
```

```ts
// 2. Default singleton import
import pboss from "pboss";

const procs = await pboss.list();
const metrics = await pboss.metrics();
```

```ts
// 3. PBoss Class & Static Methods
import PBoss from "pboss";

const procs = await PBoss.list();
const info = await PBoss.describe("api");
```

---

### Reading Existing Processes Without Initialization

Anyone can read existing processes from disk or the running daemon without having to start or initialize anything:

#### `getProcesses(): Promise<ProcessState[]>`

Retrieves all managed processes on the machine. If the daemon is active, it returns live running processes. If the daemon is offline, it automatically reads saved process definitions from disk (`~/.pboss/dump.json`) **without spawning a background daemon**:

```ts
import { getProcesses } from "pboss";

const processes = await getProcesses();
for (const p of processes) {
  console.log(`${p.name} (id: ${p.pm_id}) - ${p.status}`);
}
```

#### `readSavedProcesses(): Promise<ProcessState[]>`

Directly parses and returns the persisted process list from `~/.pboss/dump.json` with zero daemon or socket involvement:

```ts
import { readSavedProcesses } from "pboss";

const saved = await readSavedProcesses();
```

---

### Connection Lifecycle

#### `pboss.connect(): Promise<PBoss>`

Explicitly connect to the ProcBoss daemon. If the daemon is not running, it is spawned automatically and the method waits up to 5 seconds for it to become responsive. Returns the `PBoss` instance for chaining.

> **Note:** All API methods auto-connect on demand, so calling `.connect()` explicitly is optional and only needed if you want to listen for connection lifecycle events before executing commands.

```ts
import PBoss from "pboss";

const pboss = new PBoss();
await pboss.connect();
console.log(`Connected to daemon PID ${pboss.daemonPid}`);
```

#### `pboss.disconnect(): Promise<void>`

Disconnect from the daemon. This stops any internal polling timers but does not kill the daemon — all managed processes continue running.

```ts
await pboss.disconnect();
console.log(pboss.connected); // false
```

#### `pboss.connected: boolean`

Read-only property indicating whether the client is currently connected to the daemon.

#### `pboss.daemonPid: number | null`

Read-only property containing the PID of the daemon process, or `null` if unknown.

---

### Programmatic Process Management

#### `start(options: StartOptions): Promise<ProcessState[]>`

Start a new process or process group. The `script` path is automatically resolved to an absolute path. Returns the array of `ProcessState` objects for the started instances.

```ts
import { start } from "pboss";

const procs = await start({
  script: "./worker.ts",
  name: "worker",
  instances: 2,
  env: { QUEUE: "emails" },
  maxMemoryRestart: "256M",
});
console.log(`Started ${procs.length} instances`);
```

#### `startTarget(target: string | number): Promise<ProcessState[]>`

Start (resume) processes that **already exist**, by id, name, or namespace — the group-level counterpart of `start`. Every matched process that is not running comes back online; online ones are untouched; nothing is created from a script. Throws a clear error when nothing matches the target (except `"all"`).

```ts
import { startTarget } from "pboss";

await startTarget("stellarforge"); // every stopped member of the namespace
await startTarget("api");          // one process, by name
```

#### `startEcosystem(config: EcosystemConfig): Promise<ProcessState[]>`

Start an entire ecosystem configuration. All script paths within the config are resolved to absolute paths before being sent to the daemon.

```ts
import { startEcosystem } from "pboss";

const procs = await startEcosystem({
  apps: [
    { script: "./api.ts", name: "api", instances: 4, port: 3000 },
    { script: "./worker.ts", name: "worker", instances: 2 },
  ],
});
```

#### `stop(target?: string | number): Promise<ProcessState[]>`

Stop one or more processes. The `target` can be a process name, numeric ID, namespace, or `"all"`. Defaults to `"all"` when omitted.

```ts
import { stop } from "pboss";

await stop("api");       // Stop by name
await stop(0);           // Stop by ID
await stop();            // Stop all
```

#### `restart(target?: string | number): Promise<ProcessState[]>`

Hard restart one or more processes. The process is fully stopped and then re-spawned.

```ts
import { restart } from "pboss";

await restart("api");
await restart();          // Restart all
```

#### `reload(target?: string | number): Promise<ProcessState[]>`

Graceful zero-downtime reload. New instances are started before old ones are stopped, ensuring no dropped requests. Ideal for deploying new code.

```ts
import { reload } from "pboss";

await reload("api");
await reload();           // Reload all
```

#### `del(target?: string | number): Promise<ProcessState[]>` / `delete(target?)`

Stop and remove one or more processes from ProcBoss's management entirely.

```ts
import { del } from "pboss";

await del("api");
await del();           // Delete all
```

#### `scale(target: string | number, count: number): Promise<ProcessState[]>`

Scale a process group to the specified number of instances. When scaling up, new instances inherit the configuration of existing ones. When scaling down, the highest-numbered instances are removed first.

```ts
import { scale } from "pboss";

await scale("api", 8);   // Scale up to 8 instances
await scale("api", 2);   // Scale down to 2 instances
```

#### `sendSignal(target: string | number, signal: string): Promise<void>`

Send an OS signal to a managed process.

```ts
import { sendSignal } from "pboss";

await sendSignal("api", "SIGUSR2");
await sendSignal(0, "SIGHUP");
```

#### `reset(target?: string | number): Promise<ProcessState[]>`

Reset the restart counter for one or more processes. Defaults to `"all"`.

```ts
import { reset } from "pboss";

await reset("api");
await reset();            // Reset all
```

---

### Introspection

#### `list(): Promise<ProcessState[]>`

List all managed processes with their current state.

```ts
import { list } from "pboss";

const processes = await list();
for (const proc of processes) {
  console.log(`${proc.name} [${proc.status}] PID=${proc.pid} CPU=${proc.monit.cpu}%`);
}
```

#### `describe(target: string | number): Promise<ProcessState[]>`

Get detailed information about a specific process or process group.

```ts
import { describe } from "pboss";

const details = await describe("api");
console.log(details[0]);
```

---

### Logs

#### `logs(target?: string | number, lines?: number): Promise<LogItem[]>`

Retrieve recent log lines for one or all processes. Defaults to `"all"` with `20` lines.

```ts
import { logs } from "pboss";

const logItems = await logs("api", 100);
for (const entry of logItems) {
  console.log(`[${entry.name} | ${entry.ts}] ${entry.msg}`);
}
```

#### `streamLogs(target: string | number, callback: (log: LogItem) => void, signal?: AbortSignal): Promise<void>`

Stream live logs in real time as they are emitted:

```ts
import { streamLogs } from "pboss";

await streamLogs("api", (log) => {
  console.log(`[${log.name}] ${log.msg}`);
});
```

#### `flush(target?: string | number): Promise<void>`

Truncate log files for one or all processes.

```ts
import { flush } from "pboss";

await flush("api");      // Flush logs for "api"
await flush();            // Flush all logs
```

---

### Programmatic Monitoring and Metrics

#### `metrics(): Promise<MetricSnapshot>`

Take a single metrics snapshot containing process-level and system-level telemetry.

```ts
import { metrics } from "pboss";

const snapshot = await metrics();
console.log(`System CPU Count: ${snapshot.system.cpuCount}`);
for (const proc of snapshot.processes) {
  console.log(`  ${proc.name}: ${proc.memory} bytes, ${proc.cpu}% CPU`);
}
```

#### `pboss.metricsHistory(seconds?: number): Promise<MetricSnapshot[]>`

Retrieve historical metric snapshots from the daemon's in-memory ring buffer. The `seconds` parameter controls the look-back window and defaults to `300` (5 minutes). The daemon retains up to 1 hour of per-second snapshots.

```ts
const history = await pboss.metricsHistory(600);   // Last 10 minutes
console.log(`Got ${history.length} snapshots`);
```

#### `pboss.prometheus(): Promise<string>`

Get the current metrics formatted as a Prometheus exposition text string.

```ts
const text = await pboss.prometheus();
console.log(text);
// # HELP pboss_process_cpu CPU usage percentage
// # TYPE pboss_process_cpu gauge
// pboss_process_cpu{name="api-0",id="0"} 1.2
// ...
```

#### `pboss.startPolling(intervalMs?: number): void`

Start polling the daemon for metrics at a fixed interval and emitting `"metrics"` events. Defaults to `2000` ms. Calling this again replaces the existing polling timer.

```ts
pboss.on("metrics", (snapshot) => {
  console.log(`${snapshot.processes.length} processes running`);
});
pboss.startPolling(1000);       // Poll every second
```

#### `pboss.stopPolling(): void`

Stop the metrics polling loop.

```ts
pboss.stopPolling();
```

---

### Persistence

#### `pboss.save(): Promise<void>`

Persist the current process list to `~/.pboss/dump.json` so it can be restored later.

```ts
await pboss.save();
```

#### `pboss.resurrect(): Promise<ProcessState[]>`

Restore previously saved processes from `~/.pboss/dump.json`.

```ts
const restored = await pboss.resurrect();
console.log(`Restored ${restored.length} processes`);
```

---

### Cron Jobs

#### `pboss.cronAdd(schedule, command, options?): Promise<CronJob>`

Schedule a standalone command. The schedule accepts the friendly syntax (`everyday@9:11`, `every-sunday@10:10`, `every-15th@10:10`, `every-6-hours@30`, `every-second`, `every-30-seconds`, `today@23:10`, `tomorrow@8:00`, `on-date@24-10-2026-23:10`) or a raw 5-field cron expression (6 fields adds a seconds step).

```ts
const job = await pboss.cronAdd("everyday@9:11", "bun backup.ts", { name: "backup" });
console.log(`Next run: ${new Date(job.nextRun!).toISOString()}`);
```

#### `pboss.cronJobs(): Promise<CronJob[]>`

List all scheduled jobs with their state, next run, run count, and last exit code.

```ts
for (const job of await pboss.cronJobs()) {
  console.log(`${job.name} — ${job.description} (runs: ${job.runCount})`);
}
```

#### `pboss.cronNext(target, count?): Promise<number[]>`

Preview the next `count` run times (epoch milliseconds) of a job.

```ts
const times = await pboss.cronNext("backup", 5);
```

#### `pboss.cronTrigger(target): Promise<CronJob>`

Run a job immediately without waiting for its schedule. The schedule itself is unaffected.

```ts
const job = await pboss.cronTrigger("backup");
console.log(`exit code: ${job.lastExitCode}`);
```

#### `pboss.cronRemove(target): Promise<CronJob>`

Remove a job by id or name.

```ts
await pboss.cronRemove("backup");
```

Standalone equivalents are exported too: `cronAdd()`, `cronJobs()`, `cronNext()`, `cronTrigger()`, `cronRemove()`. Jobs can also be declared in ecosystem files via the top-level `crons` array — see [Cron Jobs](#cron-jobs).

---

### Dashboard Control

#### `pboss.dashboard(port?: number, metricsPort?: number): Promise<{ port: number; metricsPort: number }>`

Start the web dashboard. Defaults to port `9615` for the dashboard and `9616` for the Prometheus metrics endpoint.

```ts
const { port, metricsPort } = await pboss.dashboard(8080, 8081);
console.log(`Dashboard: http://localhost:${port}`);
console.log(`Metrics:   http://localhost:${metricsPort}/metrics`);
```

#### `pboss.dashboardStop(): Promise<void>`

Stop the web dashboard.

```ts
await pboss.dashboardStop();
```

---

### Module Management

#### `pboss.moduleInstall(nameOrPath: string): Promise<{ path: string }>`

Install a ProcBoss module from a git URL, local path, or npm package name.

```ts
const result = await pboss.moduleInstall("pboss-prometheus-pushgateway");
console.log(`Installed to ${result.path}`);
```

#### `pboss.moduleUninstall(name: string): Promise<void>`

Uninstall a ProcBoss module.

```ts
await pboss.moduleUninstall("pboss-prometheus-pushgateway");
```

#### `pboss.moduleList(): Promise<Array<{ name: string; version: string }>>`

List all installed modules.

```ts
const modules = await pboss.moduleList();
for (const mod of modules) {
  console.log(`${mod.name}@${mod.version}`);
}
```

---

### Daemon Lifecycle

#### `pboss.ping(): Promise<{ pid: number; uptime: number }>`

Ping the daemon and return its PID and uptime in milliseconds.

```ts
const info = await pboss.ping();
console.log(`Daemon PID ${info.pid}, up for ${Math.round(info.uptime / 1000)}s`);
```

#### `pboss.kill(): Promise<void>`

Kill the daemon and all managed processes. Cleans up the socket and PID files. The daemon connection will not respond after this call, which is expected.

```ts
await pboss.kill();
console.log(pboss.connected); // false
```

#### `pboss.daemonReload(): Promise<string>`

Reload the daemon server itself without killing managed processes.

```ts
const result = await pboss.daemonReload();
console.log(result);
```

---

### Low-Level Transport

#### `pboss.send(message: DaemonMessage): Promise<DaemonResponse>`

Send an arbitrary message to the daemon over the Unix socket and return the raw response. This is useful for custom command types, future extensions, or direct daemon interaction.

```ts
const response = await pboss.send({ type: "ping" });
console.log(response);
// { success: true, data: { pid: 12345, uptime: 60000 }, id: "abc123" }
```

Messages are JSON objects with a `type` field for routing and an optional `id` field for request-response correlation (auto-generated if omitted). The `data` field carries command-specific payload.

---

### Events

The `PBoss` class extends `EventEmitter` and emits the following typed events:

| Event | Payload | Description |
|---|---|---|
| `daemon:connected` | — | Daemon connection established |
| `daemon:disconnected` | — | Client disconnected from daemon |
| `daemon:launched` | `pid: number` | Daemon was spawned by this client |
| `daemon:killed` | — | Daemon was killed via `kill()` |
| `error` | `error: Error` | Transport or polling error |
| `process:start` | `processes: ProcessState[]` | Process(es) started |
| `process:stop` | `processes: ProcessState[]` | Process(es) stopped |
| `process:restart` | `processes: ProcessState[]` | Process(es) restarted |
| `process:reload` | `processes: ProcessState[]` | Process(es) reloaded |
| `process:delete` | `processes: ProcessState[]` | Process(es) deleted |
| `process:scale` | `processes: ProcessState[]` | Process group scaled |
| `metrics` | `snapshot: MetricSnapshot` | Metrics snapshot received |
| `log:data` | `logs: Array<{ name, id, out, err }>` | Log data retrieved |
| `cron:add` | `job: CronJob` | A standalone cron job was scheduled |
| `cron:remove` | `job: CronJob` | A standalone cron job was removed |

```ts
import PBoss from "pboss";

const pboss = new PBoss();

pboss.on("daemon:connected", () => console.log("Connected!"));
pboss.on("daemon:disconnected", () => console.log("Disconnected"));
pboss.on("process:start", (procs) => {
  console.log("Started:", procs.map((p) => p.name).join(", "));
});
pboss.on("process:stop", (procs) => {
  console.log("Stopped:", procs.map((p) => p.name).join(", "));
});
pboss.on("error", (err) => console.error("ProcBoss error:", err.message));
pboss.on("metrics", (snapshot) => {
  console.log(`${snapshot.processes.length} processes, system CPU ${snapshot.system.cpu}%`);
});

await pboss.connect();
```

---

### Error Handling

All methods that communicate with the daemon throw a `PBossError` when the daemon returns a failure response. The error includes the command that failed and the full daemon response for inspection.

```ts
import { PBossError } from "pboss";

try {
  await pboss.describe("nonexistent");
} catch (err) {
  if (err instanceof PBossError) {
    console.error(`Command "${err.command}" failed: ${err.message}`);
    console.error("Full response:", err.response);
  }
}
```

Transport-level errors (daemon unreachable, socket closed) throw standard `Error` instances.

#### `PBossError` Properties

| Property | Type | Description |
|---|---|---|
| `message` | `string` | Human-readable error message |
| `command` | `string` | The daemon command type that failed |
| `response` | `DaemonResponse` | The full response object from the daemon |

---

### Direct ProcessManager Usage

For in-process usage without a running daemon, you can use the `ProcessManager` class directly. This is useful for embedding ProcBoss into your own application or for custom tooling.

```ts
import { ProcessManager } from "pboss";
import { Dashboard } from "pboss";

const pm = new ProcessManager();

// Start a process
const states = await pm.start({
  name: "my-api",
  script: "./server.ts",
  instances: 4,
  execMode: "cluster",
  port: 3000,
  env: { NODE_ENV: "production" },
  maxMemoryRestart: "512M",
  healthCheckUrl: "http://localhost:3000/health",
});

console.log("Started:", states.map((s) => `${s.name} (pid: ${s.pid})`));

// List processes
const list = pm.list();

// Get metrics
const metrics = await pm.getMetrics();

// Scale
await pm.scale("my-api", 8);

// Graceful reload
await pm.reload("my-api");

// Start the web dashboard
const dashboard = new Dashboard(pm);
dashboard.start(9615, 9616);

// Get Prometheus-format metrics
const promText = pm.getPrometheusMetrics();

// Save and restore
await pm.save();
await pm.resurrect();

// Stop everything
await pm.stopAll();
```

The `ProcessManager` provides the same process management capabilities but runs in-process rather than communicating with a daemon. Use the `PBoss` client class for the standard daemon-based workflow, and `ProcessManager` when you need direct, embedded control.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      ProcBoss (pboss) CLI                            │
│  (pboss start, pboss list, pboss restart, pboss dashboard)    │
└────────────────────────┬────────────────────────────────┘
                         │ Unix Socket (WebSocket)
                         │ ~/.pboss/daemon.sock
                         ▼
┌─────────────────────────────────────────────────────────┐
│                    ProcBoss Daemon                           │
│                                                         │
│  ┌─────────────────┐  ┌──────────────┐  ┌───────────┐  │
│  │ Process Manager  │  │   Dashboard  │  │  Modules  │  │
│  │                 │  │  (Bun.serve) │  │  (Plugins)│  │
│  │  ┌───────────┐  │  │  HTTP + WS   │  └───────────┘  │
│  │  │ Container │  │  │  REST API    │                  │
│  │  │ (Bun.spawn)│  │  └──────────────┘                 │
│  │  └───────────┘  │                                    │
│  │  ┌───────────┐  │  ┌──────────────┐  ┌───────────┐  │
│  │  │ Container │  │  │   Monitor    │  │  Metrics  │  │
│  │  │ (Bun.spawn)│  │  │  CPU/Memory │  │ Prometheus│  │
│  │  └───────────┘  │  └──────────────┘  │  :9616    │  │
│  │  ┌───────────┐  │                    └───────────┘  │
│  │  │ Container │  │  ┌──────────────┐                  │
│  │  │ (Bun.spawn)│  │  │ Health Check │                 │
│  │  └───────────┘  │  │  HTTP Probes │                  │
│  └─────────────────┘  └──────────────┘                  │
│                                                         │
│  ┌──────────┐ ┌──────────┐ ┌────────┐ ┌─────────────┐  │
│  │  Cluster │ │   Logs   │ │  Cron  │ │   Deploy    │  │
│  │  Manager │ │ Manager  │ │Manager │ │   Manager   │  │
│  └──────────┘ └──────────┘ └────────┘ └─────────────┘  │
└─────────────────────────────────────────────────────────┘
```

**Daemon Process** — The daemon is a long-running Bun process that manages all child processes. It listens on a Unix domain socket at `~/.pboss/daemon.sock` for commands from the CLI. The daemon is automatically started when you first run a ProcBoss command and can be explicitly killed with `pboss kill`.

**Process Container** — Each managed process is wrapped in a ProcessContainer that handles spawning via `Bun.spawn`, log piping, monitoring, restart logic, health checking, watch mode, and signal handling.

**IPC Protocol** — The CLI and daemon communicate over WebSocket on a Unix socket. Messages are JSON-encoded with a `type` field for routing and an `id` field for request-response correlation.

**Dashboard** — The dashboard is served by a `Bun.serve` instance with WebSocket upgrade support. A single HTTP server handles the dashboard UI, REST API, and WebSocket connections.

**Metrics Server** — A separate `Bun.serve` instance on port 9616 serves Prometheus metrics, keeping the scrape endpoint isolated from dashboard traffic.

---

## Recipes and Examples

### TypeScript / Bun Server

```bash
pboss start server.ts --name bun-api
```

### Node.js Server

```bash
pboss start server.js --interpreter node --name node-api
```

### Go Application (Source or Compiled)

```bash
# Run Go source directly
pboss start main.go --name go-dev

# Run compiled Go binary
pboss start ./dist/my-go-server --name go-prod --instances 4
```

### Python Worker / API

```bash
pboss start worker.py --name py-worker
```

### Java JAR Service

```bash
pboss start app.jar --name java-service
```

### Production API with Clustering and Health Checks

```bash
pboss start server.ts \
  --name api \
  --instances max \
  --port 3000 \
  --max-memory-restart 512M \
  --health-check-url http://localhost:3000/health \
  --health-check-interval 15000 \
  --log-max-size 50M \
  --log-retain 10 \
  --log-compress
```

### Development Mode with Watch

```bash
pboss start server.ts --name dev-api --watch --ignore-watch node_modules,.git,dist
```

### Scheduled Restart (Daily at 3 AM)

```
pboss start server.ts --name api --cron "0 3 * * *"
```

### Multiple Environments via Ecosystem

```
{
  "apps": [
    {
      "name": "api-staging",
      "script": "./server.ts",
      "env": { "NODE_ENV": "staging", "PORT": "3000" }
    },
    {
      "name": "api-production",
      "script": "./server.ts",
      "env": { "NODE_ENV": "production", "PORT": "8080" }
    }
  ]
}
```

### Docker Container (Foreground Mode)

```dockerfile
FROM oven/bun:latest
WORKDIR /app
COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun add -g pboss
CMD ["pboss", "start", "--no-daemon", "./server.ts"]
```

### Full Production Setup

```
pboss start ecosystem.config.json
pboss save
sudo env PATH="$PATH" pboss startup install
pboss dashboard
pboss list
```

### Monitoring with Prometheus and Grafana

```
pboss dashboard --metrics-port 9616
curl http://localhost:9616/metrics
```

Then add the target to your `prometheus.yml` and import the Grafana dashboard.

### Zero-Downtime Deploy

```
pboss deploy ecosystem.config.json production
```

Or manually:

```
git pull origin main
bun install
pboss reload all
```

### Programmatic Monitoring Service

```ts
import PBoss from "pboss";

const pboss = new PBoss();
await pboss.connect();

// Alert when any process uses more than 512 MB
pboss.on("metrics", (snapshot) => {
  for (const proc of snapshot.processes) {
    if (proc.memory > 512 * 1024 * 1024) {
      console.warn(`⚠️  ${proc.name} using ${Math.round(proc.memory / 1024 / 1024)} MB`);
    }
  }
});

pboss.startPolling(5000);

// Keep running
process.on("SIGINT", async () => {
  pboss.stopPolling();
  await pboss.disconnect();
  process.exit(0);
});
```

### Programmatic Deploy Pipeline

```ts
import PBoss from "pboss";

const pboss = new PBoss();
await pboss.connect();

// Deploy new code, then reload
console.log("Reloading all processes...");
const reloaded = await pboss.reload("all");
console.log(`Reloaded ${reloaded.length} processes`);

// Verify everything is healthy
const processes = await pboss.list();
const allOnline = processes.every((p) => p.status === "online");

if (allOnline) {
  console.log("✅ All processes online");
  await pboss.save();
} else {
  console.error("❌ Some processes failed to come online");
  const failed = processes.filter((p) => p.status !== "online");
  for (const p of failed) {
    console.error(`  ${p.name}: ${p.status}`);
  }
}

await pboss.disconnect();
```

---

## Troubleshooting

### Daemon won't start

If ProcBoss commands hang or return connection errors, the daemon may have died without cleanup.

```
rm -f ~/.pboss/daemon.sock ~/.pboss/daemon.pid
pboss list
```

### "the Bun runtime was not found on this system" — but bun IS installed

This happens when Bun lives in a location the daemon cannot see on its `PATH` — typically `~/.bun/bin` (the default `curl bun.sh/install` location) while the daemon was started by systemd/launchd with a minimal service PATH. `which bun` in your shell finds it because YOUR shell has that directory on PATH; the daemon does not.

pboss already searches `PATH`, `$BUN_INSTALL/bin`, `~/.bun/bin`, `/usr/local/bin`, `/usr/bin`, and `/opt/bun/bin` (plus `/opt/homebrew/bin` on macOS), so this error means Bun genuinely is not in any of them — for example a Bun installed only for a different user account than the one the daemon runs as. Check:

```
ls -l ~/.bun/bin/bun                 # the default location
echo $BUN_INSTALL                     # set by the bun.sh installer
sudo -u <daemon-user> ls ~/.bun/bin   # the daemon runs as YOU only when
                                      # startup install set User= correctly
pboss startup status                  # shows whose ~/.pboss the daemon uses
```

Fixes, in order of preference: install Bun for the daemon's user (`curl -fsSL https://bun.sh/install | bash`), set `BUN_INSTALL` in the unit (`systemctl edit pboss` → `Environment=BUN_INSTALL=/opt/bun`), or run the script under a different runtime (`--interpreter node`, `--interpreter none` for binaries). After installing Bun, restart the service (`sudo systemctl restart pboss`).

### Process keeps restarting

Check the error logs for crash information:

```
pboss logs my-app --err --lines 100
```

If the process exits too quickly, it may hit the max restart limit. Check `minUptime` and `maxRestarts` settings:

```
pboss describe my-app
```

Reset the counter if needed:

```
pboss reset my-app
```

### High memory usage

If a process is using excessive memory and you have `maxMemoryRestart` configured, ProcBoss will restart it automatically. You can also check the metrics history:

```
pboss metrics --history 3600
```

### Port conflicts

In cluster mode, each instance uses `basePort + instanceIndex`. Ensure no other services are using those ports:

```
lsof -i :3000-3007
```

### Log files growing too large

Enable log rotation:

```
pboss start server.ts --log-max-size 50M --log-retain 5 --log-compress
```

Or flush existing logs:

```
pboss flush my-app
```

### Dashboard not accessible

Ensure the dashboard is started and check the port:

```
pboss dashboard --port 9615
curl http://localhost:9615
```

If running behind a firewall, ensure port 9615 (dashboard) and 9616 (metrics) are open.

### Checking daemon health

```
pboss ping
```

This returns the daemon PID and uptime. If it doesn't respond, the daemon needs to be restarted.

### Container exits immediately

If your Docker container exits right after starting, you are likely missing `--no-daemon`. Without it, ProcBoss daemonizes and the foreground process exits, causing Docker to stop the container.

```dockerfile
# ❌ Wrong — ProcBoss daemonizes and the container exits
CMD ["pboss", "start", "./server.ts"]

# ✅ Correct — ProcBoss stays in the foreground
CMD ["pboss", "start", "--no-daemon", "./server.ts"]
```

---

## File Structure

ProcBoss stores all data in `~/.pboss/`:

```
~/.pboss/
├── daemon.sock          # Unix domain socket for IPC
├── daemon.pid           # Daemon process ID
├── dump.json            # Saved process list (pboss save)
├── config.json          # Global configuration
├── env-registry.json    # Stored environment variables
├── logs/                # Process log files
│   ├── my-api-0-out.log
│   ├── my-api-0-error.log
│   ├── my-api-0-out.log.1.gz
│   └── daemon-out.log
├── pids/                # PID files
│   └── my-api-0.pid
├── metrics/             # Persisted metric snapshots
└── modules/             # Installed ProcBoss modules
```

---

## Contributing

Contributions are welcome. Please follow these guidelines:

1. Fork the repository and create a feature branch.
2. Write tests for new functionality.
3. Follow the existing code style — TypeScript strict mode, no `any` where avoidable.
4. Run the test suite before submitting: `bun test`.
5. Submit a pull request with a clear description of the change.

### Development Setup

```
git clone https://github.com/procboss/pboss.git
cd pboss
bun install
bun run src/index.ts list
bun test
```

---

## License

GPL-3.0-only

Copyright (c) 2025 procboss.com

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

# ⚡ ProcBoss (pboss)

**A blazing-fast, full-featured process manager built entirely on Bun native APIs.**
The modern PM2 replacement — zero Node.js dependencies, pure Bun performance.

![Runtime](https://img.shields.io/badge/runtime-Bun-f472b6?style=flat-square)
![Language](https://img.shields.io/badge/language-TypeScript-3178c6?style=flat-square)
![License](https://img.shields.io/badge/license-GPLv3-green?style=flat-square)
[![Tests](https://github.com/procboss/pboss/actions/workflows/test.yml/badge.svg)](https://github.com/procboss/pboss/actions/workflows/test.yml)
[![GitHub Sponsors](https://img.shields.io/badge/sponsor-GitHub%20Sponsors-ea4aaa?style=flat-square&logo=github-sponsors)](https://github.com/sponsors/procboss)

---

### Support ProcBoss

ProcBoss (pboss) is free and open-source software built for the Bun community. If ProcBoss saves you time or powers your production services, please consider supporting its development:

- ⭐ **Star the Repo:** Star us on [GitHub](https://github.com/procboss/pboss) to help more developers discover ProcBoss.
- 🐛 **Contribute:** Open issues, suggest features, or submit pull requests.


### 💖 **Sponsor** ongoing maintenance
#### Crypto Donations

| Network / Ecosystem | Address |
|---|---|
| **Bitcoin (BTC)** | `bc1qkyxtyxsqw263268sp6uns5r6ag6h2864mkss5l` |
| **EVM** *(Ethereum, Base, Arbitrum, BNB Chain, Avalanche)* | `0x52CcA569bB086acDb9388E3c7Cf0753c0337C2e1` |
| **Solana** | `DKviNTJC9rst6tmQQgMVgd8QBsSztVPmd3d5MsPussUc` |
| **Sui** | `0x789494019f07d318125263a1730bb651aeab0ebb68f8f77f838dbf3e67a755cd` |

---

## Table of Contents

- [Support & Sponsor](#support-procboss)
- [Why ProcBoss?](#why-procboss)
- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [CLI Reference](#cli-reference)
  - [Process Management](#process-management)
  - [Cluster Mode](#cluster-mode)
  - [Log Management](#log-management)
  - [Monitoring and Metrics](#monitoring-and-metrics)
  - [Dashboard](#dashboard)
  - [Ecosystem Files](#ecosystem-files)
  - [Environment Management](#environment-management)
  - [Deployment](#deployment)
  - [Startup Scripts](#startup-scripts)
  - [Modules](#modules)
  - [Daemon Control](#daemon-control)
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
  - [Quick Start](#programmatic-quick-start)
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
- [Comparison with PM2](#comparison-with-pm2)
- [Recipes and Examples](#recipes-and-examples)
- [Troubleshooting](#troubleshooting)
- [File Structure](#file-structure)
- [Contributing](#contributing)
- [License](#license)

---

## Why ProcBoss?

PM2 is the de facto process manager for Node.js, but it carries years of legacy baggage, a heavy dependency tree, and is fundamentally built for the Node.js runtime. ProcBoss (pboss) is a ground-up reimagining of production process management designed exclusively for the Bun runtime.

ProcBoss replaces PM2's Node.js internals with Bun-native APIs. It uses `Bun.spawn` for process management, `Bun.serve` for the dashboard and IPC, native `WebSocket` for daemon communication, `Bun.file` for high-performance I/O, and `Bun.gzipSync` for log compression. The result is a process manager that starts faster, uses less memory, and leverages Bun's superior performance across the board.

---

## Features

**Core Process Management** — Start, stop, restart, reload, delete, and scale processes with automatic restart on crash, configurable restart strategies, memory-limit restarts, and tree killing.

**Cluster Mode** — Run multiple instances of your application with per-worker environment injection, automatic port assignment, and round-robin-ready configuration using `NODE_APP_INSTANCE` conventions.

**Zero-Downtime Reload** — Graceful reload cycles through instances sequentially, starting the new process before stopping the old one, ensuring your application never drops a request.

**Foreground / No-Daemon Mode** — Run ProcBoss in blocking foreground mode without spawning a background daemon. Designed for containerized environments like Docker, Kubernetes, and any platform that expects PID 1 to remain in the foreground.

**Real-Time Web Dashboard** — A built-in dark-themed web dashboard with live WebSocket updates, CPU/memory charts, process control buttons, and a log viewer. No external dependencies.

**Prometheus Metrics** — A dedicated metrics endpoint exports process and system telemetry in Prometheus exposition format, ready for scraping by Prometheus and visualization in Grafana.

**Log Management** — Automatic log capture with buffered writes, size-based rotation, configurable retention, optional gzip compression, log flushing, and real-time tailing.

**Health Checks** — HTTP health check probes with configurable intervals, timeouts, and failure thresholds that automatically restart unhealthy processes.

**Cron Restarts** — Schedule periodic restarts using standard cron expressions for applications that benefit from regular recycling.

**File Watching** — Automatic restart on file changes with configurable watch paths and ignore patterns. Ideal for development workflows.

**Ecosystem Files** — Declare your entire application topology in a single JSON or TypeScript configuration file and start everything with one command.

**Process Persistence** — Save the current process list and resurrect it after a daemon restart or system reboot. Combined with startup script generation, your applications survive server reboots.

**Startup Script Generation** — Automatically generate and install systemd (Linux), launchd (macOS), or Task Scheduler (Windows) service configurations so the ProcBoss daemon starts at boot.

**Remote Deployment** — A built-in deploy system that handles SSH-based deployment with git pull, release directory management, symlink rotation, and pre/post-deploy hooks.

**Module/Plugin System** — Extend ProcBoss with custom modules that hook into the process manager lifecycle.

**Environment Management** — Store, retrieve, and inject environment variables per process with `.env` file loading support.

**Full IPC Architecture** — A daemonized architecture where the CLI communicates with a long-running daemon process over a Unix domain socket using WebSocket protocol.

---

## Requirements

- **Runtime:** Bun version 1.0 or higher.
- **Platforms:** Linux, macOS, and Windows.

Install Bun if you haven't already:

**Linux / macOS:**
```bash
curl -fsSL https://bun.sh/install | bash
```

**Windows (PowerShell):**
```powershell
powershell -c "irm bun.sh/install.ps1 | iex"
```

---

## Installation

### From Source

```
git clone https://github.com/procboss/pboss.git
cd pboss
bun install
bun link
```

### Global Install

```
bun add -g pboss
```

### Verify Installation

```
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

### Save and auto-resurrect on reboot

```
pboss save
pboss startup
```

---

## CLI Reference

### Process Management

#### pboss start

Start a new process or processes.

```
pboss start server.ts
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

---

#### pboss restart

Stop and restart a process. The process is fully stopped and then re-spawned.

```
pboss restart my-api
pboss restart all
```

---

#### pboss reload

Graceful zero-downtime reload. New instances start before old ones are killed, ensuring your application always has live workers handling requests.

```
pboss reload my-api
pboss reload all
```

The reload process works as follows for each instance. First, a new process is spawned. Then ProcBoss waits for the new process to become stable or emit a ready signal if `--wait-ready` is enabled. Next, the old process receives SIGTERM and is given the kill timeout to shut down gracefully. Finally, the cycle moves to the next instance.

---

#### pboss delete

Stop and remove a process from ProcBoss's management.

```
pboss delete 0
pboss delete my-api
pboss delete all
```

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
| `NODE_APP_INSTANCE` | Same as `PBOSS_WORKER_ID` (PM2 compatibility) |
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

### Startup Scripts

#### pboss startup

Generate and display a startup script for your operating system:
- **Linux:** Generates a `systemd` service unit file (`/etc/systemd/system/pboss.service`).
- **macOS:** Generates a `launchd` plist (`~/Library/LaunchAgents/com.pboss.daemon.plist`).
- **Windows:** Generates a Windows Task Scheduler command (`schtasks`) and PowerShell task configuration.

```bash
pboss startup
```

On Windows, you can also specify the platform explicitly:
```powershell
pboss startup win32
```

#### pboss startup install

Automatically install the startup script so the ProcBoss daemon starts at boot / logon:

```bash
# Linux (sudo) / macOS
pboss startup install

# Windows (Command Prompt / PowerShell as Administrator)
pboss startup install
```

On Windows, this registers a Scheduled Task (`PBOSS_Daemon`) configured to start automatically on user logon with highest privileges.

#### pboss startup uninstall

Remove the startup service / scheduled task:

```bash
pboss startup uninstall
```

#### pboss save

Save the current process list so it can be restored on daemon startup.

```
pboss save
```

#### pboss resurrect

Restore previously saved processes.

```
pboss resurrect
```

Recommended boot setup:

```
pboss start ecosystem.config.json
pboss save
pboss startup install
```

On reboot, systemd, launchd, or Task Scheduler starts the ProcBoss daemon, and the daemon automatically runs resurrect to restore your processes.

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

ProcBoss exposes two levels of programmatic access. The `PBoss` client class communicates with the daemon over its Unix socket, giving you the same capabilities as the CLI from within any Bun application. For in-process usage without a daemon, you can use the `ProcessManager` class directly.

### Programmatic Quick Start

```ts
import PBoss from "pboss";

const pboss = new PBoss();
await pboss.connect();

// Start a clustered application
await pboss.start({
  script: "./server.ts",
  name: "api",
  instances: 4,
  execMode: "cluster",
  port: 3000,
  env: { NODE_ENV: "production" },
});

// List all processes
const processes = await pboss.list();
console.log(processes);

// Stream metrics every 2 seconds
pboss.on("metrics", (snapshot) => {
  console.log(`CPU: ${snapshot.system.cpu}%  Memory: ${snapshot.system.memory}%`);
});
pboss.startPolling(2000);

// Graceful shutdown
pboss.stopPolling();
await pboss.disconnect();
```

---

### Connection Lifecycle

#### `pboss.connect(): Promise<PBoss>`

Connect to the ProcBoss daemon. If the daemon is not running, it is spawned automatically and the method waits up to 5 seconds for it to become responsive. Returns the `PBoss` instance for chaining.

```ts
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

Read-only property indicating whether the client believes the daemon is reachable.

#### `pboss.daemonPid: number | null`

Read-only property containing the PID of the daemon process, or `null` if unknown.

---

### Programmatic Process Management

#### `pboss.start(options: StartOptions): Promise<ProcessState[]>`

Start a new process or process group. The `script` path is automatically resolved to an absolute path. Returns the array of `ProcessState` objects for the started instances.

```ts
const procs = await pboss.start({
  script: "./worker.ts",
  name: "worker",
  instances: 2,
  env: { QUEUE: "emails" },
  maxMemoryRestart: "256M",
});
console.log(`Started ${procs.length} instances`);
```

The `StartOptions` object accepts all the same fields documented in the [Process Options](#process-options) configuration reference.

#### `pboss.startEcosystem(config: EcosystemConfig): Promise<ProcessState[]>`

Start an entire ecosystem configuration. All script paths within the config are resolved to absolute paths before being sent to the daemon.

```ts
const procs = await pboss.startEcosystem({
  apps: [
    { script: "./api.ts", name: "api", instances: 4, port: 3000 },
    { script: "./worker.ts", name: "worker", instances: 2 },
  ],
});
```

#### `pboss.stop(target?: string | number): Promise<ProcessState[]>`

Stop one or more processes. The `target` can be a process name, numeric ID, namespace, or `"all"`. Defaults to `"all"` when omitted.

```ts
await pboss.stop("api");       // Stop by name
await pboss.stop(0);           // Stop by ID
await pboss.stop();            // Stop all
```

#### `pboss.restart(target?: string | number): Promise<ProcessState[]>`

Hard restart one or more processes. The process is fully stopped and then re-spawned.

```ts
await pboss.restart("api");
await pboss.restart();          // Restart all
```

#### `pboss.reload(target?: string | number): Promise<ProcessState[]>`

Graceful zero-downtime reload. New instances are started before old ones are stopped, ensuring no dropped requests. Ideal for deploying new code.

```ts
await pboss.reload("api");
await pboss.reload();           // Reload all
```

#### `pboss.delete(target?: string | number): Promise<ProcessState[]>`

Stop and remove one or more processes from ProcBoss's management entirely.

```ts
await pboss.delete("api");
await pboss.delete();           // Delete all
```

#### `pboss.scale(target: string | number, count: number): Promise<ProcessState[]>`

Scale a process group to the specified number of instances. When scaling up, new instances inherit the configuration of existing ones. When scaling down, the highest-numbered instances are removed first.

```ts
await pboss.scale("api", 8);   // Scale up to 8 instances
await pboss.scale("api", 2);   // Scale down to 2 instances
```

#### `pboss.sendSignal(target: string | number, signal: string): Promise<void>`

Send an OS signal to a managed process.

```ts
await pboss.sendSignal("api", "SIGUSR2");
await pboss.sendSignal(0, "SIGHUP");
```

#### `pboss.reset(target?: string | number): Promise<ProcessState[]>`

Reset the restart counter for one or more processes. Defaults to `"all"`.

```ts
await pboss.reset("api");
await pboss.reset();            // Reset all
```

---

### Introspection

#### `pboss.list(): Promise<ProcessState[]>`

List all managed processes with their current state.

```ts
const processes = await pboss.list();
for (const proc of processes) {
  console.log(`${proc.name} [${proc.status}] PID=${proc.pid} CPU=${proc.cpu}%`);
}
```

#### `pboss.describe(target: string | number): Promise<ProcessState[]>`

Get detailed information about a specific process or process group.

```ts
const details = await pboss.describe("api");
console.log(details[0]);
```

---

### Logs

#### `pboss.logs(target?: string | number, lines?: number): Promise<Array<{ name: string; id: number; out: string; err: string }>>`

Retrieve recent log lines for one or all processes. Defaults to `"all"` with `20` lines.

```ts
const logs = await pboss.logs("api", 100);
for (const entry of logs) {
  console.log(`[${entry.name}] stdout:\n${entry.out}`);
  if (entry.err) console.error(`[${entry.name}] stderr:\n${entry.err}`);
}
```

#### `pboss.flush(target?: string | number): Promise<void>`

Truncate log files for one or all processes.

```ts
await pboss.flush("api");      // Flush logs for "api"
await pboss.flush();            // Flush all logs
```

---

### Programmatic Monitoring and Metrics

#### `pboss.metrics(): Promise<MetricSnapshot>`

Take a single metrics snapshot containing process-level and system-level telemetry.

```ts
const snapshot = await pboss.metrics();
console.log(`System CPU: ${snapshot.system.cpu}%`);
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

## Comparison with PM2

| Feature | PM2 | ProcBoss (pboss) |
|---|---|---|
| Runtime | Node.js | Bun |
| Language | JavaScript | TypeScript |
| Dependencies | ~40+ packages | Zero (Bun built-ins only) |
| Process Spawning | `child_process.fork` | `Bun.spawn` |
| IPC | Custom protocol over pipes | WebSocket over Unix socket |
| HTTP Server | Express/http | `Bun.serve` |
| Log Compression | External `pm2-logrotate` module | Built-in `Bun.gzipSync` |
| Dashboard | PM2 Plus (paid) or `pm2-monit` | Built-in web dashboard (free) |
| Prometheus Metrics | `pm2-prometheus-exporter` module | Built-in native export |
| Startup Time | ~500ms | ~50ms |
| Memory Overhead | ~40MB (daemon) | ~12MB (daemon) |
| Cluster Mode | `cluster` module | `Bun.spawn` with env-based routing |
| Ecosystem Files | JSON, JS, YAML | JSON, TypeScript |
| Deploy System | Built-in | Built-in |
| Module System | `pm2 install` | `pboss module install` |
| TypeScript | Requires compilation | Native support |
| File Watching | `chokidar` | Native `fs.watch` |
| Docker / Foreground Mode | `--no-daemon` flag | `--no-daemon` / `-d` flag |

---

## Recipes and Examples

### Basic HTTP Server

```
pboss start server.ts --name api
```

### Production API with Clustering and Health Checks

```
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

```
pboss start server.ts --name dev-api --watch --ignore-watch node_modules,.git,dist
```

### Python Script

```
pboss start worker.py --name py-worker --interpreter python3
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
pboss startup install
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

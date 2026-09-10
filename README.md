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

ProcBoss is free and open-source. If it saves you time, star it on [GitHub](https://github.com/procboss/pboss), open issues, or send pull requests.

---

## Highlights

- **Universal runtimes** — auto-detected: Node.js, Bun, Go, Python, Rust, Ruby, PHP, Java JARs, shell scripts, compiled binaries.
- **Cluster mode** — N instances, per-worker env, automatic ports, zero-downtime rolling reloads.
- **Namespaces** — group processes (`--namespace my-app`) and operate on the group: `pboss restart my-app`, `pboss delete my-app` (confirmed; `--force` skips).
- **Foreground mode** — `--no-daemon` blocks as PID 1, for Docker and Kubernetes.
- **Web dashboard** — live WebSocket updates, CPU/memory charts, process controls, log viewer. Zero dependencies.
- **Prometheus metrics** — dedicated `/metrics` endpoint on :9616.
- **Logs** — automatic capture, size-based rotation, retention, gzip.
- **Health checks, cron restarts, file watching** — self-healing processes.
- **Standalone cron jobs** — friendly schedules (`everyday@9:11`, `on-date@24-10-2026-23:10`), no managed process required, persists across reboots.
- **Persistence (default on)** — process list saved after every change; the per-user boot service (systemd / launchd / Task Scheduler) is installed automatically — apps survive restarts and reboots.
- **Tiny footprint** — one daemon, <50ms start, ~12MB RAM.

---

## Installation

### One-Line Universal Install

Install and compile the native standalone `pboss` executable directly on your device — no root required. The installer puts the binary in `~/.local/bin` and, when that directory is not on your `PATH`, adds it to your shell profile (`~/.bashrc` / `~/.zshrc`) automatically — no manual edits:

**Linux / macOS:**
```bash
curl -fsSL https://procboss.com/install.sh | bash
```

(Running the installer as root still works and installs system-wide to `/usr/local/bin` — but sudo is never required.)

**Windows (PowerShell):**
```powershell
powershell -c "irm https://procboss.com/install.ps1 | iex"
```
(No Administrator needed — installs per-user to `%LOCALAPPDATA%\pboss`. An elevated shell installs machine-wide instead.)

**Windows (Command Prompt):**
```cmd
curl -fsSL https://procboss.com/install.cmd | cmd
```

### Bun Global Install

```bash
bun add -g pboss
```

No sudo needed: the boot service pboss installs is a **per-user systemd unit** (`~/.config/systemd/user`), so a user-local install is the recommended setup.

### Verify Installation

```bash
pboss --version
```

---

## Quick Start

Start a process:

```bash
pboss start app.ts
```

With no target, `pboss start` auto-detects a config file in the current directory — `ecosystem.config.{json,js,ts}` > `pboss.config.*` > `bm2.config.*` > `pm2.config.*`, first match wins:

```bash
pboss start
```

Start with a name, 4 instances, and a base port:

```bash
pboss start app.ts --name my-api --instances 4 --port 3000
```

Group processes into a namespace and manage them as one unit:

```bash
pboss start web.ts --name web --namespace my-app
pboss start worker.ts --name worker --namespace my-app
pboss restart my-app     # the whole group at once
pboss stop my-app
pboss start my-app       # resume every stopped member
```

List all processes:

```bash
pboss list
```

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

### Updating

`pboss upgrade` self-updates through the channel that installed it (installer, npm, brew, snap) — one machine, one CLI. The installer downloads the exact version the command announces (pinned against the npm registry), and the command then verifies `pboss --version` on your PATH actually reports it:

```bash
pboss upgrade --check    # see current → latest, the detected channel, and the exact command
pboss upgrade            # do it (adds --channel <x> to repair a misdetected channel)
```

---

## Documentation

**The full documentation lives at [docs.procboss.com](https://docs.procboss.com).**

| Popular sections | |
|---|---|
| [Quick Start](https://docs.procboss.com/quickstart) | First steps, `list --live`, dashboards |
| [CLI Reference](https://docs.procboss.com/cli/processes) | Every command with flags and examples |
| [Docker & Containers](https://docs.procboss.com/guide/docker) | Foreground mode, Dockerfiles, Compose, K8s |
| [Configuration](https://docs.procboss.com/guide/config) | Ecosystem files and process options |
| [Programmatic API](https://docs.procboss.com/guide/programmatic-api) | Zero-ceremony API, events, ProcessManager |
| [ProcBoss Cloud](https://docs.procboss.com/cloud) | Device-code login, fleet view, the agent protocol |
| [Troubleshooting](https://docs.procboss.com/troubleshooting) | Daemon issues, restarts, port conflicts |

---

## License

GPL-3.0-only — see [LICENSE](LICENSE).

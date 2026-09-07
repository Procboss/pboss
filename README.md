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

ProcBoss (pboss) is free and open-source software built for the developer community. If ProcBoss saves you time or powers your production services, please consider supporting its development:

- ⭐ **Star the Repo:** Star us on [GitHub](https://github.com/procboss/pboss) to help more developers discover ProcBoss.
- 🐛 **Contribute:** Open issues, suggest features, or submit pull requests.

---

## Highlights

- **Universal runtime support** — auto-detection for Node.js, Bun, Go, Python, Rust, Ruby, PHP, Java JARs, shell scripts, and compiled binaries.
- **Cluster mode** — multiple instances with per-worker env injection, automatic port assignment, and zero-downtime rolling reloads.
- **Foreground mode** — `--no-daemon` blocks as PID 1, purpose-built for Docker, Kubernetes, and containers.
- **Web dashboard** — self-contained, live WebSocket updates, CPU/memory charts, process controls, and a log viewer. No external dependencies.
- **Prometheus metrics** — dedicated `/metrics` endpoint, ready for scraping and Grafana dashboards.
- **Log management** — automatic capture, size-based rotation, retention, and optional gzip compression.
- **Health checks, cron restarts, file watching** — keep processes healthy and self-healing.
- **Standalone cron jobs** — schedule any command with friendly syntax (`pboss cron run everyday@9:11 "bun backup.ts"`, `every-second` to `on-date@24-10-2026-23:10`), no managed process required; persists across reboots.
- **Persistence (default on)** — the process list is saved automatically after every change, and the boot service (systemd / launchd / Task Scheduler) is installed automatically at install time — your apps survive daemon restarts and system reboots out of the box.
- **Remote deployment** — SSH-based deploys with release directories, symlink rotation, and pre/post hooks.
- **Tiny footprint** — a single machine-level daemon that starts in under 50ms and uses only ~12MB of RAM.

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

The installer's final step enables **boot persistence automatically**: it installs the OS service, starts the daemon, and from then on every process you manage is saved after each change and resurrected at every reboot. Hosts without systemd (containers, minimal VMs) get a note instead of an error — run `sudo pboss startup install` there later if needed.

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

A user-local install (`bun add -g pboss` without sudo) works too — the boot service cannot be installed without root, so pboss prints the one command to enable it; whenever a command needs root, keep your PATH visible to sudo: `sudo env PATH="$PATH" pboss startup install`.

On Windows, elevated shells keep your user PATH, so a regular `bun add -g pboss` is fine — just open the shell as Administrator for `pboss startup install`.

### Build From Source

```bash
git clone https://github.com/procboss/pboss.git
cd pboss
bun install
bun run build:bin
```

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

Start with a name, 4 instances, and a base port:

```bash
pboss start app.ts --name my-api --instances 4 --port 3000
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

Open the dashboard:

```bash
pboss dashboard
```

```
⚡ Dashboard running at http://localhost:9615
📊 Prometheus metrics at http://localhost:9616/metrics
```

Survive a reboot — nothing to do, it's the default:

```bash
pboss start server.ts            # saved automatically
sudo env PATH="$PATH" pboss startup install   # only if the boot service could not be
                                               # installed automatically (Linux)
```

The process list is saved to `~/.pboss/dump.json` after **every** change (start, stop, restart, delete, scale), and the boot service resurrects it at boot. Processes that were running come back running; processes you stopped come back stopped; deleted processes don't come back. `pboss startup` with no option does not install — it prints the list of options (`install` / `uninstall` / `generate [os]`).

`pboss startup install` always returns: the systemd start is submitted with `--no-block` and verified against a hard deadline (unit state + a ping on the daemon's socket); an unhealthy unit prints the state, the socket probe result, and the recent journal output instead of hanging.

Schedule a command — backups, reports, cleanups — without a managed process:

```bash
pboss cron run everyday@2:00 "bun /srv/backup.ts"
pboss cron run every-sunday@10:10 "sh /srv/cleanup.sh" --name cleanup
pboss cron run on-date@24-10-2026-23:10 "node migrate.js"
pboss cron list
```

---

## Documentation

**The full ProcBoss documentation lives at [docs.procboss.com](https://docs.procboss.com).**

It covers everything — the complete CLI reference, cluster mode, log management, monitoring and metrics, the web dashboard, ecosystem files, environment management, deployment, startup scripts, modules, daemon control, foreground mode for Docker & containers, the configuration reference, the REST & WebSocket APIs, Prometheus and Grafana integration, the programmatic API, architecture, recipes, and troubleshooting.

| Popular sections | |
|---|---|
| [Quick Start](https://docs.procboss.com/quickstart) | First steps, `list --live`, dashboards |
| [CLI Reference](https://docs.procboss.com/cli/processes) | Every command with flags and examples |
| [Docker & Containers](https://docs.procboss.com/guide/docker) | Foreground mode, Dockerfiles, Compose, K8s |
| [Configuration](https://docs.procboss.com/guide/config) | Ecosystem files and process options |
| [Programmatic API](https://docs.procboss.com/guide/programmatic-api) | Zero-ceremony API, events, ProcessManager |
| [Troubleshooting](https://docs.procboss.com/troubleshooting) | Daemon issues, restarts, port conflicts |

---

## License

GPL-3.0-only — see [LICENSE](LICENSE).

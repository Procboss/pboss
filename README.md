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
- **Persistence** — `pboss save` + `pboss startup` keeps your apps alive across daemon restarts and system reboots.
- **Remote deployment** — SSH-based deploys with release directories, symlink rotation, and pre/post hooks.
- **Tiny footprint** — a single machine-level daemon that starts in under 50ms and uses only ~12MB of RAM.

---

## Installation

### One-Line Universal Install

Install and compile the native standalone `pboss` executable directly on your device:

**Linux / macOS:**
```bash
curl -fsSL https://procboss.com/install.sh | bash
```

**Windows (PowerShell):**
```powershell
powershell -c "irm https://procboss.com/install.ps1 | iex"
```

**Windows (Command Prompt):**
```cmd
curl -fsSL https://procboss.com/install.cmd | cmd
```

### Package Managers

**Snap (Linux):**
```bash
sudo snap install pboss --classic
```

**Homebrew (macOS / Linux):**
```bash
brew install procboss/tap/pboss
```

**Bun Global Install:**
```bash
bun add -g pboss
```

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

Save and auto-resurrect on reboot:

```bash
pboss save
pboss startup
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

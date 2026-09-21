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

The full documentation lives at [docs.procboss.com](https://docs.procboss.com)

---

## Highlights

- **Universal runtimes** — auto-detected: Node.js, Bun, Go, Python, Rust, Ruby, PHP, Java JARs, shell scripts, compiled binaries.
- **Cluster mode** — N instances, per-worker env, automatic ports, zero-downtime rolling reloads.
- **Namespaces** — group processes (`--namespace my-app`) and operate on the group: `pboss restart my-app`, `pboss delete my-app` (confirmed; `--force` skips). Atomic startup with rollback ([#31](https://github.com/Procboss/pboss/issues/31)): a failed member rolls back only what that start brought up; members already running are never touched; namespace-less processes stay fully independent.
- **Dependencies** ([#33](https://github.com/Procboss/pboss/issues/33)) — `dependsOn: ["postgres", "redis"]`: pboss resolves the graph (ProcBoss apps first, then systemd units like `postgresql.service`), starts stopped app dependencies recursively in topological order (independent branches concurrently), checks system services without ever managing them, refuses cycles upfront, rolls back only what an invocation started, and keeps boot recovery dependency-ordered. `pboss deps api` (and `--reverse`) inspects the graph; required/optional policies; failures are machine-readable on the API.
- **Foreground mode** — `--no-daemon` blocks as PID 1, for Docker and Kubernetes.
- **Web dashboard** — live WebSocket updates, CPU/memory charts, process controls, log viewer. Zero dependencies.
- **Prometheus metrics** — dedicated `/metrics` endpoint on :9616.
- **Logs** — automatic capture, size-based rotation, retention, gzip.
- **Health checks, cron restarts, file watching** — self-healing processes.
- **Real event system** ([#32](https://github.com/Procboss/pboss/issues/32)) — every state change emits a typed `process:*` event (`crashed`, `restart`, `start`, `stop`, `errored`, `delete`, `reload`) with its cause (`user`/`crash`/`memory`/`watch`/`cron`/`health`). Modules get them via `pm.on(...)` in `init(pm)`; API clients via a persistent daemon stream — so a second script, the CLI, or the dashboard hears a restart the instant it happens, from any source, with zero polling.
- **Resource threshold alerts** — CPU spikes vs. sustained highs, memory-leak growth and near-limit warnings (before `maxMemoryRestart` fires), restart loops, blocked event loops, handle/FD leaks, and whole-server CPU/memory pressure. Every threshold has hysteresis (trigger + clear + sustained duration) so nothing flaps, per-process overrides (`pboss alerts set my-api --cpu-spike 90`, ecosystem `alertCpuSpikePercent`, or `~/.pboss/alert-thresholds.json`), and `pboss alerts test api cpu` fires a synthetic alert end-to-end to verify your integrations.
- **Cloud-native observability** — the agent pushes health-check status, crash reasons (`likely OOM`, `uncaught exception`), and threshold events through the same at-least-once event pipeline; the dashboard can search rotated logs, run one-off commands, scale clusters, toggle cron jobs, and manage env vars remotely.
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
pboss start my-app       # resume every stopped member — atomically
```

A namespace is one lifecycle group (issue #31): if any member fails during a
namespace start, only the members that start brought up are rolled back —
processes that were already running keep running, and namespace-less
processes are never affected by a namespace failure. The same boundaries
apply to `pboss start ecosystem.config.ts` and to namespace
`restart`.

Namespaced processes can also react to a sibling's exit with a policy
(`onNsMemberExit: "ignore"` (default) or `"exit"`) — with `exit`, a member
leaving the namespace for good stops the other members too:

```bash
pboss start web.ts --name web --namespace my-app --on-ns-member-exit exit
```

Declare dependencies — pboss starts them first, in the right order, and
knows when one is missing (issue #33):

```bash
pboss start api.ts --name api --depends-on postgres,redis
pboss deps api                 # what does api need — provider, state, ✓/✗
pboss deps postgres --reverse  # who depends on postgres
```

Dependencies also live in ecosystem files — `dependsOn: ["postgres"]` —
with per-dependency policies (`{ name: "metrics", policy: "optional" }`).
Names that are not pboss apps resolve against systemd (`postgresql` →
`postgresql.service`): an active unit satisfies the dependency, an
inactive one blocks it with a clear diagnostic — and pboss never starts
or stops a system service it does not own.

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

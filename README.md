# ProcBoss (pboss)

**A blazing-fast, runtime-agnostic process manager for Bun, Node.js, and Deno —
native APIs per runtime, no compatibility layers — built for JavaScript and
TypeScript backends.**
By [procboss.com](https://procboss.com).

<!-- 2026-09-29: multi-language support is hidden while the product focuses on JS/TS
     backends. Re-add when it returns: "Beyond that first-class trio it manages
     everything else on the machine — Go, Python, Rust, Ruby, PHP, Java, native
     binaries, and shell scripts — with pure performance and zero overhead." -->

![Runtime](https://img.shields.io/badge/runtimes-Bun%20%7C%20Node.js%20%7C%20Deno-8b5cf6?style=flat-square)
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

- **First-class Bun, Node.js, and Deno** — pboss runs natively on all three. An unstated app runtime inherits the main runtime running pboss (`bun run` under Bun, `node` under Node with TypeScript through [tsx](https://github.com/privatenumber/tsx), `deno run -A` under Deno); compiled installs fall back to discovering Bun → Deno → Node.
- **Cluster mode** — N instances, per-worker env, zero-downtime rolling reloads; Node apps cluster through `node:cluster` with one shared port.
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

### Universal Installer (recommended)

One command — it asks which runtime pboss should run under (Node is the
default; press Enter), installs the runtime when it is missing, installs the
published package through that runtime's own package ecosystem, and saves
your choice so every later `pboss` — including upgrades — uses it:

```bash
curl -fsSL https://procboss.com/install.sh | sh
```

Select the runtime up front instead of being asked:

```bash
curl -fsSL https://procboss.com/install.sh | sh -s -- --runtime=node
curl -fsSL https://procboss.com/install.sh | sh -s -- --runtime=bun
curl -fsSL https://procboss.com/install.sh | sh -s -- --runtime=deno
```

Windows (PowerShell, no Administrator needed):

```powershell
powershell -c "irm https://procboss.com/install.ps1 | iex"
```

### Package-Manager Installs

One package, three runtimes — install pboss with the package manager of the
runtime it should run under:

**Node.js**

```bash
npm install -g pboss
```

**Bun**

```bash
bun install -g pboss
```

**Deno**

```bash
deno install -g -A --min-dep-age=0 --name pboss --reload --force npm:pboss/deno-entry
```

Deno is deny-by-default — `-A` grants what a process manager needs. The
explicit equivalent (`--allow-run --allow-read --allow-write --allow-net
--allow-env --allow-sys`) and the full permission table live in the
[installation docs](https://docs.procboss.com/installation#denos-permission-system).

`--reload` re-resolves the spec against the live registry instead of Deno's
local cache (a stale cached resolution is the other way an old version
sticks around), and `--force` overwrites an existing installation — so the
same command installs, reinstalls, and upgrades in place.

> **Deno's 24-hour supply-chain hold:** Deno refuses to resolve npm versions
> published within the last day — an unpinned spec silently installs the
> PREVIOUS release (and before 1.6.0, one without the Deno entrypoint: a
> `Failed resolving binary export` error). The `--min-dep-age=0` flag
> (short for `--minimum-dependency-age=0`) in the command above disables
> that hold for this install, so the
> spec resolves the release just published (it is Deno's own escape hatch,
> available in Deno 2.9+ — on older Deno, which has no hold, omit the
> flag). The universal installer passes the flag automatically whenever
> your Deno supports it, and pins the exact version it installs; to pin
> manually, use `deno install -g -A --min-dep-age=0 --name pboss
> --reload --force npm:pboss@<version>/deno-entry`.

### The Runtime Selection

`pboss` never guesses a runtime from whatever happens to be installed —
the runtime is **your** explicit, persistent choice, stored in
`~/.pboss/.runtime`:

- **First run** — if nothing is configured yet, `pboss` asks once
  (interactive terminals only) and saves the answer. On a machine with no
  selection and no terminal, pass the flag explicitly: `pboss --runtime=bun`.
- **`--runtime=<node|bun|deno>`** — run one invocation under a runtime.
  When nothing is configured yet it *initializes* the persistent selection;
  when a different runtime is configured it overrides for that invocation
  only and tells you how to change it permanently.
- **`pboss runtime`** — show the configured runtime, the executing engine,
  and how pboss was installed.
- **`pboss runtime change`** — switch permanently: interactive, installs the
  new runtime when missing, installs/updates the published pboss package
  for it, and only then flips the selection (a failure keeps the old one).

The `pboss` command itself is a small shell/PowerShell wrapper
(`bin/pboss.sh` / `bin/pboss.ps1`) that reads the selection and dispatches
to that runtime's own entrypoint — so a Bun-only machine works without
Node anywhere, and `pboss runtime change` is all it takes to switch.
The wrapper needs no JavaScript runtime to start, which is exactly how
it can be the one binary npm links for every runtime mix.

### Verify Installation

```bash
pboss --version
pboss runtime      # the configured runtime + the engine executing pboss
```

The `pboss` command lands in the package manager's bin directory
(`~/.bun/bin`, the npm global bin, or `~/.deno/bin`) — normally already on
your `PATH`. When it is not, add that directory to your shell profile and
open a new terminal; `pboss` is found from then on.

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

Flags may appear before or after the script path (issue #34) — these are equivalent:

```bash
pboss start --name my-api --instances 4 app.ts
pboss start app.ts --name my-api --instances 4
```

Point pboss at a **custom js/ts/json ecosystem file** with `--config` (short `-c`, or `--config=`) — any file name works, at any position, and the file is treated as the config, never as the script to invoke:

```bash
pboss start --config ./any.js
pboss start -c ecosystem.config.ts
pboss start --config=/srv/procboss.config.js
```

The same flag drives the fleet commands — each acts on the apps the file names (a stopped app comes back on `restart`, an unregistered app is reported and skipped, and the conventional positional form works too):

```bash
pboss restart --config ./any.js
pboss stop --config ./any.js
pboss reload --config ./any.js
pboss delete --config ./any.js
pboss restart ecosystem.config.js   # positional, PM2-style
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

**Deno permissions** — the first runtime-unique feature: state WHAT a deno
app may do instead of the kitchen-sink `deno run -A` default. Short form is
`-P` (`-p` is `--port`, PM2 parity); the `--permissions=` spelling works too.

```bash
pboss start server.ts --interpreter deno --permissions allow-net,allow-read=./config
pboss start worker.ts --interpreter deno -P none        # zero-permission deno app
```

```js
// ecosystem file — same list, array form
module.exports = {
  apps: [{ name: "deno-api", script: "./server.ts", interpreter: "deno",
           permissions: ["allow-net", "allow-read", "deny-write"] }],
};
```

Entries are `allow-<category>` / `deny-<category>` (optionally
`=value`-scoped), plus `all` (`-A`) and `none`. Permissions already stated in
`--interpreter-args` are never duplicated — the user's scoping always wins —
and a user-stated `-A` suppresses `allow-*` entries (deno rejects the
combination) while `deny-*` entries still layer on top. The list is
**runtime-unique**: ignored under bun/node (no permission model there), so
one ecosystem file drives a mixed fleet.

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

`pboss upgrade` self-updates through the channel that installed it (npm, bun,
deno, brew, snap) — one machine, one CLI — and verifies `pboss --version` on
your PATH actually reports the new version. Upgrades follow the runtime you
selected: `~/.pboss/.runtime` says node → npm, bun → bun, deno → deno — your
choice survives every upgrade:

```bash
pboss upgrade --check    # see current → latest, the detected channel, and the exact command
pboss upgrade            # do it (adds --channel <x> to repair a misdetected channel)
```

<!-- 2026-10-04: the universal-installer channel installs through the selected
     runtime's package ecosystem now, so the .runtime selection decides the
     upgrade command — the "installer" channel and the runtime channels are
     the same thing. -->

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

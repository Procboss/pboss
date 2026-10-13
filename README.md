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

- **First-class Bun, Node.js, and Deno** — pboss runs natively on all three. An unstated app runtime resolves a saved `--runtime` pin first, then the `~/.pboss/.runtime` default, then inherits the main runtime running pboss (`bun run` under Bun, `node` under Node with TypeScript through [tsx](https://github.com/privatenumber/tsx), `deno run --quiet` under Deno — no permission flags, deno's own deny-by-default); compiled installs fall back to discovering Bun → Deno → Node.
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

## Benchmarks

pboss is benchmarked head-to-head in the public
[`procboss/benchmarks`](https://github.com/Procboss/benchmarks) repo — same
application, same runtime binary, same machine, same load, manager order
alternating; every raw number committed beside the code that produced it.
Three suites: **Node** (vs pm2 — fork + native `node:cluster` on both managers,
the apples-to-apples cluster race), **Bun** (vs pm2 — fork on both; cluster is
pboss-only, pm2 cannot cluster a Bun app and is recorded as *not supported*,
never fork-mode in disguise), and **Deno** (vs
[pup](https://github.com/hexagon/pup) — fork on both, and cluster with each
manager's own native model: pboss's SO_REUSEPORT workers vs pup's built-in
load balancer).

**Latest re-runs: pboss v1.8.0 vs pm2 5.4.3** (node + bun suites, standard
profile: 10/100/500 connections × 60 s × 5 repeats per manager per mode; 105
measured load runs each, zero errors/timeouts/non-2xx; zero failures and zero
orphans through every 50-restart storm) **and pboss v1.8.1 vs pup 1.0.4**
(deno suite, same standard profile: 31 measured load runs, zero
errors/timeouts/non-2xx; crash recovery, worker respawn and restart storms
for both managers at their out-of-the-box restart policies — pboss run from a
git checkout of this repo under `deno run`, the same runtime pup itself uses).

The suite READMEs in the benchmarks repo regenerate this summary automatically
on every run, so what you read there is always the latest published
measurement.

**Node apps — cluster mode, 100 connections, 2 workers** (both managers
native `node:cluster`):

| Metric | pm2 | pboss | Winner |
| --- | --- | --- | --- |
| Average requests/sec | 55,954 | 58,539 | **pboss (+4.6%)** |
| Average latency (mean) | 1.25 ms | 1.18 ms | **pboss (−5.6%)** |
| Cold startup (median) | 641 ms | 419 ms | **pboss (−34.6%)** |
| Warm startup (median) | 422 ms | 242 ms | **pboss (−42.7%)** |
| **Worker respawn after SIGKILL (mean)** | 151.1 ms | **93.2 ms** | **pboss (−38.3%)** |
| Health stayed up during worker kill | 100% | 100% | tie |
| Restart storm, all workers (median) | 498 ms | 300 ms | **pboss (−39.8%)** |

**Node apps — fork mode, 100 connections**: throughput a tie (57,512 vs
57,519 rps — the manager is not in the request path), latency −2.8%, tree
memory −6.0%, cold start −24.0%, warm start −35.6%, SIGKILL crash recovery
−49.3%, 50-restart storm −51.9% — pboss wins every operational metric.

**Bun apps — fork mode, 100 connections**: cold start −13.5%, warm start
−39.1%, crash recovery −2.1%, 50-restart storm −49.4% (pm2 keeps a marginal
+2.4% rps lead at this load). **Bun cluster mode** (pboss alone): a
SIGKILLed worker is replaced in **~81 ms** with `/health` continuity held at
100%, and the whole cluster restarts in ~178 ms.

**Deno apps — vs pup, 100 connections, 2 workers, both native cluster models**
(pboss: N SO_REUSEPORT workers · pup: built-in load balancer over N backends):

| Metric | pup | pboss | Winner |
| --- | --- | --- | --- |
| Average requests/sec (cluster) | 12,444 | 69,088 | **pboss (+455%)** |
| Average latency, mean (cluster) | 7.51 ms | 0.96 ms | **pboss (−87%)** |
| Average CPU of tree (cluster) | 121.8% | 62.2% | **pboss (−49%)** |
| Average memory of tree (cluster) | 269.4 MB | 158.2 MB | **pboss (−41%)** |
| Cold startup, fork (median) | 1,142 ms | 316 ms | **pboss (−72%)** |
| Warm startup, fork (median) | 285 ms | 159 ms | **pboss (−44%)** |
| Idle overhead (RSS) | 88.3 MB | 63.3 MB | **pboss (−28%)** |
| **SIGKILL recovery, fork (mean)** | 10,958 ms | **67 ms** | **pboss (−99.4%)** |
| **Worker respawn, cluster (mean)** | 10,921 ms | **87 ms** | **pboss (−99.2%)** |
| Health stayed up through worker kills | 70% | **100%** | **pboss** |
| Restart storm, fork (median) | 1,015 ms | 106 ms | **pboss (−90%)** |

(Deno fork-mode throughput is a statistical tie — 68,491 vs 67,953 rps, well
inside run-to-run noise — the manager is not in the request path; tree memory
is −16% and every operational metric (startup, restart, crash recovery,
storm) above is pboss's by 44–99%. pup's crash numbers reflect its default
10-second restart delay, run out-of-the-box exactly like the pm2 suites; a
tuned `restartDelayMs` narrows the gap but the default is what most installs
run. Full tables: the deno suite's REPORT.md.)

One machine, one moment in time — clone the benchmarks repo and re-run the
suites on your own hardware before making decisions that matter.

---

## Installation

### Universal Installer (recommended)

One command — it asks which runtime pboss should run under (Node is the
default; press Enter), installs the runtime when it is missing, installs the
published package through that runtime's own package ecosystem, and saves
your choice so every later `pboss` — including upgrades — uses it (a re-run
of the installer reads the saved selection and never asks again):

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
> PREVIOUS release. The `--min-dep-age=0` flag in the command above is
> Deno's own escape hatch (Deno ≥ 2.9; older Deno has no hold — omit it):
> it disables the hold for this install. The universal installer and
> `pboss upgrade` pass the flag automatically whenever your Deno supports
> it — the installer pins the exact version, `pboss upgrade` runs the
> same unpinned command; to pin manually, use `npm:pboss@<version>/deno-entry`.

**JSR (Deno, from source)**

```bash
deno install -g -A --min-dep-age=0 --name pboss jsr:@procboss/pboss/cli
```

[JSR](https://jsr.io/@procboss/pboss) serves the same TypeScript npm ships
compiled — unbundled, with the registry transpiling per consumer. The
`/cli` entry is the CLI (`deno run jsr:@procboss/pboss/cli` anywhere Deno
runs), `.` the programmatic API, `./types` the type surface. The flags match
the npm route above for the same reasons: `-A` because a process manager
needs the grants, `--min-dep-age=0` to bypass Deno's 24-hour hold on the
freshly published version; add `--reload --force` to re-resolve and
overwrite an existing installation in place.

The CLI export is per-runtime, each entry opening with its own exact
shebang: `/cli` is the Deno entry (`#!/usr/bin/env -S deno run -A`),
`/cli/bun` the Bun entry (`#!/usr/bin/env bun`), `/cli/node` the Node
entry (`#!/usr/bin/env node`) — all three boot the same CLI. Publishing is
manual: `bun run publish:jsr` from a clean tree (`publish:jsr:dry` to
check).

### The Runtime Selection

`pboss` never guesses a runtime from whatever happens to be installed —
the runtime is **your** explicit, persistent choice, stored in
`~/.pboss/.runtime`:

- **First run** — if nothing is configured yet, `pboss` asks once
  (interactive terminals only) and saves the answer. On a machine with no
  selection and no terminal, pass the flag explicitly: `pboss --runtime=bun`.
- **`--runtime=<node|bun|deno>`** — run one invocation under a runtime. A
  launcher flag: the wrapper consumes it before the CLI runs. When nothing
  is configured yet it *initializes* the persistent selection; when a
  different runtime is configured it overrides for that invocation only
  and tells you how to change it permanently.
- **Runtime overrides** — on a start, `--runtime` also *pins* what it
  starts: `pboss start --runtime=bun app.ts` keeps that process on Bun
  across restarts, reloads and reboots, and
  `pboss start --runtime=deno ecosystem.config.ts` pins every app in the
  file — while `~/.pboss/.runtime` keeps holding the untouched default.
  Pins live in `~/.pboss/runtime-overrides` (see the docs' Runtime
  overrides section); deleting a process drops its pin, and re-starting
  with another `--runtime` re-pins it.
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
app may do. An UNSTATED list carries no permission flags at all (deno's own
deny-by-default — the first restricted operation fails fast with the pointed
`--allow-*` hint); a stated list grants exactly what it says. Short form is
`--perms` — deliberately no single-letter alias: `-p` is already `--port`
(PM2 parity), and a `-P`/`-p` typo would silently set the port. The
`--permissions=` / `--perms=` spellings work too.

The resolved route also runs `--quiet`: deno prints its "Listening on http://…" banner to STDERR,
which every process manager (pboss included) labels as an error — a healthy
serving app no longer paints your logs red. Want the banner or full access?
State it: your own `--interpreter-args`, or `--permissions all`.

```bash
pboss start server.ts --interpreter deno --permissions allow-net,allow-read=./config
pboss start worker.ts --interpreter deno --perms none        # zero-permission deno app
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
choice survives every upgrade. The upgrade finishes the daemon too
([#41](https://github.com/Procboss/pboss/issues/41)): it stops the old-code
daemon, reinstalls the boot service from the new install and restarts the
daemon through it — check both versions any time with `pboss daemon status`,
apply one yourself with `pboss daemon restart`:

```bash
pboss upgrade --check    # see current → latest, the detected channel, and the exact command
pboss upgrade            # do it (adds --channel <x> to repair a misdetected channel)
```

The header (channel + current version) prints before the registry is even
contacted, so a network failure shows the honest hold note — never a bare
error. Machines behind a firewall can point the version check at a mirror
(or any stand-in) with `PBOSS_REGISTRY`, e.g.
`PBOSS_REGISTRY=https://registry.npmmirror.com pboss upgrade --check`.

<!-- 2026-10-04: the universal-installer channel installs through the selected
     runtime's package ecosystem now, so the .runtime selection decides the
     upgrade command — the "installer" channel and the runtime channels are
     the same thing. -->

### Publishing (maintainers)

npm publishes with `npm publish` (`prepublishOnly` builds `dist/` and runs
the suite). JSR publishes the source tree as
[`@procboss/pboss`](https://jsr.io/@procboss/pboss) — `jsr.json` owns the
package (`src/api.ts` / `src/index.ts` / `src/types.ts` map to the npm
exports' bun conditions; the npm dependencies are pinned in its import
map), and `tests/jsr.test.ts` keeps identity, version and import hygiene
in lockstep with `package.json`, so the two registries can never drift:

```bash
bun run publish:jsr:dry   # every JSR check, no upload (dirty tree is fine)
bun run publish:jsr       # the real publish (clean tree + token required)
```

JSR publishing is MANUAL (owner decision, 2026-10-12: the CI dry-run job
that ran on every push kept breaking the action, and the tag-triggered
auto-publish went with it). `bun run publish:jsr` publishes from a clean
tree directly — it needs a token with publish scope on `@procboss` from
[jsr.io/account/settings/tokens](https://jsr.io/account/settings/tokens).
Bump `package.json` first — `jsr.json` must match.

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

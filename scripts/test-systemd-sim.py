#!/usr/bin/env python3
"""
Systemd-execution simulator for pboss.

Verifies the systemd start contract without needing systemd: this script
reproduces EXACTLY what systemd does when it launches a Type=simple unit
like the pboss.service our startup-manager generates:

  - minimal environment (only what the unit's Environment= lines provide,
    plus USER/LOGNAME/HOME which the user manager sets for the owning
    user — user units carry no User= directive)
  - working directory = /
  - stdin  = /dev/null
  - stdout/stderr = a UNIX SOCKET (journald-style), not a pipe, not a TTY
  - its own session (start_new_session) — no controlling terminal

Requires: `bun run build:bin` first (tests the compiled binary — the same
artifact /usr/local/bin/pboss holds on a real host).

Scenarios:
  A.  clean ExecStart under systemd-like env -> daemon must come up and stay
  B.  ExecStartPost 'resurrect --wait 10' with a live daemon          -> 0
  B2. ExecStartPost fired IMMEDIATELY at a cold ExecStart (unit race)  -> daemon
      survives, resurrect exits 0
  C.  conflict: stray daemon + ExecStart -> exit 81 (RestartPreventExitStatus)
      with a clear, actionable message
  D.  resurrect --wait timeout with a dead daemon -> exit 0 (a FAILED
      ExecStartPost would abort the start transaction and kill the healthy
      ExecStart daemon — the second half of the restart-storm bug)

Usage: python3 scripts/test-systemd-sim.py   (from the repo root)
"""
import os, socket, subprocess, sys, time, glob, shutil, tempfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BIN = os.path.join(REPO, "dist", "pboss")
UNIT_HOME = tempfile.mkdtemp(prefix="pboss-systemd-sim-")

# Environment exactly like the generated user unit provides (see
# startup-manager.ts): Environment=PATH=...  Environment=PBOSS_HOME=...
# (a user unit runs as its owning user — no User= directive)
UNIT_ENV = {
    "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "PBOSS_HOME": UNIT_HOME,
    "HOME": UNIT_HOME,       # systemd sets this from User='s passwd entry
    "USER": os.environ.get("USER", "nobody"),
    "LOGNAME": os.environ.get("USER", "nobody"),
}

results = []

def report(name, ok, detail):
    results.append((name, ok, detail))
    print(f"[{'PASS' if ok else 'FAIL'}] {name}: {detail}", flush=True)

def journal_socket():
    """A unix socket pair that behaves like journald's stdout listener."""
    a, b = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
    return a, b

def systemd_run(argv, wait=True, timeout=None):
    """Run a command the way systemd runs ExecStart/ExecStartPost."""
    stdout_sock, peer = journal_socket()
    stdin_fh = open("/dev/null", "rb")
    proc = subprocess.Popen(
        argv,
        env=UNIT_ENV,
        cwd="/",                      # systemd default WorkingDirectory
        stdin=stdin_fh,
        stdout=stdout_sock,           # journald-style unix socket
        stderr=stdout_sock,
        start_new_session=True,       # systemd: own session, no controlling tty
    )
    stdout_sock.close()
    stdin_fh.close()
    if wait:
        try:
            rc = proc.wait(timeout=timeout)
            out = peer.recv(65536).decode(errors="replace")
            return rc, out
        except subprocess.TimeoutExpired:
            proc.kill()
            out = peer.recv(65536).decode(errors="replace")
            return None, out
    return proc, peer

def wipe_home():
    for f in glob.glob(f"{UNIT_HOME}/*"):
        if os.path.isdir(f) and not os.path.islink(f):
            shutil.rmtree(f)
        else:
            os.remove(f)

def cleanup_daemons():
    subprocess.run(["pkill", "-f", f"{BIN} __daemon"], capture_output=True)
    subprocess.run(["pkill", "-f", f"{BIN} resurrect"], capture_output=True)
    time.sleep(0.5)

# ── Scenario A: clean ExecStart under systemd-like environment ────────────
cleanup_daemons()
wipe_home()

print("=== A: ExecStart (systemd-like env, socket stdout, cwd /, setsid) ===", flush=True)
proc, peer = systemd_run([BIN, "__daemon"], wait=False)
time.sleep(3.0)  # systemd's ExecStartPost would fire ~immediately; give init time
out = b""
try:
    peer.setblocking(False)
    out = peer.recv(65536)
except BlockingIOError:
    pass
peer.setblocking(True)
alive = proc.poll() is None
report("A: daemon stays up under systemd env", alive, f"rc so far={proc.poll()}, stdout={out.decode(errors='replace').strip()[:200]!r}")

# ── Scenario B: ExecStartPost resurrect --wait 10 while daemon is live ────
print("=== B: ExecStartPost resurrect --wait 10 (daemon live) ===", flush=True)
rc, out = systemd_run([BIN, "resurrect", "--wait", "10"], timeout=40)
report("B: resurrect --wait exits 0 with live daemon", rc == 0, f"rc={rc}, out={out.strip()[:300]!r}")

# ── Scenario B2: ExecStartPost fired IMMEDIATELY at ExecStart (the race) ──
print("=== B2: resurrect --wait racing a cold ExecStart (unit restart race) ===", flush=True)
cleanup_daemons()
wipe_home()
dproc, dpeer = systemd_run([BIN, "__daemon"], wait=False)
# fire ExecStartPost ~instantly like systemd does (ExecStart just forked)
rc, out = systemd_run([BIN, "resurrect", "--wait", "10"], timeout=40)
d_alive = dproc.poll() is None
report("B2: cold-start race, ExecStart daemon survives", d_alive, f"daemon rc={dproc.poll()}")
report("B2: cold-start race, resurrect exit code", rc == 0, f"rc={rc}, out={out.strip()[:300]!r}")
cleanup_daemons()

# ── Scenario C: conflict — stray daemon + ExecStart ───────────────────────
print("=== C: stray daemon holds socket, unit ExecStart runs ===", flush=True)
stray, straypeer = systemd_run([BIN, "__daemon"], wait=False)
time.sleep(2.5)
rc, out = systemd_run([BIN, "__daemon"], timeout=15)
report("C: conflicting ExecStart exits 81 (RestartPreventExitStatus)", rc == 81, f"rc={rc}, out={out.strip()[:300]!r}")
stray.kill(); stray.wait()

# ── Scenario D: resurrect --wait timeout with NO daemon (post-crash) ──────
print("=== D: resurrect --wait 2 with daemon dead (timeout path) ===", flush=True)
cleanup_daemons()
t0 = time.time()
rc, out = systemd_run([BIN, "resurrect", "--wait", "2"], timeout=30)
report("D: timeout exit code (ExecStartPost semantics — 0 is required)", rc == 0, f"rc={rc}, out={out.strip()[:300]!r}")

cleanup_daemons()
shutil.rmtree(UNIT_HOME, ignore_errors=True)

print()
fails = [r for r in results if not r[1]]
print(f"SUMMARY: {len(results) - len(fails)}/{len(results)} passed")
for name, ok, detail in fails:
    print(f"  FAILED: {name}: {detail}")
sys.exit(1 if fails else 0)

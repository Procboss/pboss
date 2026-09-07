import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, writeFile, readFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

/**
 * Reboot persistence — the "survive reboots and restarts by default" suite.
 *
 * The contract under test:
 *   1. the dump (~/.pboss/dump.json) is written automatically after every
 *      process-list mutation, so it always mirrors the live list;
 *   2. entries remember whether they were stopped — `pboss stop` survives a
 *      reboot as stopped, everything else comes back running;
 *   3. the daemon shutdown path (kill / systemd ExecStop) must NOT rewrite
 *      the dump — the next boot resurrects what WAS supposed to run.
 *
 * PBOSS_HOME is isolated BEFORE src imports (constants.ts resolves it at
 * import time) so nothing here touches the developer's real ~/.pboss.
 */
const TEST_HOME = join(tmpdir(), `pboss-test-persist-${process.pid}-${Date.now()}`);
process.env.PBOSS_HOME = TEST_HOME;

const TEST_DIR = join(tmpdir(), `pboss-test-persist-src-${process.pid}-${Date.now()}`);

beforeEach(async () => {
  await mkdir(TEST_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await rm(TEST_HOME, { recursive: true, force: true });
});

async function writeScript(name: string): Promise<string> {
  const scriptPath = join(TEST_DIR, name);
  await writeFile(scriptPath, "setInterval(() => {}, 1000);");
  return scriptPath;
}

async function readDump(): Promise<any[]> {
  const { DUMP_FILE } = await import("../src/constants");
  const raw = await readFile(DUMP_FILE, "utf-8");
  return JSON.parse(raw);
}

describe("Auto-save: the dump mirrors the live process list", () => {
  test("pboss start persists the new process (no manual save needed)", async () => {
    const { ProcessManager } = await import("../src/process-manager");
    const { DUMP_FILE } = await import("../src/constants");
    const pm = new ProcessManager();
    const script = await writeScript("auto-save-start.ts");

    await pm.start({ name: "auto-app", script: script });

    // The dump exists and describes the running process — without pboss save.
    expect(await Bun.file(DUMP_FILE).exists()).toBe(true);
    const dump = await readDump();
    expect(dump).toHaveLength(1);
    expect(dump[0].config.name).toBe("auto-app");
    expect(dump[0].stopped).toBe(false);

    await pm.deleteAll();
  });

  test("pboss stop persists the stopped flag", async () => {
    const { ProcessManager } = await import("../src/process-manager");
    const pm = new ProcessManager();
    const script = await writeScript("auto-save-stop.ts");

    await pm.start({ name: "stop-app", script: script });
    await pm.stop("stop-app");

    const dump = await readDump();
    expect(dump).toHaveLength(1);
    expect(dump[0].stopped).toBe(true);

    await pm.deleteAll();
  });

  test("pboss delete removes the entry from the dump (it never resurrects)", async () => {
    const { ProcessManager } = await import("../src/process-manager");
    const pm = new ProcessManager();
    const script = await writeScript("auto-save-delete.ts");

    await pm.start({ name: "del-app", script: script });
    await pm.del("del-app");

    const dump = await readDump();
    expect(dump).toHaveLength(0);

    // And a resurrect from that dump restores nothing.
    const newPm = new ProcessManager();
    expect(await newPm.resurrect()).toHaveLength(0);
  });

  test("pboss restart clears the stopped flag", async () => {
    const { ProcessManager } = await import("../src/process-manager");
    const pm = new ProcessManager();
    const script = await writeScript("auto-save-restart.ts");

    await pm.start({ name: "restart-app", script: script });
    await pm.stop("restart-app");
    expect((await readDump())[0].stopped).toBe(true);

    await pm.restart("restart-app");
    expect((await readDump())[0].stopped).toBe(false);

    await pm.deleteAll();
  });

  test("stopAll (user's `pboss stop all`) persists everything as stopped", async () => {
    const { ProcessManager } = await import("../src/process-manager");
    const pm = new ProcessManager();
    const script = await writeScript("auto-save-stopall.ts");

    await pm.start({ name: "stopall-app", script: script });
    await pm.stopAll();

    const dump = await readDump();
    expect(dump).toHaveLength(1);
    expect(dump[0].stopped).toBe(true);
  });

  test("stopAll({ persist: false }) (daemon kill path) leaves the dump untouched", async () => {
    const { ProcessManager } = await import("../src/process-manager");
    const pm = new ProcessManager();
    const script = await writeScript("auto-save-kill.ts");

    await pm.start({ name: "kill-app", script: script });
    const dumpBefore = JSON.stringify(await readDump());
    expect(JSON.parse(dumpBefore)[0].stopped).toBe(false);

    // This is what the daemon's `kill` RPC (and systemd ExecStop) runs: stop
    // the children, keep the dump describing what should run.
    await pm.stopAll({ persist: false });

    const dumpAfter = JSON.stringify(await readDump());
    expect(dumpAfter).toBe(dumpBefore);
  });

  test("save() creates a missing PBOSS_HOME instead of failing", async () => {
    const { ProcessManager } = await import("../src/process-manager");
    const { DUMP_FILE } = await import("../src/constants");
    const pm = new ProcessManager();
    const script = await writeScript("auto-save-mkdir.ts");

    await pm.start({ name: "mkdir-app", script: script });
    // Blow the home away entirely (simulating a wiped directory between the
    // auto-save and the next explicit save).
    await rm(TEST_HOME, { recursive: true, force: true });

    await pm.save(); // must mkdir and succeed, not throw

    expect(await Bun.file(DUMP_FILE).exists()).toBe(true);
    await pm.deleteAll();
  });
});

describe("Resurrect honors the stopped flag", () => {
  test("a saved-stopped process resurrects listed but NOT running", async () => {
    const { ProcessManager } = await import("../src/process-manager");
    const pm = new ProcessManager();
    const script = await writeScript("resurrect-stopped.ts");

    await pm.start({ name: "ghost-app", script: script });
    await pm.stop("ghost-app");
    expect((await readDump())[0].stopped).toBe(true);

    // Fresh daemon memory — as after a reboot.
    const newPm = new ProcessManager();
    const states = await newPm.resurrect();

    expect(states).toHaveLength(1);
    const state = states[0]!;
    expect(state.name).toBe("ghost-app");
    expect(state.status).toBe("stopped");
    // Never started → no OS process was spawned for it.
    expect(state.pid ?? null).toBeNull();

    // It stays stopped in the daemon's list, ready for `pboss restart`.
    const listed = newPm.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.status).toBe("stopped");

    // And restarting it brings it online (the normal recovery path).
    const restarted = await newPm.restart("ghost-app");
    expect(restarted[0]!.status).toBe("online");

    await newPm.deleteAll();
  });

  test("a saved-running process resurrects running (the reboot happy path)", async () => {
    const { ProcessManager } = await import("../src/process-manager");
    const pm = new ProcessManager();
    const script = await writeScript("resurrect-running.ts");

    const started = await pm.start({ name: "live-app", script: script });
    expect(started[0]!.status).toBe("online");
    // Daemon dies without touching the dump (kill path).
    await pm.stopAll({ persist: false });

    const newPm = new ProcessManager();
    const states = await newPm.resurrect();

    expect(states).toHaveLength(1);
    expect(states[0]!.status).toBe("online");
    expect(states[0]!.pid ?? null).not.toBeNull();

    await newPm.deleteAll();
  });
});

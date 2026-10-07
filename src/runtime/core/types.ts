/**
 * ProcBoss (pboss) — runtime-agnostic core types.
 *
 * The runtime adapter contract. PBoss Core speaks ONLY these interfaces;
 * the per-runtime adapters (src/runtime/bun, node, deno) implement them with
 * each runtime's NATIVE APIs:
 *
 *                     PBoss Core
 *                         │
 *                 Runtime Adapter
 *                /       │        \
 *             Bun      Node      Deno
 *              ↓         ↓         ↓
 *          Native    Native     Native
 *            APIs      APIs       APIs
 *
 * Design rules (see the runtime architecture doc in README):
 *   - the surface covers EXACTLY what pboss uses — no speculative wrapping
 *   - adapter modules are pure function bags: zero top-level side effects,
 *     so loading one never touches another runtime's globals
 *   - detection happens ONCE; the adapter is a process-lifetime singleton
 *     and hot paths resolve to direct native implementations
 *
 * https://procboss.com
 * License: GPL-3.0-only
 */

/** The runtimes pboss executes under. */
export type RuntimeName = "bun" | "node" | "deno";

/**
 * A spawned child process, normalized. The shape is Bun/Deno's (web
 * ReadableStreams + an `exited` promise) because it is the smallest common
 * denominator; the Node adapter adapts node streams to web streams once,
 * at spawn time.
 */
export interface PBChild {
  readonly pid: number | undefined;
  /** Exit code (null when terminated by a signal). Resolves exactly once. */
  readonly exited: Promise<number | null>;
  readonly stdout: ReadableStream<Uint8Array> | null;
  readonly stderr: ReadableStream<Uint8Array> | null;
  kill(signal?: string): void;
  /** Release the runtime's exit-wait handle (detached daemons). */
  unref(): void;
}

/** Where a child's stdio goes. */
export type PBStdio = "pipe" | "ignore" | "inherit" | PBFileSink;

/**
 * An opaque file sink a child's stdout/stderr can be redirected into.
 * Created by `filesystem.sink(path)`; only the creating runtime's
 * `process.spawn` consumes it.
 */
export interface PBFileSink {
  /** Marker + the path, for error messages and debugging. */
  readonly __pbFileSink: string;
  /**
   * An append-mode file descriptor when the runtime can pass raw fds to
   * spawn natively (Bun and Node both can); otherwise unset and the
   * runtime's spawn does its own file wiring (Deno pumps).
   */
  readonly fd?: number;
}

export interface PBSpawnOptions {
  cwd?: string;
  /** undefined inherits the parent environment (each runtime's default). */
  env?: Record<string, string> | undefined;
  stdin?: "ignore" | "pipe";
  stdout?: PBStdio;
  stderr?: PBStdio;
  detached?: boolean;
  windowsHide?: boolean;
}

export interface PBCaptured {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface PBSpawnSync {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/**
 * A directory watcher's cancel handle — closes the OS watch and ends the
 * event stream. Close is idempotent and never throws.
 */
export interface PBWatcher {
  close(): void;
}

/** Process spawning/killing — each runtime's NATIVE mechanism. */
export interface PBProcessRuntime {
  spawn(cmd: string[], opts?: PBSpawnOptions): PBChild;
  /** Synchronous capture; throws under runtimes with no sync spawn (Deno). */
  spawnSync(cmd: string[], opts?: { cwd?: string }): PBSpawnSync;
  /** Async capture: run to completion, collect output + exit code. */
  capture(cmd: string[], opts?: { cwd?: string; env?: Record<string, string> }): Promise<PBCaptured>;
}

/**
 * Filesystem — native async file APIs. (Sync fs already uses node:fs,
 * which Bun and Deno implement natively themselves — that is shared code,
 * not a compatibility layer.)
 */
export interface PBFilesystemRuntime {
  readText(path: string): Promise<string>;
  /** Raw byte read — binary-safe (gzip'd logs must never round-trip text). */
  readBytes(path: string): Promise<Uint8Array>;
  readJSON(path: string): Promise<unknown>;
  exists(path: string): Promise<boolean>;
  write(path: string, data: string | Uint8Array): Promise<void>;
  size(path: string): Promise<number>;
  /** Byte-accurate range read — log tailing on a growing file. */
  readRange(path: string, start: number, end: number): Promise<Uint8Array>;
  /** Synchronous (de)compression of log rotations. */
  gzip(data: Uint8Array): Uint8Array;
  gunzip(data: Uint8Array): Uint8Array;
  /** A spawn-redirect sink appending to `path`. */
  sink(path: string): PBFileSink;
  /**
   * Recursive directory watcher on the runtime's NATIVE fs-watch API —
   * node:fs.watch under Bun and Node (both implement it natively; it IS
   * Bun's recommended watcher) and Deno.watchFs under Deno. onChange
   * receives the changed entry's path (absolute under Deno, relative to
   * the watched root under Bun/Node — ignore-list matching stays the
   * caller's, by substring). Throws when the path cannot be watched.
   */
  watch(dir: string, onChange: (filename: string) => void): PBWatcher;
}

/** A live server started by `network.serve`. */
export interface PBServerHandle {
  /** Bound TCP port (undefined for unix-socket servers). */
  readonly port: number | undefined;
  /** Swap the request handler in place (daemon reload). */
  reload(fetch: (req: Request) => Response | Promise<Response>): void;
  stop(): Promise<void>;
}

/** The per-connection socket handle the dashboard broadcasts over. */
export interface PBWsSocket {
  send(data: string): void;
}

export interface PBWsHandlers {
  open?(ws: PBWsSocket): void;
  message?(ws: PBWsSocket, data: string): void | Promise<void>;
  close?(ws: PBWsSocket): void;
}

/** Second argument to a serve() fetch handler. */
export interface PBServeCtx {
  /**
   * Upgrade a request to WebSocket. Returns the Response that must be
   * returned to complete the handshake, or null when the request is not
   * upgradeable. Under Node the handshake bypasses the request handler
   * entirely (http "upgrade" event) — upgrade() always answers null there
   * and the websocket handlers still fire.
   */
  upgrade(req: Request): Response | null;
}

export interface PBServeOptions {
  /** TCP server (dashboard, metrics). */
  port?: number;
  /** Unix-socket server (the daemon transport). Mutually exclusive with port. */
  socketPath?: string;
  fetch(req: Request, ctx: PBServeCtx): Response | Promise<Response>;
  /** WebSocket support; omit for plain HTTP servers. */
  websocket?: PBWsHandlers;
}

export interface PBNetworkRuntime {
  serve(opts: PBServeOptions): PBServerHandle;
  /** fetch() over a unix socket (the daemon client transport). */
  socketFetch(url: string, init: RequestInit, socketPath: string): Promise<Response>;
}

export interface PBMiscRuntime {
  sleep(ms: number): Promise<void>;
  /** Absolute path of an executable on PATH, or null. */
  which(cmd: string): string | null;
  /** The executing runtime's own version string. */
  runtimeVersion(): string;
  /** This process's entry module path (Bun.main / argv[1] / Deno.mainModule). */
  mainPath(): string | null;
}

export interface RuntimeCapabilities {
  /** Native WebSocket server support for the dashboard (all three have it). */
  nativeWebSocket: boolean;
}

/** The runtime adapter — resolved once at startup, used process-wide. */
export interface RuntimeAdapter {
  readonly name: RuntimeName;
  readonly capabilities: RuntimeCapabilities;
  readonly process: PBProcessRuntime;
  readonly filesystem: PBFilesystemRuntime;
  readonly network: PBNetworkRuntime;
  readonly misc: PBMiscRuntime;
}

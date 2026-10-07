/**
 * ProcBoss (pboss) — minimal Deno type shim.
 *
 * pboss's toolchain (tsc + bun-types) has no Deno types; these ambient
 * declarations describe EXACTLY the Deno API surface the adapter uses.
 * Under real Deno the native types win at runtime — this shim only exists
 * so type-checking the whole repo (including the deno adapter) stays
 * possible from any runtime. Keep it in sync with the adapters by hand —
 * the surface is deliberately tiny.
 */

declare const Deno: {
  // process
  Command: new (command: string | URL, options?: {
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    // A number is a raw OS fd (dup'd into the child at spawn) — the file-sink
    // route the process adapter uses for detached children.
    stdin?: "piped" | "inherit" | "null" | number;
    stdout?: "piped" | "inherit" | "null" | number;
    stderr?: "piped" | "inherit" | "null" | number;
  }) => {
    spawn(): {
      pid: number;
      stdout: ReadableStream<Uint8Array> | null;
      stderr: ReadableStream<Uint8Array> | null;
      status: Promise<{ code: number | null; success: boolean }>;
      kill(signal?: string): void;
    };
    output(): Promise<{
      code: number | null;
      success: boolean;
      stdout: Uint8Array;
      stderr: Uint8Array;
    }>;
  };
  // filesystem
  readTextFile(path: string): Promise<string>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  writeTextFile(path: string, data: string): Promise<void>;
  stat(path: string): Promise<{ size: number; isFile: boolean }>;
  // The native recursive directory watcher — an async iterator of events
  // (filesystem.watch pumps it; close() ends the iteration).
  watchFs(paths: string | string[], opts?: { recursive?: boolean }): {
    close(): void;
    [Symbol.asyncIterator](): AsyncIterableIterator<{ kind: string; paths: string[] }>;
  };
  open(path: string, options?: {
    read?: boolean;
    write?: boolean;
    create?: boolean;
    append?: boolean;
  }): Promise<{ writable: WritableStream<Uint8Array> }>;
  // network
  // The unix-socket option is `path` in Deno's ServeOptions (Bun's is
  // `unix` — the divergence that produced the port-8000 bug this shim now
  // guards against: a `unix` key here would type-check and bind nothing).
  serve(
    options: { path?: string; port?: number } | { port: number },
    handler: (req: Request) => Response | Promise<Response>
  ): { shutdown(): Promise<void> };
  upgradeWebSocket(req: Request): {
    response: Response;
    socket: {
      send(data: string): void;
      onopen: (() => void) | null;
      onmessage: ((ev: { data: unknown }) => void) | null;
      onclose: (() => void) | null;
    };
  };
  connect(options: { transport: "unix"; path: string }): Promise<{
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
  }>;
  // misc
  env: { toObject(): Record<string, string> };
  version: { deno: string };
  mainModule: string;
  Signal: string;
};

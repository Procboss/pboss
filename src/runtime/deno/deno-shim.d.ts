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
    stdin?: "piped" | "inherit" | "null";
    stdout?: "piped" | "inherit" | "null";
    stderr?: "piped" | "inherit" | "null";
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
  open(path: string, options?: {
    read?: boolean;
    write?: boolean;
    create?: boolean;
    append?: boolean;
  }): Promise<{ writable: WritableStream<Uint8Array> }>;
  // network
  serve(
    options: { unix?: string; port?: number } | { port: number },
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

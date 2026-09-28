/**
 * ProcBoss (pboss) — Deno network adapter.
 *
 * Deno-native servers: Deno.serve({ unix } | { port }) and
 * Deno.upgradeWebSocket for the dashboard's live updates.
 *
 * The daemon CLIENT half: Deno's fetch has no Unix-socket option, so this
 * adapter carries a minimal HTTP/1.1 client over Deno.connect — the native
 * socket API — speaking exactly the protocol the daemon needs (JSON POSTs
 * and SSE streams, content-length or chunked responses).
 *
 * https://procboss.com
 * License: GPL-3.0-only
 */

import type {
  PBNetworkRuntime,
  PBServeCtx,
  PBServeOptions,
  PBServerHandle,
  PBWsSocket,
} from "../core/types";
import { ignore } from "../../error-handling";

export function createDenoNetwork(): PBNetworkRuntime {
  return {
    serve(opts: PBServeOptions): PBServerHandle {
      let handler = opts.fetch;
      const wsHandlers = opts.websocket;

      const ctx: PBServeCtx = {
        upgrade(req: Request): Response | null {
          const { response, socket } = Deno.upgradeWebSocket(req);
          const wrapped: PBWsSocket = { send: (data: string) => socket.send(data) };
          socket.onopen = () => wsHandlers?.open?.(wrapped);
          socket.onmessage = (ev) => wsHandlers?.message?.(wrapped, String(ev.data));
          socket.onclose = () => wsHandlers?.close?.(wrapped);
          return response;
        },
      };

      const server = opts.socketPath
        ? Deno.serve({ unix: opts.socketPath }, (req) => handler(req, ctx))
        : Deno.serve({ port: opts.port! }, (req) => handler(req, ctx));

      return {
        port: opts.port,
        reload(fetch) {
          handler = fetch;
        },
        stop() {
          return server.shutdown();
        },
      };
    },

    async socketFetch(url: string, init: RequestInit, socketPath: string): Promise<Response> {
      const u = new URL(url);
      const method = (init.method ?? "GET").toUpperCase();
      const headers = new Headers(init.headers as Headers | Record<string, string> | undefined);
      const body = init.body != null ? String(init.body) : null;
      if (body !== null && !headers.has("content-length")) {
        headers.set("Content-Length", String(new TextEncoder().encode(body).byteLength));
      }
      if (!headers.has("host")) headers.set("Host", "localhost");
      if (!headers.has("connection")) headers.set("Connection", "close");

      const conn = await Deno.connect({ transport: "unix", path: socketPath });
      const writer = conn.writable.getWriter();
      const reader = conn.readable.getReader();

      const requestLine = `${method} ${u.pathname}${u.search} HTTP/1.1\r\n`;
      const headerBlock = [...headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\r\n") + "\r\n";
      await writer.write(new TextEncoder().encode(`${requestLine}${headerBlock}\r\n${body ?? ""}`));
      await writer.releaseLock();

      // Read the response head; body bytes that arrive with it are passed on.
      let head = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        head += new TextDecoder().decode(value);
        const sep = head.indexOf("\r\n\r\n");
        if (sep !== -1) {
          const bodyFirst = new TextEncoder().encode(head.slice(sep + 4));
          return buildResponse(head.slice(0, sep), bodyFirst, reader, init.signal ?? null);
        }
      }
      throw new Error(`daemon socket closed before response head: ${socketPath}`);
    },
  };
}

/** What buildResponse needs from a byte stream (runtime-agnostic on purpose —
 * the DOM and node:stream/web reader types disagree across toolchains). */
interface ByteReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
}

/** Parse a response head + stream the body (content-length, chunked, or EOF). */
async function buildResponse(
  headText: string,
  bodyFirst: Uint8Array,
  reader: ByteReader,
  signal: AbortSignal | null
): Promise<Response> {
  const lines = headText.split("\r\n");
  const status = parseInt(lines[0]?.split(" ")[1] ?? "0") || 500;
  const headers = new Headers();
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(":");
    if (idx > 0) headers.append(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
  }

  const contentLength = headers.get("content-length");
  const chunked = (headers.get("transfer-encoding") ?? "").toLowerCase().includes("chunked");

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let pending = bodyFirst;
      let remaining: number = contentLength !== null ? parseInt(contentLength) : Infinity;

      const push = (bytes: Uint8Array) => {
        if (bytes.length === 0) return;
        if (!chunked) {
          if (remaining === Infinity) {
            controller.enqueue(bytes);
            return;
          }
          const take = Math.min(remaining, bytes.length);
          controller.enqueue(bytes.slice(0, take));
          remaining -= take;
          if (remaining === 0) controller.close();
          return;
        }
        // Chunked framing: strip size lines, pass payload through.
        pending = new Uint8Array([...pending, ...bytes]);
        for (;;) {
          const text = new TextDecoder().decode(pending);
          const lineEnd = text.indexOf("\r\n");
          if (lineEnd === -1) return;
          const size = parseInt(text.slice(0, lineEnd), 16);
          if (Number.isNaN(size)) return; // partial hex line — wait for more
          if (size === 0) {
            controller.close();
            return;
          }
          const payloadStart = lineEnd + 2;
          if (pending.length < payloadStart + size + 2) return; // wait for the full chunk
          controller.enqueue(pending.slice(payloadStart, payloadStart + size));
          pending = pending.slice(payloadStart + size + 2); // + trailing CRLF
        }
      };

      if (contentLength === "0") {
        controller.close();
        return;
      }

      void (async () => {
        try {
          for (;;) {
            if (signal?.aborted) break;
            const { done, value } = await reader.read();
            if (done) {
              controller.close();
              return;
            }
            if (value) push(value);
          }
          controller.close();
        } catch (err) {
          ignore("deno socketFetch body stream", err);
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      })();
    },
  });

  return new Response(stream, { status, headers });
}

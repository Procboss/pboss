/**
 * ProcBoss (pboss) — Node network adapter.
 *
 * Node-native HTTP via node:http:
 *   - serve(): createServer + listen(port | socketPath), with the standard
 *     web Request/Response bridged onto IncomingMessage/ServerResponse
 *     (those globals ARE native Node ≥ 18). The daemon transport listens on
 *     the Unix socket itself; the client half uses http.request with
 *     socketPath — Node's native fetch has no unix option.
 *   - WebSocket: the http server "upgrade" event + the `ws` package (the
 *     canonical Node implementation), imported lazily so runtimes that
 *     never start a WS server pay nothing.
 *
 * https://procboss.com
 * License: GPL-3.0-only
 */

import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { existsSync, unlinkSync } from "node:fs";
import { ignore } from "../../error-handling";
import type {
  PBNetworkRuntime,
  PBServeCtx,
  PBServeOptions,
  PBServerHandle,
  PBWsSocket,
} from "../core/types";

/** IncomingMessage → standard Request (Node's globals are web-shaped ≥18). */
async function toRequest(req: IncomingMessage): Promise<Request> {
  const method = req.method ?? "GET";
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) v.forEach((one) => headers.append(k, one));
    else headers.set(k, v);
  }
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(`http://localhost${req.url ?? "/"}`, {
    method,
    headers,
    ...(hasBody ? { body: Readable.toWeb(req) as unknown as ReadableStream, duplex: "half" } : {}),
  });
}

/** standard Response → ServerResponse (streams chunk-by-chunk for SSE). */
async function sendResponse(res: ServerResponse, response: Response): Promise<void> {
  res.writeHead(
    response.status,
    [...response.headers.entries()].map(([k, v]) => [k, v]) as [string, string][]
  );
  if (!response.body) {
    res.end();
    return;
  }
  res.flushHeaders?.();
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  } catch (err) {
    ignore("stream response body to client", err);
    res.destroy();
  }
}

export function createNodeNetwork(): PBNetworkRuntime {
  return {
    serve(opts: PBServeOptions): PBServerHandle {
      let handler = opts.fetch;
      // Under Node the WS handshake arrives as the server's "upgrade" event,
      // never through the request handler — upgrade() answers null and the
      // websocket handlers still fire.
      const ctx: PBServeCtx = { upgrade: () => null };

      const server = http.createServer(async (incoming, res) => {
        try {
          const request = await toRequest(incoming);
          const response = await handler(request, ctx);
          await sendResponse(res, response);
        } catch (err) {
          ignore("serve request", err);
          if (!res.headersSent) res.writeHead(500);
          res.end();
        }
      });

      const wsHandlers = opts.websocket;
      if (wsHandlers) {
        // ws is only imported when a WebSocket server is actually started.
        void import("ws").then(({ WebSocketServer }) => {
          const wss = new WebSocketServer({ noServer: true });
          wss.on("connection", (ws) => {
            const socket: PBWsSocket = { send: (data: string) => ws.send(data) };
            wsHandlers.open?.(socket);
            ws.on("message", (data) => wsHandlers.message?.(socket, String(data)));
            ws.on("close", () => wsHandlers.close?.(socket));
          });
          server.on("upgrade", (req, socket, head) => {
            wss.handleUpgrade(req, socket as import("node:stream").Duplex, head, () => {
              // connection handler above fires on upgrade completion
            });
          });
        });
      }

      if (opts.socketPath) {
        // Fresh bind: a stale socket file from a crashed daemon blocks the
        // listen — the callers unlink beforehand, this is the belt on top.
        try {
          if (existsSync(opts.socketPath)) unlinkSync(opts.socketPath);
        } catch (err) {
          ignore(`unlink stale socket ${opts.socketPath}`, err);
        }
        server.listen(opts.socketPath);
      } else {
        server.listen(opts.port!);
      }

      return {
        port: opts.port,
        reload(fetch) {
          handler = fetch;
        },
        stop() {
          return new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections?.();
          });
        },
      };
    },

    socketFetch(url: string, init: RequestInit, socketPath: string): Promise<Response> {
      // Node's native unix-socket HTTP: http.request({ socketPath }).
      return new Promise<Response>((resolve, reject) => {
        const u = new URL(url);
        const headers: Record<string, string> = {};
        new Headers(init.headers as Headers | Record<string, string> | undefined).forEach((v, k) => (headers[k] = v));

        const req = http.request(
          {
            socketPath,
            method: (init.method ?? "GET") as never,
            path: u.pathname + u.search,
            headers,
          },
          (res) => {
            resolve(
              new Response(
                Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>,
                { status: res.statusCode ?? 200, headers: res.headers as unknown as Headers }
              )
            );
          }
        );
        req.on("error", reject);
        init.signal?.addEventListener("abort", () => req.destroy());
        if (init.body != null) req.write(init.body as string);
        req.end();
      });
    },
  };
}

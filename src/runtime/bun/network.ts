/**
 * ProcBoss (pboss) — Bun network adapter.
 *
 * Bun-native servers and the Bun-native Unix-socket fetch: Bun.serve (with
 * native WebSocket upgrades) and fetch(url, { unix }) — the two halves of
 * the daemon's HTTP-over-unix-socket transport.
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
} from "../core/types.ts";

export function createBunNetwork(): PBNetworkRuntime {
  return {
    serve(opts: PBServeOptions): PBServerHandle {
      // reload() swaps this closure — cheaper and runtime-uniform compared
      // to Bun.serve's server.reload(opts), with identical semantics for
      // the daemon's "rebind the handler" use.
      let handler = opts.fetch;
      // The upgrade path needs the Bun server instance, available only
      // after the call below — late-bound through a mutable ref.
      let bunServer: import("bun").Server<unknown> | null = null;

      const ctx: PBServeCtx = {
        upgrade(req: Request): Response | null {
          if (!bunServer) return null;
          if (bunServer.upgrade(req, { data: undefined })) {
            return new Response(null); // handshake completed — any response works
          }
          return null;
        },
      };

      const server = Bun.serve<unknown>({
        ...(opts.socketPath ? { unix: opts.socketPath } : { port: opts.port! }),
        fetch: (req) => handler(req, ctx),
        ...(opts.websocket
          ? {
              websocket: {
                open: (w) => opts.websocket!.open?.(w as unknown as PBWsSocket),
                message: (w, message) => opts.websocket!.message?.(w as unknown as PBWsSocket, String(message)),
                close: (w) => opts.websocket!.close?.(w as unknown as PBWsSocket),
              },
            }
          : {}),
      } as Parameters<typeof Bun.serve>[0]);
      bunServer = server;

      return {
        port: server.port,
        reload(fetch) {
          handler = fetch;
        },
        stop() {
          return Promise.resolve(server.stop(true));
        },
      };
    },

    socketFetch(url: string, init: RequestInit, socketPath: string): Promise<Response> {
      // Bun's native Unix-socket fetch — the `unix` option.
      return fetch(url, { ...init, unix: socketPath } as RequestInit & { unix: string });
    },
  };
}

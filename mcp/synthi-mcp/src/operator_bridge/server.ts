/**
 * Operator HTTP bridge (phase 3 follow-up).
 *
 * The MCP speaks stdio JSON-RPC to its agent host, and the signaling-server
 * carries register / kick / presence for the operator role. Neither of
 * those reaches the escape-hatch queue, which lives in this MCP process's
 * memory. A browser-based operator UI needs an HTTP hop to read and drain
 * the queue.
 *
 * Opt-in via SYNTHI_OPERATOR_BRIDGE_PORT. Binds to 127.0.0.1 by default
 * (local-dev posture, same as Prometheus); override with
 * SYNTHI_OPERATOR_BRIDGE_HOST. A shared-secret header check
 * (SYNTHI_OPERATOR_BRIDGE_TOKEN) is opt-in on top of that so a multi-user
 * box can't curl another user's MCP.
 *
 * Endpoints:
 *   GET  /healthz                            → "ok"
 *   GET  /escape-hatch/queue                 → { entries: PendingEscapeHatch[] } (no screenshots)
 *   GET  /escape-hatch/queue/:pending_id     → full entry incl. screenshot_base64
 *   POST /escape-hatch/answer                → { pending_id, answer?, operator_id?, cancel?, cancel_reason? }
 *   GET  /escape-hatch/events                → SSE stream; emits one "pending" event per enqueue
 *
 * CORS is permissive on GET/POST for the escape-hatch paths because the
 * operator UI lives on a different port (next.js on :3000, MCP bridge on
 * e.g. :9465). We still gate on the shared-secret header when configured.
 */

import http from "node:http";
import { escapeHatchQueue, type PendingEscapeHatch } from "../escape_hatch/queue.js";

export interface OperatorBridgeOptions {
  port: number;
  host?: string;
  /** When set, requests must carry `x-synthi-operator-token: <token>`. */
  token?: string;
}

const SSE_HEARTBEAT_MS = 15_000;
const SSE_IDLE_TTL_MS = Number(process.env["SYNTHI_OPERATOR_SSE_IDLE_TTL_MS"] ?? 30 * 60_000);
const SSE_SWEEP_MS = 60_000;
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Synthi-Operator-Token",
  "Access-Control-Max-Age": "600",
};

function redactScreenshot(entry: PendingEscapeHatch): PendingEscapeHatch {
  const { screenshot_base64: _blob, ...rest } = entry as PendingEscapeHatch & { screenshot_base64?: string };
  return rest as PendingEscapeHatch;
}

async function readJsonBody<T>(req: http.IncomingMessage, maxBytes: number = 1_000_000): Promise<T> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("payload_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.length === 0) {
        resolve({} as T);
        return;
      }
      try {
        resolve(JSON.parse(raw) as T);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    req.on("error", reject);
  });
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...CORS_HEADERS,
  });
  res.end(JSON.stringify(body));
}

/**
 * Start the operator bridge. Returns the underlying `http.Server`, a
 * `ready` promise that resolves once `server.address()` is populated
 * (important when passing `port: 0` in tests), and a close fn that tears
 * down active SSE streams so `performShutdown` can hang up cleanly.
 */
export function startOperatorBridge(opts: OperatorBridgeOptions): {
  server: http.Server;
  ready: Promise<void>;
  close: () => Promise<void>;
} {
  const host = opts.host ?? "127.0.0.1";
  const sseClients = new Set<http.ServerResponse>();
  const heartbeatTimers = new Map<http.ServerResponse, NodeJS.Timeout>();
  const sseLastActive = new Map<http.ServerResponse, number>();

  const cleanupSseClient = (res: http.ServerResponse, end: boolean = false): void => {
    const hb = heartbeatTimers.get(res);
    if (hb) clearInterval(hb);
    heartbeatTimers.delete(res);
    sseLastActive.delete(res);
    sseClients.delete(res);
    if (end && !res.destroyed && !res.writableEnded) {
      try {
        res.end();
      } catch {
        // ignored
      }
    }
  };

  const sweepSseClients = setInterval(() => {
    const cutoff = Date.now() - SSE_IDLE_TTL_MS;
    for (const res of sseClients) {
      const lastActive = sseLastActive.get(res) ?? 0;
      if (lastActive < cutoff) {
        cleanupSseClient(res, true);
      }
    }
  }, SSE_SWEEP_MS);
  if (sweepSseClients.unref) sweepSseClients.unref();

  const pushToSse = (event: string, data: unknown): void => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(payload);
        sseLastActive.set(res, Date.now());
      } catch {
        cleanupSseClient(res, true);
      }
    }
  };

  const queueUnsub = escapeHatchQueue.onPending((entry) => {
    pushToSse("pending", redactScreenshot(entry));
  });

  const server = http.createServer(async (req, res) => {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    if (method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    if (opts.token !== undefined) {
      const supplied = req.headers["x-synthi-operator-token"];
      if (supplied !== opts.token) {
        writeJson(res, 401, { error: "unauthorized" });
        return;
      }
    }

    if (url === "/healthz" && method === "GET") {
      res.writeHead(200, { "Content-Type": "text/plain", ...CORS_HEADERS });
      res.end("ok\n");
      return;
    }

    if (url === "/escape-hatch/queue" && method === "GET") {
      const entries = escapeHatchQueue.list().map(redactScreenshot);
      writeJson(res, 200, { entries, size: entries.length });
      return;
    }

    if (method === "GET" && url.startsWith("/escape-hatch/queue/")) {
      const id = decodeURIComponent(url.slice("/escape-hatch/queue/".length));
      const entry = escapeHatchQueue.get(id);
      if (!entry) {
        writeJson(res, 404, { error: "escape_hatch_unknown_pending", pending_id: id });
        return;
      }
      writeJson(res, 200, { entry });
      return;
    }

    if (url === "/escape-hatch/answer" && method === "POST") {
      let body: {
        pending_id?: unknown;
        answer?: unknown;
        operator_id?: unknown;
        cancel?: unknown;
        cancel_reason?: unknown;
      };
      try {
        body = await readJsonBody(req);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        writeJson(res, 400, { error: "invalid_body", detail: msg });
        return;
      }
      if (typeof body.pending_id !== "string" || body.pending_id.length === 0) {
        writeJson(res, 400, { error: "invalid_args", field: "pending_id" });
        return;
      }
      const operatorId = typeof body.operator_id === "string" ? body.operator_id : undefined;

      if (body.cancel === true) {
        const reason =
          typeof body.cancel_reason === "string" && body.cancel_reason.length > 0
            ? body.cancel_reason
            : "operator_canceled";
        const ok = escapeHatchQueue.cancel(body.pending_id, reason);
        if (!ok) {
          writeJson(res, 404, { error: "escape_hatch_unknown_pending", pending_id: body.pending_id });
          return;
        }
        pushToSse("resolved", { pending_id: body.pending_id, canceled: true, reason });
        writeJson(res, 200, { ok: true, canceled: true, reason });
        return;
      }

      if (body.answer === undefined) {
        writeJson(res, 400, { error: "invalid_args", field: "answer" });
        return;
      }
      const ok = escapeHatchQueue.resolve(body.pending_id, body.answer, operatorId);
      if (!ok) {
        writeJson(res, 404, { error: "escape_hatch_unknown_pending", pending_id: body.pending_id });
        return;
      }
      pushToSse("resolved", {
        pending_id: body.pending_id,
        ...(operatorId !== undefined ? { operator_id: operatorId } : {}),
      });
      writeJson(res, 200, { ok: true });
      return;
    }

    if (url === "/escape-hatch/events" && method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        ...CORS_HEADERS,
      });
      res.write(`event: hello\ndata: ${JSON.stringify({ bridge_version: 1 })}\n\n`);
      const snapshot = escapeHatchQueue.list().map(redactScreenshot);
      res.write(`event: snapshot\ndata: ${JSON.stringify({ entries: snapshot })}\n\n`);
      sseClients.add(res);
      sseLastActive.set(res, Date.now());
      const hb = setInterval(() => {
        try {
          res.write(`: heartbeat ${Date.now()}\n\n`);
          sseLastActive.set(res, Date.now());
        } catch {
          cleanupSseClient(res, true);
        }
      }, SSE_HEARTBEAT_MS);
      heartbeatTimers.set(res, hb);
      req.on("close", () => {
        cleanupSseClient(res);
      });
      res.on("error", () => cleanupSseClient(res, true));
      return;
    }

    writeJson(res, 404, { error: "not_found", url, method });
  });

  const ready = new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", (err) => reject(err));
  });
  server.listen(opts.port, host);

  const close = async (): Promise<void> => {
    queueUnsub();
    clearInterval(sweepSseClients);
    for (const [res, timer] of heartbeatTimers) {
      clearInterval(timer);
      try {
        res.end();
      } catch {
        // ignored
      }
    }
    heartbeatTimers.clear();
    sseLastActive.clear();
    sseClients.clear();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  };

  return { server, ready, close };
}

/** Parse SYNTHI_OPERATOR_BRIDGE_PORT. Returns undefined when unset / invalid. */
export function resolveOperatorBridgePort(envValue: string | undefined): number | undefined {
  if (!envValue) return undefined;
  const n = Number(envValue);
  if (!Number.isFinite(n) || n <= 0 || n > 65535) return undefined;
  return Math.floor(n);
}

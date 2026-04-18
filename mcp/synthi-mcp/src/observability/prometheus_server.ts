/**
 * Optional HTTP server exposing `/metrics` in Prometheus text format.
 *
 * Opt-in via `SYNTHI_PROMETHEUS_PORT`. Binds to 127.0.0.1 by default
 * (never public) since the MCP is a single-session local-dev process
 * and cross-host scraping would be a surprise. Override via
 * `SYNTHI_PROMETHEUS_HOST` if you really mean it.
 */

import http from "node:http";
import { metrics } from "./metrics.js";

export interface PrometheusServerOptions {
  port: number;
  host?: string;
  /** Extra path handled with a simple text `ok\n` so orchestrators can probe liveness. */
  healthPath?: string;
}

const DEFAULT_HEALTH_PATH = "/healthz";

/**
 * Render the metrics text exactly once per request. Callers should not
 * reach into the registry directly — this keeps the output versioned.
 */
export function renderPrometheusText(): string {
  const body = metrics.render();
  return body.length > 0 ? body + "\n" : "";
}

export function startPrometheusServer(opts: PrometheusServerOptions): http.Server {
  const host = opts.host ?? "127.0.0.1";
  const healthPath = opts.healthPath ?? DEFAULT_HEALTH_PATH;
  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/metrics" || url.startsWith("/metrics?")) {
      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
      res.end(renderPrometheusText());
      return;
    }
    if (url === healthPath) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok\n");
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found\n");
  });
  server.listen(opts.port, host);
  return server;
}

/**
 * Parse + validate `SYNTHI_PROMETHEUS_PORT`. Returns `undefined` when
 * unset / zero / non-numeric so callers can `if (port) start()`.
 */
export function resolvePrometheusPort(envValue: string | undefined): number | undefined {
  if (!envValue) return undefined;
  const n = Number(envValue);
  if (!Number.isFinite(n) || n <= 0 || n > 65535) return undefined;
  return Math.floor(n);
}

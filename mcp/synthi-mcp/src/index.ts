#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createSynthiServer } from "./server.js";
import { session } from "./session.js";
import { requestRegistry } from "./util/request_registry.js";
import { eventLog } from "./events/index.js";
import { bindEventLogToMetrics } from "./observability/metrics.js";
import {
  resolvePrometheusPort,
  startPrometheusServer,
} from "./observability/prometheus_server.js";
import { performShutdown } from "./shutdown.js";
import type { Server as HttpServer } from "node:http";

function parseArgs(argv: string[]): { sessionId?: string; signalingUrl?: string } {
  const out: { sessionId?: string; signalingUrl?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--session" || arg === "--session-id") {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out.sessionId = next;
        i++;
      }
    } else if (arg === "--signaling-url") {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out.signalingUrl = next;
        i++;
      }
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const envSession = process.env.SYNTHI_SESSION_ID;
  const envSignaling = process.env.SYNTHI_SIGNALING_URL;

  const defaultSessionId = args.sessionId ?? envSession;
  const defaultSignalingUrl = args.signalingUrl ?? envSignaling ?? "ws://localhost:9000";

  const server = createSynthiServer({
    defaultSessionId,
    defaultSignalingUrl,
  });

  const transport = new StdioServerTransport();

  // Optional: Prometheus /metrics endpoint. Opt-in via
  // SYNTHI_PROMETHEUS_PORT=9464 (or any valid port). Binds to 127.0.0.1
  // unless SYNTHI_PROMETHEUS_HOST overrides. Unsubscribe/close happens
  // in `shutdown()` below.
  let metricsServer: HttpServer | undefined;
  let unbindMetrics: (() => void) | undefined;
  const promPort = resolvePrometheusPort(process.env["SYNTHI_PROMETHEUS_PORT"]);
  if (promPort !== undefined) {
    unbindMetrics = bindEventLogToMetrics(eventLog);
    const host = process.env["SYNTHI_PROMETHEUS_HOST"];
    metricsServer = startPrometheusServer(host ? { port: promPort, host } : { port: promPort });
    process.stderr.write(`synthi-mcp metrics: http://127.0.0.1:${promPort}/metrics\n`);
  }

  const shutdown = async (): Promise<void> => {
    await performShutdown({
      requestRegistry,
      session,
      server,
      ...(unbindMetrics ? { unbindMetrics } : {}),
      ...(metricsServer ? { metricsServer } : {}),
      logError: (step, err) => {
        process.stderr.write(
          `synthi-mcp shutdown[${step}]: ${err instanceof Error ? err.message : String(err)}\n`
        );
      },
    });
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`synthi-mcp fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});

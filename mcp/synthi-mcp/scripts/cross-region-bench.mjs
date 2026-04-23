#!/usr/bin/env node
/**
 * cross-region-bench — Phase 4 latency harness.
 *
 * Measures the MCP ↔ signaling-server hop across (potentially) different
 * regions. Four metrics per iteration:
 *
 *   - `ws_connect_ms`       time to WebSocket open
 *   - `register_ack_ms`     time from `register` send to `registered` ack
 *   - `echo_rtt_ms`         time for a round-trip `ping`-style envelope;
 *                           sent as a bogus `sdp_type:"ping"` on an
 *                           unoccupied `worker` role so the server
 *                           rejects it and the rejection path latency is
 *                           what we measure
 *   - `presence_rtt_ms`     time to receive the first `presence` event
 *                           after register — server emits on register
 *
 * Intended to run from different geographic locations against the same
 * signaling-server, label each run with a region tag, and compare
 * distributions. Does NOT spin up a worker / WebRTC peer — pure signaling
 * latency. Worker + dataplane benchmarks belong in a full end-to-end
 * harness (`tests/soak/`) because they require compute resources per
 * region, which is not something this script can provision.
 *
 * Usage:
 *   node scripts/cross-region-bench.mjs \
 *     --url ws://signaling.example.com:9000 \
 *     --region us-east \
 *     --iterations 30 \
 *     [--agent-token "$SYNTHI_AGENT_TOKEN"] \
 *     [--role observer|mcp-agent] \
 *     [--session-id sess-bench]
 *
 * Output: NDJSON per-iteration rows on stdout, plus a `---` separator
 * followed by an aggregate-summary JSON object. Pipe stdout into a file
 * to archive the raw data; pipe stderr into a terminal to watch progress.
 */

import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function summarize(samples, key) {
  const values = samples.map((s) => s[key]).filter((v) => Number.isFinite(v));
  if (values.length === 0) return { n: 0 };
  values.sort((a, b) => a - b);
  const sum = values.reduce((acc, v) => acc + v, 0);
  return {
    n: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
    mean: +(sum / values.length).toFixed(3),
    min: values[0],
    max: values[values.length - 1],
  };
}

async function runOnce({ url, sessionId, role, agentToken }) {
  const t_start = performance.now();
  const ws = new WebSocket(url);
  const sample = {
    ws_connect_ms: null,
    register_ack_ms: null,
    presence_rtt_ms: null,
    echo_rtt_ms: null,
    error: null,
  };

  const done = new Promise((resolve) => {
    let registerSentAt = null;
    let echoSentAt = null;
    let presenceSeen = false;
    let ackSeen = false;
    const finalize = () => {
      try { ws.close(); } catch { /* ignored */ }
      resolve();
    };

    ws.on("open", () => {
      sample.ws_connect_ms = +(performance.now() - t_start).toFixed(3);
      const registerMsg = {
        type: "register",
        role,
        session_id: sessionId,
        client_version: "cross-region-bench/0.1.0",
        supported_protocols: [1],
      };
      if (agentToken) registerMsg.agent_token = agentToken;
      registerSentAt = performance.now();
      ws.send(JSON.stringify(registerMsg));
    });

    ws.on("message", (data) => {
      const text = typeof data === "string" ? data : data.toString("utf8");
      let msg;
      try { msg = JSON.parse(text); } catch { return; }
      if (msg.type === "registered") {
        ackSeen = true;
        sample.register_ack_ms = +(performance.now() - registerSentAt).toFixed(3);
        // Echo probe: send a bogus `sdp_type:"ping"` on `offer`. With no
        // `worker` peer on the session, the server routes it to a worker
        // that doesn't exist — we don't actually need the echo to land,
        // we measure time-until-server-acknowledges-delivery-or-drops it
        // via an `unknown` / `error` class message. Conservative: if we
        // get any reply within 2s we record it; otherwise skip.
        echoSentAt = performance.now();
        ws.send(
          JSON.stringify({
            type: "ping",
            peer_id: `bench-${randomUUID()}`,
          })
        );
      } else if (msg.type === "presence" && !presenceSeen) {
        presenceSeen = true;
        sample.presence_rtt_ms = +(performance.now() - registerSentAt).toFixed(3);
      } else if (echoSentAt !== null && sample.echo_rtt_ms === null) {
        // Any post-register message counts as the echo. Good enough for
        // relative regional comparisons.
        sample.echo_rtt_ms = +(performance.now() - echoSentAt).toFixed(3);
      }
      if (ackSeen && presenceSeen && sample.echo_rtt_ms !== null) {
        finalize();
      }
    });

    ws.on("error", (err) => {
      sample.error = err.message ?? String(err);
      finalize();
    });
    ws.on("close", () => finalize());

    // 8s hard cap per iteration — without it a dropped socket would hang
    // the loop and tank the harness.
    delay(8_000).then(() => {
      if (!ackSeen) sample.error = sample.error ?? "timeout_waiting_for_register_ack";
      finalize();
    });
  });

  await done;
  return sample;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = args.url ?? "ws://127.0.0.1:9000";
  const iterations = Number.isFinite(+args.iterations) ? +args.iterations : 20;
  const region = args.region ?? "unknown";
  const role = args.role ?? "observer";
  const agentToken = args["agent-token"] ?? process.env.SYNTHI_AGENT_TOKEN ?? "";
  const sessionIdBase = args["session-id"] ?? `sess-bench-${randomUUID().slice(0, 8)}`;
  const gapMs = Number.isFinite(+args["gap-ms"]) ? +args["gap-ms"] : 500;

  process.stderr.write(
    `cross-region-bench: url=${url} region=${region} role=${role} iterations=${iterations}\n`
  );

  const samples = [];
  for (let i = 0; i < iterations; i++) {
    const sessionId = `${sessionIdBase}-${i}`;
    const sample = await runOnce({
      url,
      sessionId,
      role,
      agentToken,
    });
    sample.iteration = i;
    sample.region = region;
    sample.role = role;
    sample.url = url;
    sample.ts = new Date().toISOString();
    samples.push(sample);
    process.stdout.write(`${JSON.stringify(sample)}\n`);
    await delay(gapMs);
  }

  const summary = {
    summary: true,
    region,
    role,
    url,
    iterations,
    ws_connect: summarize(samples, "ws_connect_ms"),
    register_ack: summarize(samples, "register_ack_ms"),
    presence_rtt: summarize(samples, "presence_rtt_ms"),
    echo_rtt: summarize(samples, "echo_rtt_ms"),
    errors: samples.filter((s) => s.error).map((s) => ({ iteration: s.iteration, error: s.error })),
  };
  process.stdout.write("---\n");
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((err) => {
  process.stderr.write(`cross-region-bench fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});

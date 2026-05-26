#!/usr/bin/env node
// Live regression: two MCP subprocesses attached to one session must not
// both control input. Requires a running Synthi stack and a live session.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CFG = {
  sessionId: process.env.SESSION_ID ?? process.env.SYNTHI_SESSION_ID,
  signalingUrl: process.env.SIGNALING_URL ?? process.env.SYNTHI_SIGNALING_URL ?? "ws://localhost:9000",
  mcpEntry: path.resolve(__dirname, process.env.MCP_ENTRY ?? "../dist/index.js"),
  timeoutMs: Number(process.env.TIMEOUT_MS ?? 30_000),
};

if (!CFG.sessionId) fail("Set SESSION_ID or SYNTHI_SESSION_ID for the live session to test.");

function fail(message) {
  console.error(`[fail] ${message}`);
  process.exit(1);
}

function ok(message) {
  console.log(`[ok] ${message}`);
}

class McpClient {
  constructor(label, proc) {
    this.label = label;
    this.proc = proc;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.stderrTail = [];
    proc.stdout.on("data", (chunk) => this.onData(chunk.toString()));
    proc.stderr.on("data", (chunk) => {
      this.stderrTail.push(chunk.toString());
      if (this.stderrTail.length > 30) this.stderrTail.shift();
    });
    proc.on("exit", (code, sig) => {
      for (const [, pending] of this.pending) {
        pending.reject(new Error(`${this.label} exited ${code ?? sig}`));
      }
      this.pending.clear();
    });
  }

  onData(text) {
    this.buffer += text;
    let idx;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && this.pending.has(msg.id)) {
        const pending = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) pending.reject(new Error(JSON.stringify(msg.error)));
        else pending.resolve(msg.result);
      }
    }
  }

  request(method, params = {}, timeoutMs = CFG.timeoutMs) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.label} ${method} timeout; stderr:\n${this.stderrTail.join("")}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  async toolCall(name, args, timeoutMs) {
    const result = await this.request("tools/call", { name, arguments: args }, timeoutMs);
    const text = result?.content?.find?.((item) => item?.type === "text")?.text ?? "{}";
    let body;
    try { body = JSON.parse(text); } catch { body = { raw: text }; }
    return { isError: result?.isError === true, body };
  }

  close() {
    try { this.proc.kill(); } catch {}
  }
}

function start(label, agentId) {
  const proc = spawn(process.execPath, [CFG.mcpEntry], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      SYNTHI_AGENT_ID: agentId,
      SYNTHI_LEASE_MODE: "single-holder",
      SYNTHI_BROKER_INPUT_MODE: "enforce",
      SYNTHI_SESSION_ID: CFG.sessionId,
      SYNTHI_SIGNALING_URL: CFG.signalingUrl,
    },
  });
  return new McpClient(label, proc);
}

async function main() {
  const a = start("agent-a", "lease-live-agent-a");
  const b = start("agent-b", "lease-live-agent-b");
  try {
    const attachArgs = {
      sessionId: CFG.sessionId,
      signalingUrl: CFG.signalingUrl,
      "i-understand-no-auth": true,
    };
    const [attachA, attachB] = await Promise.all([
      a.toolCall("synthi_attach", attachArgs, CFG.timeoutMs),
      b.toolCall("synthi_attach", attachArgs, CFG.timeoutMs),
    ]);
    if (attachA.isError || attachB.isError) fail(`attach failed: ${JSON.stringify({ attachA, attachB })}`);
    ok("both MCP subprocesses attached");

    const leaseA = await a.toolCall("synthi_acquire_input", { lease_ms: 10_000, owner: "lease-live-agent-a" });
    if (leaseA.isError || !leaseA.body.lease_id) fail(`agent A acquire failed: ${JSON.stringify(leaseA.body)}`);
    ok(`agent A acquired ${leaseA.body.lease_id}`);

    const leaseB1 = await b.toolCall("synthi_acquire_input", { lease_ms: 10_000, owner: "lease-live-agent-b" });
    if (!leaseB1.isError && leaseB1.body.ok) fail(`agent B unexpectedly acquired: ${JSON.stringify(leaseB1.body)}`);
    ok(`agent B acquire rejected: ${leaseB1.body.error ?? "queued"}`);

    const inputB = await b.toolCall("synthi_keyboard", {
      action: "key",
      key: "Escape",
      lease_id: "wrong-live-lease",
      await_ack: true,
      ack_timeout_ms: 2_000,
    });
    if (!inputB.isError) fail(`agent B input unexpectedly dispatched: ${JSON.stringify(inputB.body)}`);
    ok(`agent B input rejected: ${inputB.body.error}`);

    const releaseA = await a.toolCall("synthi_release_input", { lease_id: leaseA.body.lease_id });
    if (releaseA.isError) fail(`agent A release failed: ${JSON.stringify(releaseA.body)}`);
    ok("agent A released");

    const leaseB2 = await b.toolCall("synthi_acquire_input", { lease_ms: 10_000, owner: "lease-live-agent-b" });
    if (leaseB2.isError || !leaseB2.body.lease_id) fail(`agent B acquire after release failed: ${JSON.stringify(leaseB2.body)}`);
    ok(`agent B acquired after release ${leaseB2.body.lease_id}`);

    const events = await b.toolCall("synthi_get_event_log", { kind: "lease", limit: 50 });
    if (events.isError || Number(events.body.count ?? 0) < 2) {
      fail(`lease event log did not show lifecycle: ${JSON.stringify(events.body)}`);
    }
    ok("event log contains lease lifecycle entries");
  } finally {
    a.close();
    b.close();
  }
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));

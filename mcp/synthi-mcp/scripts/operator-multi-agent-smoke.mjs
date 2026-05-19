#!/usr/bin/env node
// Live smoke for the operator-facing multi-agent UX contract.
//
// This does not need a worker or browser. It validates the signaling
// messages consumed by synthi/src/services/operatorClient.js:
//   1. an operator attaches to a session,
//   2. N subagents attach as observer or mcp-agent peers,
//   3. operator presence reports the expected agent count,
//   4. the operator kill switch evicts those peers,
//   5. presence returns to zero for a fresh smoke session.

import { WebSocket } from "ws";

const explicitSession = Boolean(process.env.SESSION_ID || process.env.SLUG);
const CFG = {
  signalingUrl: process.env.SIGNALING_URL ?? "ws://localhost:9000",
  sessionId: process.env.SESSION_ID ?? process.env.SLUG ?? `operator-multi-agent-smoke-${Date.now()}`,
  agentRole: process.env.AGENT_ROLE ?? "mcp-agent",
  agentCount: Number(process.env.AGENT_COUNT ?? 2),
  timeoutMs: Number(process.env.TIMEOUT_MS ?? 10_000),
  skipKick: process.env.SKIP_KICK === "1",
  allowExistingSessionKick: process.env.ALLOW_EXISTING_SESSION_KICK === "1",
};

if (!Number.isInteger(CFG.agentCount) || CFG.agentCount < 1 || CFG.agentCount > 20) {
  fail("AGENT_COUNT must be an integer between 1 and 20");
}

if (CFG.agentRole !== "mcp-agent" && CFG.agentRole !== "observer") {
  fail("AGENT_ROLE must be either mcp-agent or observer");
}

if (explicitSession && !CFG.skipKick && !CFG.allowExistingSessionKick) {
  fail(
    "Refusing to kick peers in an explicit SESSION_ID/SLUG. Re-run with " +
      "ALLOW_EXISTING_SESSION_KICK=1, or use SKIP_KICK=1 for presence-only."
  );
}

function log(kind, msg) {
  const tag = kind === "ok" ? "[ok]" : kind === "warn" ? "[warn]" : "[info]";
  console.log(`${tag} ${msg}`);
}

function fail(msg) {
  console.error(`[fail] ${msg}`);
  process.exit(1);
}

function agentTokenFor(index) {
  const raw = process.env.AGENT_TOKENS ?? process.env.SYNTHI_AGENT_TOKEN ?? "";
  const tokens = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return tokens[index] ?? tokens[0] ?? undefined;
}

class Peer {
  constructor({ url, sessionId, role, tag, agentToken }) {
    this.url = url;
    this.sessionId = sessionId;
    this.role = role;
    this.tag = tag;
    this.agentToken = agentToken;
    this.ws = null;
    this.messages = [];
    this.waiters = [];
    this.closed = false;
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.tag} open timeout`)), CFG.timeoutMs);
      this.ws.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    this.ws.on("message", (data) => this.handleMessage(data));
    this.ws.on("close", (code, reason) => this.handleClose(code, reason));
    this.ws.on("error", (err) => this.handleError(err));

    this.send({
      type: "register",
      role: this.role,
      session_id: this.sessionId,
      client_version: `operator-multi-agent-smoke/${this.tag}`,
      supported_protocols: [1],
      ...(this.agentToken ? { agent_token: this.agentToken } : {}),
    });

    const registered = await this.waitFor(
      (msg) => msg.type === "registered" || msg.type === "register-error",
      "registered"
    );
    if (registered.type === "register-error") {
      throw new Error(`${this.tag} register-error: ${registered.code ?? JSON.stringify(registered)}`);
    }
    return registered;
  }

  send(payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`${this.tag} socket is not open`);
    }
    this.ws.send(JSON.stringify(payload));
  }

  waitFor(predicate, label, timeoutMs = CFG.timeoutMs) {
    for (const msg of this.messages) {
      if (safePredicate(predicate, msg)) return Promise.resolve(msg);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        reject(new Error(`${this.tag} timed out waiting for ${label}`));
      }, timeoutMs);
      this.waiters.push({ predicate, label, resolve, reject, timer });
    });
  }

  handleMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data.toString("utf8"));
    } catch {
      return;
    }
    this.messages.push(msg);
    const stillWaiting = [];
    for (const waiter of this.waiters) {
      if (safePredicate(waiter.predicate, msg)) {
        clearTimeout(waiter.timer);
        waiter.resolve(msg);
      } else {
        stillWaiting.push(waiter);
      }
    }
    this.waiters = stillWaiting;
  }

  handleClose(code, reason) {
    this.closed = true;
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(
        new Error(`${this.tag} closed before ${waiter.label}: ${code} ${reason?.toString?.() ?? ""}`.trim())
      );
    }
    this.waiters = [];
  }

  handleError(err) {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
    this.waiters = [];
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      // no-op
    }
  }
}

function safePredicate(predicate, msg) {
  try {
    return Boolean(predicate(msg));
  } catch {
    return false;
  }
}

function countOperatorEvents(peer, kind, role) {
  return peer.messages.filter((msg) => {
    return msg.type === "operator-event" && msg.kind === kind && (role ? msg.role === role : true);
  }).length;
}

async function main() {
  log("info", `signaling=${CFG.signalingUrl}`);
  log("info", `session=${CFG.sessionId}`);
  log("info", `agent_role=${CFG.agentRole} count=${CFG.agentCount}`);

  const peers = [];
  const operator = new Peer({
    url: CFG.signalingUrl,
    sessionId: CFG.sessionId,
    role: "operator",
    tag: "operator",
  });
  peers.push(operator);

  await operator.connect();
  log("ok", "operator registered");

  let baselineAgents = 0;
  try {
    const baseline = await operator.waitFor((msg) => msg.type === "presence", "initial presence", 2_000);
    baselineAgents = Number(baseline.attached_agents ?? 0);
    log("ok", `initial presence: humans=${baseline.attached_humans ?? 0} agents=${baselineAgents}`);
  } catch {
    log("warn", "no initial presence within 2s; assuming baseline agents=0");
  }

  const agents = [];
  for (let i = 0; i < CFG.agentCount; i++) {
    const agent = new Peer({
      url: CFG.signalingUrl,
      sessionId: CFG.sessionId,
      role: CFG.agentRole,
      tag: `${CFG.agentRole}-${i + 1}`,
      agentToken: agentTokenFor(i),
    });
    peers.push(agent);
    agents.push(agent);
  }

  await Promise.all(agents.map((agent) => agent.connect()));
  log("ok", `${CFG.agentCount} ${CFG.agentRole} peers registered`);

  const expectedAgents = baselineAgents + CFG.agentCount;
  const joinedPresence = await operator.waitFor(
    (msg) => msg.type === "presence" && Number(msg.attached_agents ?? 0) >= expectedAgents,
    `presence agents >= ${expectedAgents}`
  );
  log(
    "ok",
    `operator presence after attach: humans=${joinedPresence.attached_humans ?? 0} agents=${joinedPresence.attached_agents}`
  );

  await operator.waitFor(
    () => countOperatorEvents(operator, "peer_registered", CFG.agentRole) >= CFG.agentCount,
    `${CFG.agentCount} operator peer_registered events`
  );
  log("ok", "operator event log received peer_registered entries");

  if (CFG.skipKick) {
    log("warn", "SKIP_KICK=1 set; presence-only smoke complete");
    return;
  }

  const ackPromise = operator.waitFor(
    (msg) => msg.type === "kick-ack" && msg.target_role === CFG.agentRole,
    "kick-ack"
  );
  const evictedPromises = agents.map((agent) =>
    agent.waitFor((msg) => msg.type === "evicted", "evicted").catch((err) => ({ error: err.message }))
  );

  operator.send({
    type: "kick-peer",
    session_id: CFG.sessionId,
    target_role: CFG.agentRole,
    reason: "operator_multi_agent_smoke",
  });

  const ack = await ackPromise;
  if (Number(ack.kicked ?? 0) < CFG.agentCount) {
    fail(`kick-ack kicked=${ack.kicked}; expected at least ${CFG.agentCount}`);
  }
  log("ok", `operator kick ack: target=${ack.target_role} kicked=${ack.kicked}`);

  const evicted = await Promise.all(evictedPromises);
  const missingEvictions = evicted.filter((result) => result?.error);
  if (missingEvictions.length > 0) {
    fail(`missing evicted frame from ${missingEvictions.length} agent(s): ${JSON.stringify(missingEvictions)}`);
  }
  log("ok", "all spawned subagents received evicted frames");

  const postKickPresence = await operator.waitFor(
    (msg) => msg.type === "presence" && Number(msg.attached_agents ?? -1) <= baselineAgents,
    `presence agents <= ${baselineAgents}`
  );
  log(
    "ok",
    `operator presence after kick: humans=${postKickPresence.attached_humans ?? 0} agents=${postKickPresence.attached_agents}`
  );

  await operator.waitFor(
    () => countOperatorEvents(operator, "peer_disconnected", CFG.agentRole) >= CFG.agentCount,
    `${CFG.agentCount} operator peer_disconnected events`
  );
  log("ok", "operator event log received peer_disconnected entries");
}

main()
  .catch((err) => fail(err instanceof Error ? err.message : String(err)))
  .finally(() => {
    // Give close frames a short chance to flush, then force process exit.
    setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref();
  });

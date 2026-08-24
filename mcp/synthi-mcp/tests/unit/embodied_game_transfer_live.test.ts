/**
 * LIVE agent-to-agent skill transfer over two REAL bridge processes:
 *
 *   AGENT A (port 3001, this test process): has the game registered; a
 *   human walks via synthi_perform_action during an open recording;
 *   stop compiles the contract; export emits synthi.skill.v1.
 *
 *   AGENT B (port 3002, SEPARATE OS PROCESS via scripts/bridge_agent.mts):
 *   imports the skill file over HTTP, attaches to the same live game
 *   world through its own WebSocket connection, runs it in fresh_state,
 *   and the WORLD's authoritative position proves the displacement was
 *   applied by B's execution.
 */
import { test, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import { WebSocketServer, WebSocket } from "ws";
import { startBrowserWorkflowBridge } from "../../src/browser_workflow_bridge/server.js";
import { embodiedBridgeContext } from "../../src/browser_workflow_bridge/embodied_dispatch.js";
import { registerSubstrateAdapter } from "../../src/embodied/substrate.js";
import { createGameBundle } from "../../src/embodied/adapters/game/protocol.js";

// Deterministic live game world shared by both agents.
let px = 320;
let py = 240;

function makeGameServer(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolveServer) => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 }, () => {
      const address = wss.address() as { port: number };
      resolveServer({
        url: `ws://127.0.0.1:${address.port}`,
        close: () => new Promise<void>((r) => wss.close(() => r())),
      });
    });
    wss.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as {
          op: string;
          action?: { move?: { dx: number; dy: number } };
          x?: number;
          y?: number;
        };
        if (msg.op === "act" && msg.action?.move) {
          px = Math.max(12, Math.min(628, px + msg.action.move.dx));
          py = Math.max(12, Math.min(468, py + msg.action.move.dy));
          socket.send(JSON.stringify({ ok: true }));
        } else if (msg.op === "observe") {
          socket.send(
            JSON.stringify({ entities: [{ id: "player", x: msg.x ?? px, y: msg.y ?? py }] }),
          );
        }
      });
    });
  });
}

async function bridgeCall(port: number, tool: string, args: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`http://127.0.0.1:${port}/browser-workflows/tool`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool, arguments: args }),
  });
  const body = (await res.json()) as { result?: Record<string, unknown> };
  return body.result ?? {};
}

const closers: Array<() => Promise<void>> = [];
const children: Array<ReturnType<typeof spawn>> = [];
let gameUrl = "";
let bridgeBProcess: ReturnType<typeof spawn> | null = null;

beforeAll(async () => {
  const server = await makeGameServer();
  gameUrl = server.url;
  closers.push(server.close);

  // Agent A lives in THIS process with its own game transport.
  let aSocket: WebSocket | null = null;
  const aQueue: unknown[] = [];
  const aWaiters: Array<(v: unknown) => void> = [];
  registerSubstrateAdapter(
    createGameBundle(() => ({
      async send(message: unknown) {
        if (!aSocket) {
          await new Promise<void>((resolveOpen, rejectOpen) => {
            const s = new WebSocket(gameUrl);
            s.on("message", (raw: Buffer) => {
              const parsed = JSON.parse(raw.toString()) as unknown;
              const w = aWaiters.shift();
              if (w) w(parsed);
              else aQueue.push(parsed);
            });
            s.once("open", () => {
              aSocket = s;
              resolveOpen();
            });
            s.once("error", rejectOpen);
          });
        }
        aSocket!.send(JSON.stringify(message));
      },
      async receive<T = unknown>(): Promise<T> {
        const queued = aQueue.shift();
        if (queued !== undefined) return queued as T;
        return new Promise<T>((r) => aWaiters.push(r as (v: unknown) => void));
      },
    })),
  );
  embodiedBridgeContext();
  const bridgeA = startBrowserWorkflowBridge({ port: 3001, host: "127.0.0.1" });
  await bridgeA.ready;
  closers.push(bridgeA.close);
}, 60_000);

afterAll(async () => {
  if (bridgeBProcess) {
    bridgeBProcess.kill();
    bridgeBProcess = null;
  }
  for (const close of closers.splice(0).reverse()) await close();
});

test(
  "LIVE game transfer: taught on agent A's bridge, executed by agent B's separate process",
  { timeout: 120_000 },
  async () => {
    // --- AGENT A: attach, record the human walk, stop, export. ---
    const attachA = await bridgeCall(3001, "synthi_attach_substrate", {
      substrate_kind: "game",
      consent: {
        subject: "player",
        realm: { realm_kind: "arena", realm_id: "live-arena" },
        allow: ["observe", "record", "act"],
      },
    });
    expect(attachA.session_id).toBeTruthy();

    await bridgeCall(3001, "synthi_begin_teach", { session_id: attachA.session_id });

    // The HUMAN performs the walk through A's teach channel — each action
    // goes through A's actor and is journaled into A's recorder.
    const walked = [
      { move: { dx: 16, dy: 0 } },
      { move: { dx: 16, dy: 0 } },
      { move: { dx: 0, dy: 24 } },
      { move: { dx: -8, dy: 8 } },
    ];
    for (const action of walked) {
      const performed = await bridgeCall(3001, "synthi_perform_action", {
        session_id: attachA.session_id,
        action,
      });
      expect(performed.ok).toBe(true);
    }

    // STOP -> contract compiles from the recording.
    const taught = await bridgeCall(3001, "synthi_end_teach", {
      session_id: attachA.session_id,
      intent: "walk right-right-down-diagonal",
      changed_values: [
        { path: "player.position", semantic_class: "", after: "moved", changed_at_tick: 4 },
      ],
      control_diffs: [{ source_id: "ctrl", changed: [] }],
    });
    expect(taught.contract_id).toBeTruthy();

    const exported = await bridgeCall(3001, "synthi_export_skill", {
      competency_id: taught.contract_id,
    });
    expect(exported.skill_format).toBe("synthi.skill.v1");
    expect(Array.isArray(exported.steps)).toBe(true);
    expect((exported.steps as unknown[]).length).toBe(4);

    // Persist the skill artifact exactly as the panel would save it.
    writeFileSync("C:/Users/dev/Downloads/synthi-test/corpus/game/skill-transfer.json", JSON.stringify(exported, null, 1));
    console.log("SKILL FILE WRITTEN with", (exported.steps as unknown[]).length, "steps");

    // Position after A's walk: +24 x, +32 y total.
    expect(px).toBe(320 + 24);
    expect(py).toBe(240 + 32);

    // --- AGENT B: separate OS process, own bridge, imports & executes. ---
    // Governance: importing makes the skill KNOWN; running requires a
    // license scoped to B's own arena. B's deployment seeds its license
    // file at startup (E2 supervised entry level).
    const licenseFile = "C:/Users/dev/Downloads/synthi-test/corpus/game/b_licenses.json";
    writeFileSync(
      licenseFile,
      JSON.stringify([
        {
          license_id: "lic-b-arena",
          competency_id: exported.skill_id,
          substrate_scope: ["game"],
          realm_scopes: [{ realm_kind: "arena", realm_id: "b-arena" }],
          entrustment: "E2_supervised",
          issued_at_ms: 0,
          expires_at_ms: Number.MAX_SAFE_INTEGER,
        },
      ]),
    );

    const pkgRoot = "C:/Users/dev/Downloads/synthi-test/synthi-ide";
    bridgeBProcess = spawn(
      "npx",
      ["tsx", "mcp/synthi-mcp/scripts/bridge_agent.mts", "3002", gameUrl, licenseFile],
      {
        cwd: pkgRoot,
        stdio: "pipe",
        shell: true,
      },
    );
    await new Promise<void>((resolveUp) => {
      const poll = async () => {
        try {
          const res = await fetch("http://127.0.0.1:3002/healthz");
          if (res.ok) return resolveUp();
        } catch {}
        setTimeout(poll, 400);
      };
      poll();
    });

    const imported = await bridgeCall(3002, "synthi_import_skill", { skill: exported });
    expect(imported.runnable).toBe(true);

    const attachB = await bridgeCall(3002, "synthi_attach_substrate", {
      substrate_kind: "game",
      consent: {
        subject: "agent-b",
        realm: { realm_kind: "arena", realm_id: "b-arena" },
        allow: ["observe", "act"],
      },
    });
    expect(attachB.session_id).toBeTruthy();

    const run = await bridgeCall(3002, "synthi_run_workflow", {
      competency_id: imported.imported_as,
      session_id: attachB.session_id,
      mode: "fresh_state",
      required_level: "E2_supervised",
    });
    expect(run.ok, `agent B execution failed: ${JSON.stringify(run).slice(0, 200)}`).toBe(true);

    // THE WORLD PROVES IT: B's four moves moved the player again
    // (+24 x, +32 y), so the authoritative position is now double-walked.
    expect(px).toBe(320 + 48);
    expect(py).toBe(240 + 64);
    console.log(`WORLD STATE PROVES TRANSFER: player now at (${px}, ${py})`);
  },
);

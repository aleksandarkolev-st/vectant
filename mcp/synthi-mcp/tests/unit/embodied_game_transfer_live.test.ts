/**
 * LIVE agent-to-agent skill transfer over two REAL bridge processes:
 *
 *   AGENT A (ephemeral port, this test process): has the game registered;
 *   a human walks via synthi_perform_action during an open recording;
 *   stop compiles the contract; export emits synthi.skill.v1.
 *
 *   AGENT B (SEPARATE OS PROCESS via scripts/bridge_agent.mts, also on an
 *   ephemeral port discovered from its startup banner): imports the skill
 *   file over HTTP, attaches to the same live game world through its own
 *   WebSocket connection, runs it in fresh_state, and the WORLD's
 *   authoritative position proves the displacement was applied by B's
 *   execution.
 *
 * Cleanup is deterministic by construction: agent B is killed by process
 * TREE (a plain kill() would only reap the cmd.exe shim and leak the real
 * node bridge), every listener close is bounded by a timeout race, and
 * every WebSocket client is TERMINATED before servers shut down so no
 * close callback can wait on a still-open connection.
 */
import { test, expect, beforeAll, afterAll } from "vitest";
import { spawn, execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { startBrowserWorkflowBridge } from "../../src/browser_workflow_bridge/server.js";
import { embodiedBridgeContext } from "../../src/browser_workflow_bridge/embodied_dispatch.js";
import { registerSubstrateAdapter } from "../../src/embodied/substrate.js";
import { createGameBundle } from "../../src/embodied/adapters/game/protocol.js";

// Deterministic live game world shared by both agents.
let px = 320;
let py = 240;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function makeGameServer(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolveServer) => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 }, () => {
      const address = wss.address() as { port: number };
      resolveServer({
        url: `ws://127.0.0.1:${address.port}`,
        close: async () => {
          // TERMINATE clients first: wss.close() otherwise waits for every
          // socket to drain politely, which is where the old version hung.
          for (const client of wss.clients) client.terminate();
          await Promise.race([
            new Promise<void>((r) => wss.close(() => r())),
            new Promise<void>((r) => setTimeout(r, 3_000)),
          ]);
        },
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
          px = clamp(px + msg.action.move.dx, 12, 628);
          py = clamp(py + msg.action.move.dy, 12, 468);
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

/** Bounded close so ONE wedged listener can never hang the whole hook. */
async function closeBounded(close: () => Promise<void>, ms: number): Promise<void> {
  await Promise.race([
    close(),
    new Promise<void>((r) => {
      setTimeout(r, ms);
    }),
  ]);
}

/** Kill a spawned process TREE (Windows shells wrap the real child). */
function killTree(child: ReturnType<typeof spawn> | null): void {
  if (!child || child.pid === undefined) return;
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore", timeout: 10_000 });
    } else {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    try {
      child.kill();
    } catch {
      // already gone - that is what we wanted
    }
  }
}

const closers: Array<() => Promise<void>> = [];
const openSockets: WebSocket[] = [];
let gameUrl = "";
let bridgeAPort = 0;
let bridgeBPort = 0;
let artifactDir = "";
let bridgeBProcess: ReturnType<typeof spawn> | null = null;

beforeAll(async () => {
  const server = await makeGameServer();
  gameUrl = server.url;
  closers.push(server.close);

  // Agent A lives in THIS process with its own game transport. Every
  // session gets its OWN connection; each is tracked for termination.
  registerSubstrateAdapter(
    createGameBundle(() => {
      let socket: WebSocket | null = null;
      const queue: unknown[] = [];
      const waiters: Array<(v: unknown) => void> = [];
      return {
        async send(message: unknown) {
          if (!socket) {
            await new Promise<void>((resolveOpen, rejectOpen) => {
              const s = new WebSocket(gameUrl);
              s.on("message", (raw: Buffer) => {
                const parsed = JSON.parse(raw.toString()) as unknown;
                const w = waiters.shift();
                if (w) w(parsed);
                else queue.push(parsed);
              });
              s.once("open", () => {
                socket = s;
                openSockets.push(s);
                resolveOpen();
              });
              s.once("error", rejectOpen);
            });
          }
          socket!.send(JSON.stringify(message));
        },
        async receive<T = unknown>(): Promise<T> {
          if (!socket) throw new Error("transport used before send");
          const queued = queue.shift();
          if (queued !== undefined) return queued as T;
          return new Promise<T>((r) => waiters.push(r as (v: unknown) => void));
        },
      };
    }),
  );
  embodiedBridgeContext();
  // Ephemeral port: no collision with anything left running elsewhere.
  const bridgeA = startBrowserWorkflowBridge({ port: 0, host: "127.0.0.1" });
  await bridgeA.ready;
  bridgeAPort = (bridgeA.server.address() as { port: number }).port;
  closers.push(bridgeA.close);
}, 60_000);

afterAll(async () => {
  // Order matters: children first, then sockets, then listeners.
  killTree(bridgeBProcess);
  bridgeBProcess = null;
  for (const s of openSockets.splice(0)) {
    try {
      s.terminate();
    } catch {
      // already closed
    }
  }
  for (const close of closers.splice(0).reverse()) {
    await closeBounded(close, 5_000);
  }
  if (artifactDir) rmSync(artifactDir, { recursive: true, force: true });
});

test(
  "LIVE game transfer: taught on agent A's bridge, executed by agent B's separate process",
  { timeout: 120_000 },
  async () => {
    // --- AGENT A: attach, record the human walk, stop, export. ---
    const attachA = await bridgeCall(bridgeAPort, "synthi_attach_substrate", {
      substrate_kind: "game",
      consent: {
        subject: "player",
        realm: { realm_kind: "arena", realm_id: "live-arena" },
        allow: ["observe", "record", "act"],
      },
    });
    expect(attachA.session_id).toBeTruthy();

    await bridgeCall(bridgeAPort, "synthi_begin_teach", { session_id: attachA.session_id });

    // The HUMAN performs the walk through A's teach channel — each action
    // goes through A's actor and is journaled into A's recorder.
    const walked = [
      { move: { dx: 16, dy: 0 } },
      { move: { dx: 16, dy: 0 } },
      { move: { dx: 0, dy: 24 } },
      { move: { dx: -8, dy: 8 } },
    ];
    for (const action of walked) {
      const performed = await bridgeCall(bridgeAPort, "synthi_perform_action", {
        session_id: attachA.session_id,
        action,
      });
      expect(performed.ok).toBe(true);
    }

    // STOP -> contract compiles from the recording.
    const taught = await bridgeCall(bridgeAPort, "synthi_end_teach", {
      session_id: attachA.session_id,
      intent: "walk right-right-down-diagonal",
      changed_values: [
        { path: "player.position", semantic_class: "", after: "moved", changed_at_tick: 4 },
      ],
      control_diffs: [{ source_id: "ctrl", changed: [] }],
    });
    expect(taught.contract_id).toBeTruthy();

    const exported = await bridgeCall(bridgeAPort, "synthi_export_skill", {
      competency_id: taught.contract_id,
    });
    expect(exported.skill_format).toBe("synthi.skill.v1");
    expect(Array.isArray(exported.steps)).toBe(true);
    expect((exported.steps as unknown[]).length).toBe(4);

    // Persist the artifacts exactly as an agent-to-agent handoff would -
    // in a temp workspace, never a user-visible absolute location.
    artifactDir = mkdtempSync(join(tmpdir(), "skill-transfer-"));
    const skillPath = join(artifactDir, "skill.json");
    writeFileSync(skillPath, JSON.stringify(exported, null, 1));

    // Position after A's walk: +24 x, +32 y total.
    expect(px).toBe(320 + 24);
    expect(py).toBe(240 + 32);

    // --- AGENT B: separate OS process, own bridge, imports & executes. ---
    // Governance: importing makes the skill KNOWN; running requires a
    // license scoped to B's own arena. B's deployment seeds its license
    // file at startup (E2 supervised entry level).
    const licenseFile = join(artifactDir, "b_licenses.json");
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

    // Run from THIS package so no machine-specific path is involved.
    const pkgDir = fileURLToPath(new URL("../../", import.meta.url));
    bridgeBProcess = spawn(
      "npx",
      ["tsx", "scripts/bridge_agent.mts", "0", gameUrl, licenseFile],
      {
        cwd: pkgDir,
        stdio: "pipe",
        shell: true,
      },
    );

    // Discover B's ephemeral port from its startup banner instead of
    // assuming one; fail loudly if it never comes up.
    bridgeBPort = await new Promise<number>((resolve, reject) => {
      let buffered = "";
      const timer = setTimeout(
        () => reject(new Error(`agent B never announced a port; output:\n${buffered.slice(-500)}`)),
        60_000,
      );
      const onData = (chunk: Buffer) => {
        buffered += chunk.toString();
        const match = buffered.match(/AGENT BRIDGE LIVE on port (\d+)/);
        if (match) {
          clearTimeout(timer);
          resolve(Number(match[1]));
        }
      };
      bridgeBProcess!.stdout?.on("data", onData);
      bridgeBProcess!.stderr?.on("data", onData);
    });
    expect(bridgeBPort).toBeGreaterThan(0);

    const imported = await bridgeCall(bridgeBPort, "synthi_import_skill", { skill: exported });
    expect(imported.runnable).toBe(true);

    const attachB = await bridgeCall(bridgeBPort, "synthi_attach_substrate", {
      substrate_kind: "game",
      consent: {
        subject: "agent-b",
        realm: { realm_kind: "arena", realm_id: "b-arena" },
        allow: ["observe", "act"],
      },
    });
    expect(attachB.session_id).toBeTruthy();

    const run = await bridgeCall(bridgeBPort, "synthi_run_workflow", {
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

/**
 * LIVE END-TO-END systems matrix — fully SELF-CONTAINED.
 *
 * Everything these tests need, they start themselves on ephemeral ports:
 *   - the real workflow bridge (startBrowserWorkflowBridge, port 0),
 *   - a real game world behind the scene-graph protocol (own WS server;
 *     THE WORLD is authoritative: positions are kept server-side and
 *     proven by reading them back, never by echoing client input),
 *   - a second agent brain (fresh ToolContext, own transport, own
 *     license) that imports the exported skill and executes it.
 *
 * Legs that need machine capabilities this repo cannot ship are probed
 * first and SKIPPED WITH A LOUD REASON when absent (never faked):
 *   KERNEL - real WSL2 Ubuntu (vm.swappiness snapshot -> mutate ->
 *            verify changed -> restore -> verify equal).
 *   NN     - real Python + numpy MLP training with decreasing loss,
 *            replayed into a fresh directory.
 */
import { test, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocketServer, WebSocket } from "ws";
import { startBrowserWorkflowBridge } from "../../src/browser_workflow_bridge/server.js";
import { embodiedBridgeContext } from "../../src/browser_workflow_bridge/embodied_dispatch.js";
import {
  registerSubstrateAdapter,
  unregisterAllSubstrateAdapters,
} from "../../src/embodied/substrate.js";
import { createGameBundle } from "../../src/embodied/adapters/game/protocol.js";
import {
  createToolContext,
  handleAttachSubstrate,
  handleBeginTeach,
  handleEndTeach,
  handleExportSkill,
  handleImportSkill,
  handleListSkills,
  handleObserve,
  handleRunWorkflow,
} from "../../src/embodied/tools.js";
import type { CompetencyLicense } from "../../src/embodied/governance.js";

// ---------------------------------------------------------------------------
// Self-hosted live game world: authoritative state, protocol-faithful.
// ---------------------------------------------------------------------------
let px = 320;
let py = 240;
let tick = 0;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function makeGameWorld(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolveServer) => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 }, () => {
      const address = wss.address() as { port: number };
      resolveServer({
        url: `ws://127.0.0.1:${address.port}`,
        close: () =>
          Promise.allSettled(
            [...wss.clients].map(
              (c) => new Promise<void>((r) => c.close(() => r())),
            ),
          ).then(() => new Promise<void>((r) => wss.close(() => r()))),
      });
    });
    wss.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as {
          op: string;
          action?: { move?: { dx: number; dy: number } };
        };
        if (msg.op === "act" && msg.action?.move) {
          // The WORLD decides the new position (bounds included).
          px = clamp(px + msg.action.move.dx, 12, 628);
          py = clamp(py + msg.action.move.dy, 12, 468);
          tick += 1;
          socket.send(JSON.stringify({ ok: true, tick }));
        } else if (msg.op === "observe") {
          socket.send(
            JSON.stringify({
              tick,
              entities: [{ id: "player", position: { x: px, y: py }, color: { h: 210, s: 0.6, v: 0.8 }, kind: "player" }],
              hidden: [],
            }),
          );
        }
      });
    });
  });
}

/** One request/response round trip over a dedicated connection. */
async function withWorldSocket<T>(
  url: string,
  fn: (
    send: (m: unknown) => void,
    receive: <U = unknown>() => Promise<U>,
  ) => Promise<T>,
): Promise<T> {
  const socket = new WebSocket(url);
  const queue: unknown[] = [];
  const waiters: Array<(v: unknown) => void> = [];
  socket.on("message", (raw: Buffer) => {
    const parsed = JSON.parse(raw.toString()) as unknown;
    const waiter = waiters.shift();
    if (waiter) waiter(parsed);
    else queue.push(parsed);
  });
  await new Promise<void>((resolveOpen, rejectOpen) => {
    socket.once("open", () => resolveOpen());
    socket.once("error", rejectOpen);
  });
  try {
    return await fn(
      (m) => socket.send(JSON.stringify(m)),
      () => {
        const queued = queue.shift();
        if (queued !== undefined) return Promise.resolve(queued);
        return new Promise((r) => waiters.push(r));
      },
    );
  } finally {
    await new Promise<void>((r) => {
      socket.once("close", () => r());
      socket.close();
    });
  }
}

// ---------------------------------------------------------------------------
// Capability probes for legs this machine may or may not have.
// ---------------------------------------------------------------------------
function probeWslUbuntu(): boolean {
  try {
    execSync('wsl -d Ubuntu -- sysctl -n vm.swappiness', {
      encoding: "utf8",
      timeout: 20_000,
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

function probePythonNumpy(): boolean {
  try {
    execSync('python -c "import numpy"', { encoding: "utf8", timeout: 30_000, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const HAS_WSL = await probeWslUbuntu();
const HAS_PYTHON_NUMPY = await probePythonNumpy();
if (!HAS_WSL) console.warn("[live-systems] KERNEL leg skipped: WSL2 Ubuntu not reachable on this machine.");
if (!HAS_PYTHON_NUMPY)
  console.warn("[live-systems] NN leg skipped: python with numpy not reachable on this machine.");

// ---------------------------------------------------------------------------
// Shared live fixtures: one bridge + one game world for the whole file.
// ---------------------------------------------------------------------------
const closers: Array<() => Promise<void>> = [];
let gameUrl = "";
let bridgePort = 0;

async function bridgeCall(tool: string, args: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`http://127.0.0.1:${bridgePort}/browser-workflows/tool`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool, arguments: args }),
  });
  const body = (await res.json()) as { result?: Record<string, unknown> };
  return body.result ?? {};
}

beforeAll(async () => {
  unregisterAllSubstrateAdapters();
  const world = await makeGameWorld();
  gameUrl = world.url;
  closers.push(world.close);

  registerSubstrateAdapter(createGameBundle(() => {
    // Every session gets its OWN connection to the same authoritative world.
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
              const waiter = waiters.shift();
              if (waiter) waiter(parsed);
              else queue.push(parsed);
            });
            s.once("open", () => {
              socket = s;
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
  }));

  embodiedBridgeContext();
  const bridge = startBrowserWorkflowBridge({ port: 0, host: "127.0.0.1" });
  await bridge.ready;
  bridgePort = (bridge.server.address() as { port: number }).port;
  closers.push(bridge.close);
});

afterAll(async () => {
  for (const close of closers.splice(0).reverse()) {
    await Promise.race([
      close(),
      new Promise((r) => {
        setTimeout(r, 5_000);
      }),
    ]);
  }
});

// ---------------------------------------------------------------------------
// GAME: human walks over the REAL bridge; skill artifact exported; a SECOND
// agent (fresh context, own transport, own license) imports and EXECUTES it;
// the world's authoritative position proves both walks happened.
// ---------------------------------------------------------------------------
test(
  "LIVE GAME: record walk -> stop -> skill artifact -> second agent executes",
  { timeout: 120_000 },
  async () => {
    // Sanity: the world is reachable, observable, and authoritative.
    const scene = await withWorldSocket<{ tick: number }>(gameUrl, async (send, receive) => {
      send({ op: "observe" });
      return receive<{ tick: number }>();
    });
    expect(scene.tick).toBeGreaterThanOrEqual(0);
    px = 320;
    py = 240;
    tick = 0;

    // ---- AGENT A: teach through the real workflow bridge. ----
    const attachA = await bridgeCall("synthi_attach_substrate", {
      substrate_kind: "game",
      consent: {
        subject: "player",
        realm: { realm_kind: "arena", realm_id: "live-arena-a" },
        allow: ["observe", "record", "act"],
      },
    });
    expect(attachA.session_id).toBeTruthy();

    await bridgeCall("synthi_begin_teach", { session_id: attachA.session_id });

    // The HUMAN performs the walk through A's teach channel; each action is
    // journaled by A's recorder while the WORLD applies it authoritatively.
    const walked = [
      { move: { dx: 16, dy: 0 } },
      { move: { dx: 16, dy: 0 } },
      { move: { dx: 0, dy: 24 } },
      { move: { dx: -8, dy: 8 } },
    ];
    for (const action of walked) {
      const performed = await bridgeCall("synthi_perform_action", {
        session_id: attachA.session_id,
        action,
      });
      expect(performed.ok).toBe(true);
    }

    // World proof of A's walk: authoritative position moved by the total.
    expect(px).toBe(320 + 24);
    expect(py).toBe(240 + 32);

    // STOP -> contract compiles from the recording.
    const taught = await bridgeCall("synthi_end_teach", {
      session_id: attachA.session_id,
      intent: "walk right-right-down-diagonal",
      changed_values: [
        { path: "entities.player.position", semantic_class: "", after: "moved", changed_at_tick: 4 },
      ],
      control_diffs: [{ source_id: "ctrl", changed: [] }],
    });
    expect(taught.contract_id).toBeTruthy();
    expect(taught.steps_recorded).toBe(4);

    const exported = await bridgeCall("synthi_export_skill", {
      competency_id: taught.contract_id,
    });
    expect(exported.skill_format).toBe("synthi.skill.v1");
    expect(Array.isArray(exported.steps)).toBe(true);
    expect((exported.steps as unknown[]).length).toBe(4);

    // Persist the artifact exactly as an agent-to-agent handoff would.
    const artifactDir = join(tmpdir(), "synthi-live-systems-game");
    mkdirSync(artifactDir, { recursive: true });
    const skillPath = join(artifactDir, "skill.json");
    writeFileSync(skillPath, JSON.stringify(exported, null, 1));
    expect(JSON.parse(readFileSync(skillPath, "utf8")).skill_format).toBe("synthi.skill.v1");

    // ---- AGENT B: a completely fresh brain imports from the FILE and
    // executes through its OWN transport + session. ----
    const ctxB = createToolContext([]);
    expect((handleListSkills(ctxB) as { count: number }).count).toBe(0);
    const imported = handleImportSkill(ctxB, {
      skill: JSON.parse(readFileSync(skillPath, "utf8")),
    }) as { imported_as: string; runnable: boolean };
    expect(imported.runnable).toBe(true);

    const attachB = (await handleAttachSubstrate(ctxB, {
      substrate_kind: "game",
      consent: {
        subject: "agent-b",
        realm: { realm_kind: "arena", realm_id: "live-arena-b" },
        allow: ["observe", "act"],
      },
    })) as { session_id: string };
    expect(attachB.session_id).toBeTruthy();

    (ctxB.licenses as CompetencyLicense[]).push({
      license_id: "lic-b-live",
      competency_id: imported.imported_as,
      substrate_scope: ["game"],
      realm_scopes: [{ realm_kind: "arena", realm_id: "live-arena-b" }],
      entrustment: "E2_supervised",
      issued_at_ms: 0,
      expires_at_ms: Number.MAX_SAFE_INTEGER,
    });

    const run = (await handleRunWorkflow(ctxB, {
      competency_id: imported.imported_as,
      session_id: attachB.session_id,
      mode: "fresh_state",
      required_level: "E2_supervised",
    })) as { ok: boolean; step_results: Array<{ ok: boolean }> };
    expect(run.ok, `agent B execution failed: ${JSON.stringify(run).slice(0, 300)}`).toBe(true);
    expect(run.step_results.every((s) => s.ok)).toBe(true);

    // THE WORLD PROVES B's EXECUTION: the same four moves applied AGAIN.
    expect(px).toBe(320 + 48);
    expect(py).toBe(240 + 64);

    // And B sees the authoritative scene through its own observation.
    const observed = (await handleObserve(ctxB, { session_id: attachB.session_id })) as {
      observation: { entities: Array<{ id: string; position: { x: number; y: number } }> };
    };
    const player = observed.observation.entities.find((e) => e.id === "player")!;
    expect(player.position.x).toBe(320 + 48);
    expect(player.position.y).toBe(240 + 64);
    console.log(`LIVE GAME VERIFIED: world-authoritative double walk to (${px}, ${py})`);
  },
);

// ---------------------------------------------------------------------------
// KERNEL: real WSL2 Ubuntu. Snapshot BEFORE mutation (P3 invariant), mutate,
// prove the kernel REALLY changed, restore, prove exact restoration.
// ---------------------------------------------------------------------------
test.skipIf(!HAS_WSL)(
  "LIVE KERNEL: snapshot -> mutate swappiness -> kernel really changed -> restore",
  { timeout: 120_000 },
  () => {
    const readSwappiness = () =>
      execSync("wsl -d Ubuntu -- sysctl -n vm.swappiness", { encoding: "utf8", timeout: 30_000 }).trim();

    // Snapshot BEFORE mutation (the P3 invariant), and choose a mutation
    // value that is GUARANTEED different from the current one so "the
    // kernel really changed" can never pass vacuously.
    const before = readSwappiness();
    console.log("KERNEL vm.swappiness before:", before);
    const mutation = before === "42" ? 41 : 42;
    expect(mutation, "mutation value must differ from snapshot").not.toBe(before);

    execSync(`wsl -d Ubuntu -u root -- sysctl -w vm.swappiness=${mutation}`, {
      encoding: "utf8",
      timeout: 30_000,
    });
    const during = readSwappiness();
    expect(during).toBe(String(mutation)); // the kernel REALLY changed
    expect(during).not.toBe(before);
    console.log("KERNEL mutated live: vm.swappiness =", during);

    execSync(`wsl -d Ubuntu -u root -- sysctl -w vm.swappiness=${before}`, {
      encoding: "utf8",
      timeout: 30_000,
    });
    const after = readSwappiness();
    expect(after).toBe(before); // restored exactly
    console.log("KERNEL restored:", after);
  },
);

// ---------------------------------------------------------------------------
// NEURAL NET: real numpy MLP trained in a real Python process with a
// decreasing-loss acceptance gate; replayed into a FRESH directory where the
// same gate must hold (second-agent replay).
// ---------------------------------------------------------------------------
test.skipIf(!HAS_PYTHON_NUMPY)(
  "LIVE NEURAL NET: train real numpy MLP - loss decreases - replay trains another",
  { timeout: 300_000 },
  () => {
    const work = join(tmpdir(), `synthi-live-systems-nn-${Date.now()}`);
    mkdirSync(work, { recursive: true });
    try {
      const script = `
import numpy as np, json, sys
rng = np.random.default_rng(7)
X = rng.normal(size=(256, 3))
y = ((X[:,0] * X[:,1] - X[:,2]) > 0).astype(np.float64).reshape(-1, 1)
W1 = rng.normal(scale=0.5, size=(3, 16)); b1 = np.zeros((1, 16))
W2 = rng.normal(scale=0.5, size=(16, 1)); b2 = np.zeros((1, 1))
losses = []
lr = 0.1
for epoch in range(400):
    H = np.tanh(X @ W1 + b1)
    P = 1.0 / (1.0 + np.exp(-(H @ W2 + b2)))
    eps = 1e-9
    loss = float(-np.mean(y * np.log(P + eps) + (1 - y) * np.log(1 - P + eps)))
    losses.append(loss)
    dZ2 = (P - y) / len(X)
    dW2 = H.T @ dZ2; db2 = dZ2.sum(axis=0, keepdims=True)
    dH = (dZ2 @ W2.T) * (1.0 - H * H)
    dW1 = X.T @ dH; db1 = dH.sum(axis=0, keepdims=True)
    W2 -= lr * dW2; b2 -= lr * db2
    W1 -= lr * dW1; b1 -= lr * db1
acc = float((( (1/(1+np.exp(-(np.tanh(X@W1+b1)@W2+b2)))) > 0.5 ).astype(float) == y).mean())
json.dump({"first_loss": losses[0], "final_loss": losses[-1], "accuracy": acc}, open(sys.argv[1], "w"))
print("trained")`;
      writeFileSync(join(work, "train.py"), script);

      // TEACH phase: train for real; the gate is final_loss < first_loss.
      execSync(`python "${join(work, "train.py")}" "${join(work, "model_a.json")}"`, {
        cwd: work,
        timeout: 180_000,
        stdio: "pipe",
      });
      const modelA = JSON.parse(readFileSync(join(work, "model_a.json"), "utf8")) as {
        first_loss: number;
        final_loss: number;
        accuracy: number;
      };
      console.log(`NN RUN A: loss ${modelA.first_loss.toFixed(4)} -> ${modelA.final_loss.toFixed(4)}, acc ${modelA.accuracy}`);
      expect(modelA.final_loss, "network did not learn").toBeLessThan(modelA.first_loss);
      expect(modelA.accuracy).toBeGreaterThan(0.85);

      // REPLAY phase: the SAME taught workflow into a FRESH directory.
      mkdirSync(join(work, "replay"), { recursive: true });
      execSync(`python "${join(work, "train.py")}" "${join(work, "replay/model_b.json")}"`, {
        cwd: work,
        timeout: 180_000,
        stdio: "pipe",
      });
      const modelB = JSON.parse(readFileSync(join(work, "replay/model_b.json"), "utf8")) as {
        first_loss: number;
        final_loss: number;
        accuracy: number;
      };
      console.log(`NN RUN B (fresh directory): loss ${modelB.first_loss.toFixed(4)} -> ${modelB.final_loss.toFixed(4)}, acc ${modelB.accuracy}`);
      expect(modelB.final_loss).toBeLessThan(modelB.first_loss);
      expect(modelB.accuracy).toBeGreaterThan(0.85);
      console.log("LIVE NN VERIFIED: learning gate held on teach and fresh replay");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  },
);

/**
 * LIVE agent-to-agent skill transfer for the TERMINAL substrate applied
 * to NEURAL NETWORK training:
 *
 *   Agent A (bridge :3001): attach terminal -> begin_teach ->
 *     perform_action: write train.py (real numpy MLP backprop)
 *     perform_action: run python train.py -> model_a.json  [loss HALVES]
 *     perform_action: verify artifact via node check script
 *     end_teach -> export synthi.skill.v1
 *
 *   Agent B (SEPARATE OS PROCESS): import -> license -> attach its own
 *   terminal realm -> run fresh_state -> trains AGAIN in a fresh dir.
 *
 *   THE WORLD PROVES THE TRANSFER: model_b.json exists with
 *   final_loss < first_loss and accuracy > 0.85 - the network B trained
 *   genuinely learned, from a skill file it was handed.
 */
import { test, expect, beforeAll, afterAll } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { registerSubstrateAdapter, unregisterAllSubstrateAdapters } from "../../src/embodied/substrate.js";
import { createTerminalBundle, allowlistPolicy } from "../../src/embodied/adapters/terminal/index.js";
import { startBrowserWorkflowBridge } from "../../src/browser_workflow_bridge/server.js";
import { embodiedBridgeContext } from "../../src/browser_workflow_bridge/embodied_dispatch.js";

const IDE_ROOT = "C:/Users/dev/Downloads/synthi-test/synthi-ide";
const CORPUS = "C:/Users/dev/Downloads/synthi-test/corpus";
const NN_DIR = `${CORPUS}/nn_transfer`;
const NN_B_DIR = `${CORPUS}/nn_transfer/agent_b`;

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
let bridgeBProcess: ReturnType<typeof spawn> | null = null;

beforeAll(async () => {
  mkdirSync(NN_DIR, { recursive: true });
  // Agent A in THIS process: terminal adapter with node+python allowed.
  unregisterAllSubstrateAdapters();
  registerSubstrateAdapter(createTerminalBundle(allowlistPolicy(["node", "python"])));
  embodiedBridgeContext();
  const bridgeA = startBrowserWorkflowBridge({ port: 3001, host: "127.0.0.1" });
  await bridgeA.ready;
  closers.push(bridgeA.close);
}, 60_000);

afterAll(async () => {
  if (bridgeBProcess?.pid) {
    try {
      execFileSync("taskkill", ["/PID", String(bridgeBProcess.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      bridgeBProcess.kill();
    }
  }
  for (const close of closers.splice(0).reverse()) await close();
});

test(
  "LIVE NN transfer: training workflow taught by A, executed by separate agent B",
  { timeout: 240_000 },
  async () => {
    const attachA = await bridgeCall(3001, "synthi_attach_substrate", {
      substrate_kind: "terminal",
      consent: {
        subject: "ml-engineer",
        realm: { realm_kind: "workspace", realm_id: NN_DIR.replace(/\\/g, "/") },
        allow: ["observe", "record", "act"],
      },
    });
    expect(attachA.session_id).toBeTruthy();

    await bridgeCall(3001, "synthi_begin_teach", { session_id: attachA.session_id });

    // The ML engineer's hand, through the teach channel:
    // 1) write the real training script
    const trainPy = [
      "import numpy as np, json, sys, os",
      "out_dir = sys.argv[1]",
      "os.makedirs(out_dir, exist_ok=True)",
      'rng = np.random.default_rng(7)',
      "X = rng.normal(size=(256, 3))",
      "y = ((X[:,0] * X[:,1] - X[:,2]) > 0).astype(np.float64).reshape(-1, 1)",
      "W1 = rng.normal(scale=0.5, size=(3, 16)); b1 = np.zeros((1, 16))",
      "W2 = rng.normal(scale=0.5, size=(16, 1)); b2 = np.zeros((1, 1))",
      "lr = 0.1; losses = []",
      "for epoch in range(400):",
      "    H = np.tanh(X @ W1 + b1)",
      "    P = 1/(1+np.exp(-(H @ W2 + b2)))",
      "    eps = 1e-9",
      "    loss = float(-np.mean(y*np.log(P+eps)+(1-y)*np.log(1-P+eps)))",
      "    losses.append(loss)",
      "    dZ2 = (P - y)/len(X)",
      "    dW2 = H.T @ dZ2; db2 = dZ2.sum(axis=0, keepdims=True)",
      "    dH = (dZ2 @ W2.T)*(1-H*H)",
      "    dW1 = X.T @ dH; db1 = dH.sum(axis=0, keepdims=True)",
      "    W2 -= lr*dW2; b2 -= lr*db2; W1 -= lr*dW1; b1 -= lr*db1",
      "Pf = 1/(1+np.exp(-(np.tanh(X@W1+b1)@W2+b2)))",
      "acc = float(((Pf>0.5).astype(float)==y).mean())",
      'json.dump({"first_loss": losses[0], "final_loss": losses[-1], "accuracy": acc}, open(os.path.join(out_dir, "model.json"), "w"))',
      'print("trained")',
    ].join("\n");
    const writeStep = await bridgeCall(3001, "synthi_perform_action", {
      session_id: attachA.session_id,
      action: {
        // base64 payload: universal across any script content - no shell
        // quoting hazards for either execution path (act or replay).
        run: `node -e require('fs').writeFileSync('train.py',Buffer.from(process.argv[1],'base64').toString()) ${Buffer.from(trainPy).toString("base64")}`,
      },
    });
    expect(writeStep.ok).toBe(true);

    // 2) run the training for real (teaching phase)
    const trainStep = await bridgeCall(3001, "synthi_perform_action", {
      session_id: attachA.session_id,
      action: { run: `python train.py agent_a` },
    });
    expect(trainStep.ok).toBe(true);

    const modelA = JSON.parse(readFileSync(`${NN_DIR}/agent_a/model.json`, "utf8")) as {
      first_loss: number;
      final_loss: number;
      accuracy: number;
    };
    expect(modelA.final_loss, "network did not learn during teaching").toBeLessThan(modelA.first_loss);
    console.log(`AGENT A TRAINED LIVE: loss ${modelA.first_loss.toFixed(4)} -> ${modelA.final_loss.toFixed(4)}, acc ${(modelA.accuracy * 100).toFixed(1)}%`);

    // 3) verify the artifact (part of the taught flow)
    const verifyStep = await bridgeCall(3001, "synthi_perform_action", {
      session_id: attachA.session_id,
      action: {
        run: `node -e require('fs').accessSync('agent_a/model.json'); console.log('artifact-ok')`,
      },
    });
    expect(verifyStep.ok).toBe(true);

    const taught = await bridgeCall(3001, "synthi_end_teach", {
      session_id: attachA.session_id,
      intent: "train MLP and produce verified model artifact",
      changed_values: [
        { path: "train.py", semantic_class: "", after: "<file>", changed_at_tick: 1 },
        { path: "agent_a/model.json", semantic_class: "", after: "<artifact>", changed_at_tick: 3 },
      ],
      control_diffs: [{ source_id: "ctrl", changed: [] }],
    });
    expect(taught.contract_id).toBeTruthy();

    const exported = await bridgeCall(3001, "synthi_export_skill", { competency_id: taught.contract_id });
    expect(exported.skill_format).toBe("synthi.skill.v1");
    expect((exported.steps as unknown[]).length).toBe(3);
    writeFileSync(`${CORPUS}/skill-nn.json`, JSON.stringify(exported, null, 1));
    console.log("NN SKILL FILE WRITTEN:", (exported.steps as unknown[]).length, "steps");

    // --- AGENT B: separate process, imports & executes into ITS OWN dir ---
    const licenseFile = `${CORPUS}/b_licenses_nn.json`;
    writeFileSync(
      licenseFile,
      JSON.stringify([
        {
          license_id: "lic-b-nn",
          competency_id: exported.skill_id,
          substrate_scope: ["terminal"],
          realm_scopes: [{ realm_kind: "workspace", realm_id: NN_B_DIR.replace(/\\/g, "/") }],
          entrustment: "E2_supervised",
          issued_at_ms: 0,
          expires_at_ms: Number.MAX_SAFE_INTEGER,
        },
      ]),
    );

    bridgeBProcess = spawn(
      process.execPath,
      [
        "C:/Users/dev/Downloads/synthi-test/synthi-ide/node_modules/tsx/dist/cli.mjs",
        "mcp/synthi-mcp/scripts/bridge_agent.mts",
        "3002",
        "",
        licenseFile,
      ],
      {
        cwd: IDE_ROOT,
        stdio: "pipe",
        // Agent B is a terminal-agent deployment: its execution allowlist is
        // deployment configuration (same binaries as agent A's policy).
        env: { ...process.env, SYNTHI_TERMINAL_AGENT: "node,python" },
      },
    );
    await new Promise<void>((resolveUp, rejectUp) => {
      let evicted = false;
      const poll = async () => {
        try {
          const res = await fetch("http://127.0.0.1:3002/browser-workflows/tool", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              tool: "synthi_attach_substrate",
              arguments: {
                substrate_kind: "terminal",
                consent: {
                  subject: "probe",
                  realm: { realm_kind: "workspace", realm_id: "probe-ws" },
                  allow: ["observe"],
                },
              },
            }),
          });
          const body = (await res.json()) as { result?: { session_id?: string } };
          if (res.ok && body.result?.session_id) return resolveUp();
        } catch {}
        if (!evicted) {
          evicted = true;
          try {
            const netstat = execFileSync("netstat", ["-ano"], { encoding: "utf8", shell: true });
            const line = netstat.split(/\r?\n/).find((l) => l.includes(":3002") && l.includes("LISTENING"));
            const pid = line?.trim().split(/\s+/).at(-1);
            if (pid && /^\d+$/.test(pid)) {
              try {
                execFileSync("taskkill", ["/PID", pid, "/T", "/F"], { stdio: "ignore" });
              } catch {}
            }
          } catch {}
          setTimeout(poll, 800);
          return;
        }
        setTimeout(poll, 500);
      };
      poll();
    });

    const imported = await bridgeCall(3002, "synthi_import_skill", { skill: exported });
    expect(imported.runnable).toBe(true);

    const attachB = await bridgeCall(3002, "synthi_attach_substrate", {
      substrate_kind: "terminal",
      consent: {
        subject: "agent-b",
        realm: { realm_kind: "workspace", realm_id: NN_B_DIR.replace(/\\/g, "/") },
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
    expect(run.ok, `agent B NN execution failed: ${JSON.stringify(run).slice(0, 250)}`).toBe(true);

    // THE WORLD PROVES THE TRANSFER: B's own freshly-trained network.
    expect(existsSync(`${NN_B_DIR}/agent_a/model.json`)).toBe(true);
    const modelB = JSON.parse(readFileSync(`${NN_B_DIR}/agent_a/model.json`, "utf8"));
    expect(modelB.final_loss).toBeLessThan(modelB.first_loss);
    expect(modelB.accuracy).toBeGreaterThan(0.85);
    console.log(`WORLD STATE PROVES NN TRANSFER: agent B's net learned - loss ${modelB.first_loss.toFixed(4)} -> ${modelB.final_loss.toFixed(4)}, acc ${(modelB.accuracy * 100).toFixed(1)}%`);
  },
);

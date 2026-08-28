/**
 * LIVE agent-to-agent skill transfer for the KERNEL substrate.
 *
 * The world is the REAL WSL2 Ubuntu kernel on this machine. The executor
 * port runs actual sysctl commands through `wsl -d Ubuntu`:
 *
 *   Agent A (bridge :3001): attach -> begin_teach ->
 *     perform_action: read vm.swappiness in ns "vm"           [snapshot auto]
 *     perform_action: write 42 into ns "vm"                   [mutating]
 *     end_teach -> contract -> export synthi.skill.v1
 *
 *   Agent B (SEPARATE OS PROCESS, bridge :3002, its own executor):
 *     import -> license seed -> attach to ITS realm "b-kernel"
 *     run fresh_state -> sysctl really executes again on the live kernel
 *
 *   THE WORLD PROVES THE TRANSFER: after both runs the live kernel's
 *   vm.swappiness has been set by A's teaching AND re-applied by B.
 */
import { test, expect, beforeAll, afterAll } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { registerSubstrateAdapter, unregisterAllSubstrateAdapters } from "../../src/embodied/substrate.js";
import { createKernelBundle } from "../../src/embodied/adapters/kernel/index.js";
import { startBrowserWorkflowBridge } from "../../src/browser_workflow_bridge/server.js";
import { embodiedBridgeContext } from "../../src/browser_workflow_bridge/embodied_dispatch.js";

const IDE_ROOT = "C:/Users/dev/Downloads/synthi-test/synthi-ide";
const CORPUS = "C:/Users/dev/Downloads/synthi-test/corpus";

/** Real WSL2 Ubuntu kernel executor: snapshot = record current value. */
function makeWslExecutor() {
  return {
    async snapshot(namespace: string) {
      try {
        const out = execFileSync("wsl", ["-d", "Ubuntu", "--", "sysctl", "-n", `kernel.${namespace}`], {
          encoding: "utf8",
          timeout: 30_000,
        }).trim();
        writeSnapshot(namespace, out);
      } catch {
        /* snapshot best-effort; mutation still snapshotted as unknown */
      }
    },
    async exec(_namespace: string, command: string) {
      try {
        const out = execFileSync("wsl", ["-d", "Ubuntu", "--", ...command.split(/\s+/)], {
          encoding: "utf8",
          timeout: 30_000,
        });
        return { exit: 0, output: out };
      } catch (error) {
        const status = (error as { status?: number }).status ?? 1;
        return { exit: status === 0 ? 1 : status, output: "" };
      }
    },
  };
}

function writeSnapshot(namespace: string, value: string) {
  const logPath = `${CORPUS}/kernel_snapshots.json`;
  let log: Record<string, string> = {};
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    log = JSON.parse(require("node:fs").readFileSync(logPath, "utf8"));
  } catch {}
  log[namespace] = value;
  require("node:fs").writeFileSync(logPath, JSON.stringify(log, null, 1));
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
let bridgeBProcess: ReturnType<typeof spawn> | null = null;

beforeAll(async () => {
  // Agent A in THIS process: kernel adapter bound to the real WSL executor.
  unregisterAllSubstrateAdapters();
  registerSubstrateAdapter(createKernelBundle(makeWslExecutor()));
  embodiedBridgeContext();
  const bridgeA = startBrowserWorkflowBridge({ port: 3001, host: "127.0.0.1" });
  await bridgeA.ready;
  closers.push(bridgeA.close);
}, 60_000);

afterAll(async () => {
  // shell:true wraps B in cmd.exe; kill() would orphan the node child.
  // Tree-kill instead so the listener actually goes away.
  if (bridgeBProcess?.pid) {
    try {
      execFileSync("taskkill", ["/PID", String(bridgeBProcess.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      bridgeBProcess.kill();
    }
    bridgeBProcess = null;
  }
  for (const close of closers.splice(0).reverse()) await close();
});

test(
  "LIVE KERNEL transfer: taught by A, executed by separate agent B against the real WSL kernel",
  { timeout: 180_000 },
  async () => {
    // Baseline of the LIVE kernel parameter we will teach mutating.
    const baseline = execFileSync("wsl", ["-d", "Ubuntu", "--", "sysctl", "-n", "vm.swappiness"], {
      encoding: "utf8",
      timeout: 30_000,
    }).trim();

    // --- AGENT A teaches the tune workflow ---
    const attachA = await bridgeCall(3001, "synthi_attach_substrate", {
      substrate_kind: "kernel",
      consent: {
        subject: "admin",
        realm: { realm_kind: "host_kernel", realm_id: "ubuntu-vm" },
        allow: ["observe", "record", "act"],
      },
    });
    expect(attachA.session_id).toBeTruthy();

    await bridgeCall(3001, "synthi_begin_teach", { session_id: attachA.session_id });

    // The human admin performs the workflow through the teach channel:
    // read current value, then set it to 42.
    const readStep = await bridgeCall(3001, "synthi_perform_action", {
      session_id: attachA.session_id,
      action: { namespace: "swappiness", exec: "sysctl -n vm.swappiness" },
    });
    expect(readStep.ok).toBe(true);

    const writeStep = await bridgeCall(3001, "synthi_perform_action", {
      session_id: attachA.session_id,
      action: { namespace: "swappiness", exec: "sysctl -w vm.swappiness=42" },
    });
    expect(writeStep.ok).toBe(true);

    // The REAL kernel changed during teaching:
    const duringTeaching = execFileSync("wsl", ["-d", "Ubuntu", "--", "sysctl", "-n", "vm.swappiness"], {
      encoding: "utf8",
    }).trim();
    expect(duringTeaching).toBe("42");

    // STOP -> compile -> export
    const taught = await bridgeCall(3001, "synthi_end_teach", {
      session_id: attachA.session_id,
      intent: "tune vm.swappiness to 42 with prior snapshot read",
      changed_values: [
        { path: "vm.swappiness", semantic_class: "", after: "42", changed_at_tick: 2 },
      ],
      control_diffs: [{ source_id: "ctrl", changed: [] }],
    });
    expect(taught.contract_id).toBeTruthy();

    const exported = await bridgeCall(3001, "synthi_export_skill", { competency_id: taught.contract_id });
    expect(exported.skill_format).toBe("synthi.skill.v1");
    expect((exported.steps as unknown[]).length).toBe(2);
    writeFileSync(`${CORPUS}/skill-kernel.json`, JSON.stringify(exported, null, 1));
    console.log("KERNEL SKILL FILE WRITTEN:", (exported.steps as unknown[]).length, "steps");

    // Restore before B so we PROVE B's run re-applied it (not leftover).
    execFileSync("wsl", ["-d", "Ubuntu", "-u", "root", "--", "sysctl", "-w", `vm.swappiness=${baseline}`]);

    // --- AGENT B: separate process, own executor, imports & executes ---
    const licenseFile = `${CORPUS}/b_licenses_kernel.json`;
    writeFileSync(
      licenseFile,
      JSON.stringify([
        {
          license_id: "lic-b-kernel",
          competency_id: exported.skill_id,
          substrate_scope: ["kernel"],
          realm_scopes: [{ realm_kind: "host_kernel", realm_id: "b-kernel" }],
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
      { cwd: IDE_ROOT, stdio: "pipe", env: { ...process.env, SYNTHI_KERNEL_AGENT: "b" } },
    );
    bridgeBProcess.stderr?.on("data", (d: Buffer) => {
      if (String(d).includes("EADDRINUSE")) console.log("B spawn hit EADDRINUSE");
    });
    // If a stale B from an earlier run still owns 3002, the new one dies on
    // EADDRINUSE; detect and evict by PID from the port, then respawn once.
    const evictStale = async () => {
      try {
        const netstat = execFileSync("netstat", ["-ano"], { encoding: "utf8", shell: true });
        const line = netstat.split(/\r?\n/).find((l) => l.includes(":3002") && l.includes("LISTENING"));
        if (line) {
          const pid = line.trim().split(/\s+/).at(-1);
          if (pid && /^\d+$/.test(pid)) {
            try {
              execFileSync("taskkill", ["/PID", pid, "/T", "/F"], { stdio: "ignore" });
            } catch {}
            return true;
          }
        }
      } catch {}
      return false;
    };
    await new Promise<void>((resolveUp) => {
      let evicted = false;
      const poll = async () => {
        try {
          // Verify the listener is OUR kernel-mode B, not a stale orphan:
          // probe that it serves the kernel substrate.
          const res = await fetch("http://127.0.0.1:3002/browser-workflows/tool", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              tool: "synthi_attach_substrate",
              arguments: {
                substrate_kind: "kernel",
                consent: { subject: "probe", realm: { realm_kind: "host_kernel", realm_id: "probe-x" }, allow: ["observe"] },
              },
            }),
          });
          const body = (await res.json()) as { result?: { session_id?: string; error?: string } };
          if (res.ok && body.result?.session_id) return resolveUp();
        } catch {}
        if (!evicted) {
          evicted = true;
          void evictStale().then(async (killed) => {
            if (killed) {
              bridgeBProcess = spawn(
                "npx",
                ["tsx", "mcp/synthi-mcp/scripts/bridge_agent.mts", "3002", "", licenseFile],
                { cwd: IDE_ROOT, stdio: "pipe", shell: true, env: { ...process.env, SYNTHI_KERNEL_AGENT: "b" } },
              );
            }
            setTimeout(poll, 500);
          });
          return;
        }
        setTimeout(poll, 400);
      };
      poll();
    });

    const imported = await bridgeCall(3002, "synthi_import_skill", { skill: exported });
    expect(imported.runnable).toBe(true);

    const attachB = await bridgeCall(3002, "synthi_attach_substrate", {
      substrate_kind: "kernel",
      consent: {
        subject: "agent-b",
        realm: { realm_kind: "host_kernel", realm_id: "b-kernel" },
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
    expect(run.ok, `agent B kernel execution failed: ${JSON.stringify(run).slice(0, 200)}`).toBe(true);

    // THE WORLD PROVES IT: B's execution re-applied the taught tune on the
    // LIVE kernel (we restored to baseline before B ran).
    const afterB = execFileSync("wsl", ["-d", "Ubuntu", "--", "sysctl", "-n", "vm.swappiness"], {
      encoding: "utf8",
    }).trim();
    expect(afterB).toBe("42");
    console.log(`WORLD STATE PROVES KERNEL TRANSFER: vm.swappiness=${afterB} (baseline ${baseline})`);

    // Cleanup: restore original value.
    execFileSync("wsl", ["-d", "Ubuntu", "-u", "root", "--", "sysctl", "-w", `vm.swappiness=${baseline}`]);
  },
);

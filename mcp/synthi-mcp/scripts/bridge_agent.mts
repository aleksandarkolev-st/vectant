/**
 * Standalone bridge process for AGENT B (the learner).
 * Usage: npx tsx scripts/bridge_agent.mts <port> <gameWsUrl>
 * Registers ONLY the game substrate bound to its own WS transport.
 */
import { startBrowserWorkflowBridge } from "../src/browser_workflow_bridge/server.js";
import { embodiedBridgeContext } from "../src/browser_workflow_bridge/embodied_dispatch.js";
import { registerSubstrateAdapter, unregisterAllSubstrateAdapters } from "../src/embodied/substrate.js";
import { createGameBundle } from "../src/embodied/adapters/game/protocol.js";
import { createKernelBundle } from "../src/embodied/adapters/kernel/index.js";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
// Resolve ws from THIS package upward (works wherever it is hoisted).
const wsRequire = createRequire(import.meta.url);
const WebSocket = wsRequire("ws");

const port = Number(process.argv[2] ?? 3002);
const gameUrl = process.argv[3];
// Kernel agent mode: SYNTHI_KERNEL_AGENT=1 registers the real WSL executor.
const kernelMode = process.env.SYNTHI_KERNEL_AGENT === "b";

if (kernelMode) {
  const { execFileSync } = await import("node:child_process");
  unregisterAllSubstrateAdapters();
  registerSubstrateAdapter(
    createKernelBundle({
      async snapshot(namespace: string) {
        try {
          execFileSync("wsl", ["-d", "Ubuntu", "--", "sysctl", "-n", `kernel.${namespace}`], {
            encoding: "utf8",
            timeout: 30_000,
          });
        } catch {}
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
    }),
  );
}

if (gameUrl) {
  unregisterAllSubstrateAdapters();
  let socket: import("ws").WebSocket | null = null;
  const queue: unknown[] = [];
  const waiters: Array<(v: unknown) => void> = [];
  async function ensure(): Promise<void> {
    if (socket) return;
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
  registerSubstrateAdapter(
    createGameBundle(() => ({
      async send(message: unknown) {
        await ensure();
        socket!.send(JSON.stringify(message));
      },
      async receive<T = unknown>(): Promise<T> {
        await ensure();
        const queued = queue.shift();
        if (queued !== undefined) return queued as T;
        return new Promise<T>((r) => waiters.push(r as (v: unknown) => void));
      },
    })),
  );
}

// Terminal-agent mode: SYNTHI_TERMINAL_AGENT=<comma-separated binaries>
// registers the terminal adapter with an explicit execution allowlist
// (deployment config - default remains deny-everything).
const terminalAllow = process.env.SYNTHI_TERMINAL_AGENT;
if (terminalAllow) {
  const { allowlistPolicy, createTerminalBundle } = await import("../src/embodied/adapters/terminal/index.js");
  const binaries = terminalAllow.split(",").map((b) => b.trim()).filter(Boolean);
  unregisterAllSubstrateAdapters();
  registerSubstrateAdapter(createTerminalBundle(allowlistPolicy(binaries)));
}

// Terminal adapter comes from embodiedBridgeContext when none was registered
// above; game/kernel modes above replace it entirely.
const context = embodiedBridgeContext();

// Deployments seed licenses for imported competencies from disk. The test
// writes synthi_licenses.json next to the skill before starting agent B.
const licenseFile = process.argv[4];
if (licenseFile && existsSync(licenseFile)) {
  const parsed = JSON.parse(readFileSync(licenseFile, "utf8")) as Array<unknown>;
  (context.licenses as unknown[]).push(...parsed);
  console.log(`seeded ${parsed.length} license(s)`);
}

const bridge = startBrowserWorkflowBridge({ port, host: "127.0.0.1" });
await bridge.ready;
const resolvedPort = (bridge.server.address() as { port: number }).port;
// The banner is the contract with whoever spawned us: the ACTUAL listening
// port (argv "0" means the OS picked one).
console.log(`AGENT BRIDGE LIVE on port ${resolvedPort}`);

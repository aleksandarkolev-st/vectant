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
import { createBrowserEmbodiedBundle } from "../src/browser/embodied_adapter.js";
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

// Browser-agent mode: SYNTHI_BROWSER_AGENT=cdp + SYNTHI_BROWSER_CDP_URL=<ws>
// attaches the browser substrate to an ALREADY RUNNING browser over CDP.
// Targeting rule (mirrors the teaching agent's independent implementation):
// interactables are addressed by tag + stable distinguishing attributes
// (data-*, id, name, aria-label, type). Text content is NEVER used; an
// element with no distinguishing attribute is unresolvable and the step
// fails - that refusal IS the discrimination behavior.
if (process.env.SYNTHI_BROWSER_AGENT === "cdp" && process.env.SYNTHI_BROWSER_CDP_URL) {
  const pwRequire = createRequire(import.meta.url);
  const { chromium } = pwRequire("playwright-core");
  unregisterAllSubstrateAdapters();

  const browser = await chromium.connectOverCDP(process.env.SYNTHI_BROWSER_CDP_URL);
  const context = browser.contexts()[0] ?? (await browser.newContext());

  async function currentPage() {
    let page = context.pages()[0];
    if (!page) page = await context.newPage();
    return page;
  }

  registerSubstrateAdapter(
    createBrowserEmbodiedBundle({
      observePage: async () => {
        const page = await currentPage();
        const url = page.url();
        const descriptors = await page.evaluate(() => {
          const elements = [...document.querySelectorAll("button, a")];
          return elements.map((element) => ({
            text: (element.textContent ?? "").trim(),
            attrs: Object.fromEntries(
              [...element.attributes]
                .filter((attr) => /^(data-[a-z0-9-]+|id|name|aria-label|type)$/i.test(attr.name))
                .map((attr) => [attr.name, attr.value]),
            ),
          }));
        });
        const dom: Record<string, unknown> = {};
        descriptors.forEach((entry, index) => {
          dom[`el-${index}`] = entry;
        });
        return { url, origin: new URL(url).origin, dom };
      },
      performAction: async (handle, event) => {
        try {
          const page = await currentPage();
          const record = event as { selector?: string; origin?: string; url?: string; detail?: { submit_path?: string } };
          if (!record.selector) return { ok: false, refusal_reason: "event carries no target reference" };
          // Realm discipline: this session IS bound to one world - the
          // attach consent's realm. Keep the tab there regardless of which
          // origin the demonstration was recorded against; that recorded
          // origin describes the TEACHER'S world, not ours.
          const sessionOrigin = handle?.realm?.realm_id;
          if (sessionOrigin && !page.url().startsWith(sessionOrigin)) {
            await page.goto(`${sessionOrigin}/`);
          }
          // Click through Playwright's own locator engine, which understands
          // both plain CSS and the `>> nth=` ordinal form.
          await page.click(record.selector);
          // Resolve the entity from THIS page's own structure. The recorded
          // target is either a unique attribute selector or an attribute
          // family + ordinal ("the Nth button carrying <attr>") - both are
          // resolved here in plain DOM terms against the LOCAL world.
          const entity = await page.evaluate((sel: string) => {
            const familyMatch = sel.match(/^(\w+)\[([a-z-]+)\] >> nth=(\d+)$/);
            if (familyMatch) {
              const [, tag, attr, ordinal] = familyMatch;
              const family = [...document.querySelectorAll(`${tag}[${attr}]`)];
              return family[Number(ordinal)]?.getAttribute(attr) ?? "";
            }
            const el = document.querySelector(sel);
            return el?.getAttribute("data-entity") ?? "";
          }, record.selector);
          if (record.detail?.submit_path) {
            // Flow-internal requests resolve against the CURRENT world's
            // origin (the session realm), never the teaching origin.
            const here = new URL(page.url()).origin;
            await page.request.post(`${here}${record.detail.submit_path}`, {
              data: { entity },
              headers: { "content-type": "application/json" },
            });
          }
          return { ok: true };
        } catch (error) {
          return { ok: false, refusal_reason: error instanceof Error ? error.message : String(error) };
        }
      },
    }),
  );
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

// Deployment config layer (WI-PROD): bind host and auth token come from the
// environment so a production deployment never needs code changes. A bridge
// reachable beyond this machine REQUIRES a token - refusing to start is the
// honest failure, not binding wide and hoping.
const bridgeHost = process.env.SYNTHI_BRIDGE_HOST ?? "127.0.0.1";
const bridgeToken = process.env.SYNTHI_BRIDGE_TOKEN;
const isLoopback = /^(localhost|127\.0\.0\.1|::1|\[::1\])$/i.test(bridgeHost.trim());
if (!isLoopback && !bridgeToken) {
  console.error("refusing to bind beyond this machine without SYNTHI_BRIDGE_TOKEN set");
  process.exit(2);
}
if (bridgeToken) {
  console.log(`authenticated bridge mode on ${bridgeHost} (token required for every request)`);
}

const bridge = startBrowserWorkflowBridge({
  port,
  host: bridgeHost,
  ...(bridgeToken ? { token: bridgeToken } : {}),
});
await bridge.ready;
const resolvedPort = (bridge.server.address() as { port: number }).port;
// The banner is the contract with whoever spawned us: the ACTUAL listening
// port (argv "0" means the OS picked one).
console.log(`AGENT BRIDGE LIVE on port ${resolvedPort}`);

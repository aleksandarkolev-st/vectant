#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import http from "node:http";
import net from "node:net";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SYNTHI_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(SYNTHI_ROOT, "..");
const MCP_ROOT = path.join(REPO_ROOT, "mcp", "synthi-mcp");
const requireFromMcp = createRequire(path.join(MCP_ROOT, "package.json"));
const { chromium } = requireFromMcp("playwright");

const args = parseArgs(process.argv.slice(2));
const OUT_DIR = path.resolve(args["out-dir"] || path.join(SYNTHI_ROOT, "tmp", "dojo-ghost-mode-visual"));
const HOST = "127.0.0.1";
const BASE_PORT = Number(args.port || process.env.SYNTHI_DOJO_GHOST_VISUAL_PORT || 3107);

const DEV_OVERLAY_CSS = `
nextjs-portal,
[data-nextjs-toast],
[data-nextjs-dialog-overlay],
[data-nextjs-dev-overlay],
.nextjs-toast,
.nextjs-static-indicator-toast-wrapper,
.nextjs-dev-tools-indicator {
  display: none !important;
  visibility: hidden !important;
  pointer-events: none !important;
}
`;

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const port = await findAvailablePort(BASE_PORT);
  const server = await startDevServer({ port });
  try {
    const results = [];
    results.push(await captureGhostMode({ port, viewport: { width: 1440, height: 1100 }, name: "desktop" }));
    results.push(await captureGhostMode({ port, viewport: { width: 390, height: 1200 }, name: "mobile" }));
    const report = {
      schema_version: "synthi.dojo.ghostModeVisualProof.v1",
      ok: results.every((result) => result.ok),
      generated_at: new Date().toISOString(),
      route: `http://${HOST}:${port}/workspace/visual-dojo/dojo/debug/time-machine`,
      screenshots: results.map((result) => result.screenshot_path),
      results,
    };
    const reportPath = path.join(OUT_DIR, "ghost-mode-shadow-visual-report.json");
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ ok: report.ok, report_path: reportPath, screenshots: report.screenshots }, null, 2));
    if (!report.ok) process.exitCode = 1;
  } finally {
    stopDevServer(server);
  }
}

async function captureGhostMode({ port, viewport, name }) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport });
  try {
    await page.route("**/browser-workflows/state", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(buildBridgeState()),
    }));
    await page.goto(`http://${HOST}:${port}/workspace/visual-dojo/dojo/debug/time-machine`, { waitUntil: "networkidle" });
    await page.addStyleTag({ content: DEV_OVERLAY_CSS });
    await page.waitForSelector("[data-testid=\"ghost-shadow-evidence\"]", { timeout: 15_000 });
    const text = await page.locator("[data-testid=\"dojo-time-machine\"]").innerText();
    const checks = {
      has_shadow_evidence: text.includes("Shadow Evidence"),
      has_shadow_only: text.includes("Shadow only"),
      has_evidence_id: text.includes("ghost-evidence-visual-001"),
      has_upgrade_block: text.includes("Ghost Mode mismatch prevents entrustment upgrade"),
      has_no_execute: text.includes("Would Execute") && text.includes("No"),
    };
    const screenshotPath = path.join(OUT_DIR, `ghost-mode-shadow-${name}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    const stats = await stat(screenshotPath);
    return {
      name,
      ok: Object.values(checks).every(Boolean) && stats.size > 10_000,
      viewport,
      checks,
      screenshot_path: screenshotPath,
      bytes: stats.size,
    };
  } finally {
    await browser.close();
  }
}

function buildBridgeState() {
  return {
    state: {
      workspaceSlug: "visual-dojo",
      dojo: {
        skill_id: "dojo_save_invoice",
        label: "Save invoice",
        status: "licensed",
        entrustment_level: "E2",
        readiness_level: 5,
        published: true,
        proof_required: true,
        license: {
          license_id: "license-dojo-save-invoice",
          allowed_actions: ["run_workflow"],
          blocked_contexts: ["duplicate_client_without_stable_id"],
        },
        time_machine_debugger: {
          question: "What if stable entity identity changes?",
          baseline: {
            scenario_id: "scenario-duplicate-client",
            mutation_kind: "duplicate_entity",
            status: "failed",
            finding: "Duplicate display name was selected.",
          },
          counterfactual: {
            changed_variable: "stable_entity_identity",
            expected_status_after_change: "blocked",
            causal_finding: "Changing stable identity invalidates the current license branch.",
            license_impact: "Keep the skill at E2 until recertification passes.",
          },
          guardrails: [
            { guardrail_id: "guard-stable-id", title: "Stable ID required", rule: "client_id_verified == true", severity: "critical" },
          ],
          replay_plan: [
            { step: "replay_static_trace", simulator_tier: 0, expected_evidence: ["workflow:save-invoice"] },
            { step: "rerun_checkride_branch", simulator_tier: 2, expected_evidence: ["checkride:save-invoice"] },
          ],
        },
        ghost_run: {
          run_id: "ghost-visual-001",
          status: "mismatch",
          would_execute: false,
          production_mutations_executed: false,
          license_status: "blocked",
          shadow_evidence_id: "ghost-evidence-visual-001",
          evidence_refs: ["skill:dojo_save_invoice", "ghost:ghost-visual-001", "guardrail:guard-stable-id"],
          entrustment_impact: {
            upgrade_allowed: false,
            recommended_entrustment: "EX",
            reason: "Ghost Mode mismatch prevents entrustment upgrade until the planned action is recertified.",
          },
          observed_human_action: { action: "click", label: "Save invoice", selector: "button[name=Save]" },
          agent_planned_action: { action: "click", label: "Submit invoice", selector: "button[name=Submit]" },
          guardrails_triggered: ["guard-stable-id"],
          explanation: "Ghost mode found a mismatch and did not execute production mutations.",
        },
      },
    },
  };
}

async function startDevServer({ port }) {
  const logPath = path.join(OUT_DIR, "dev-server.log");
  const nextCli = path.join(SYNTHI_ROOT, "node_modules", "next", "dist", "bin", "next");
  const child = spawn(process.execPath, [nextCli, "dev", "--turbopack", "--hostname", HOST, "--port", String(port)], {
    cwd: SYNTHI_ROOT,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const logs = [];
  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));
  try {
    await waitForHttp({ port, timeoutMs: 45_000 });
  } catch (err) {
    stopDevServer(child);
    await writeFile(logPath, logs.join(""), "utf8");
    throw err;
  }
  await writeFile(logPath, logs.join(""), "utf8");
  return child;
}

function stopDevServer(child) {
  if (!child || child.killed) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill("SIGTERM");
  }
}

async function waitForHttp({ port, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const statusCode = await httpStatus(`http://${HOST}:${port}/workspace/visual-dojo/dojo/debug/time-machine`);
      if (statusCode && statusCode < 500) return;
    } catch (err) {
      lastError = err;
    }
    await delay(500);
  }
  throw new Error(`dojo_ghost_visual_dev_server_not_ready:${lastError?.message || "timeout"}`);
}

function httpStatus(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      res.resume();
      res.once("end", () => resolve(res.statusCode));
    });
    req.once("error", reject);
    req.setTimeout(2_000, () => {
      req.destroy(new Error("http_timeout"));
    });
  });
}

async function findAvailablePort(start) {
  for (let port = start; port < start + 50; port += 1) {
    if (await canListen(port)) return port;
  }
  throw new Error(`no_available_port_from_${start}`);
}

function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, HOST);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = "1";
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});

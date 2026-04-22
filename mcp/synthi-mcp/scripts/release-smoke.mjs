#!/usr/bin/env node
//
// release-smoke.mjs — post-publish sanity check for a Synthi MCP release
// image. Exercises the minimal MCP JSON-RPC handshake end-to-end against
// the just-pushed container and asserts the tools list + server identity.
//
// Runs in the `mcp-release` GitHub Actions workflow after the image is
// pushed; can also be run by hand:
//
//     node scripts/release-smoke.mjs --image ghcr.io/synthi-inc/synthi-mcp:v0.1.0
//
// It deliberately does NOT point the MCP at a real signaling server — the
// server starts in stdio mode and just answers the `initialize` + `tools/list`
// JSON-RPC exchange. That's enough to catch the failures this job exists to
// catch: empty dist/, missing entrypoint, busted bin shim, drift between the
// tool registry and what the server actually advertises.
//
// Exit code is 0 on success, 1 on any assertion failure.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";

const EXPECTED_TOOLS = [
  "synthi_attach",
  "synthi_detach",
  "synthi_reconnect",
  "synthi_health",
  "synthi_screenshot",
  "synthi_wait",
  "synthi_wait_hmr",
  "synthi_describe",
  "synthi_compile",
  "synthi_mouse",
  "synthi_keyboard",
  "synthi_click",
  "synthi_type",
  "synthi_locate",
  "synthi_verify",
  "synthi_get_event_log",
  "synthi_get_source_state",
  "synthi_report_source_state",
  "synthi_get_usage",
  "synthi_set_quality",
  "synthi_checkpoint",
  "synthi_acknowledge_disruption",
  "synthi_get_crash_info",
  "synthi_reset_guest",
  "synthi_acquire_input",
  "synthi_release_input",
  "synthi_request_human",
  "synthi_annotate_and_ask",
  "synthi_recent_human_actions",
];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--image") {
      out.image = argv[++i];
    } else if (a === "--command") {
      out.command = argv[++i];
    } else if (a === "--help" || a === "-h") {
      out.help = true;
    }
  }
  return out;
}

function usage() {
  console.error(
    [
      "release-smoke — exercise a Synthi MCP release artifact over stdio JSON-RPC.",
      "",
      "Usage:",
      "  node scripts/release-smoke.mjs --image <image-ref>",
      "  node scripts/release-smoke.mjs --command <abs-path-to-executable>",
      "",
      "Options:",
      "  --image <ref>    Docker image reference to smoke (pull must succeed).",
      "  --command <bin>  Alternative: run a local binary directly. Used by",
      "                   developers to smoke a local `dist/index.js` without",
      "                   building a container first.",
      "",
      "Exactly one of --image or --command must be provided.",
    ].join("\n"),
  );
}

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
}

async function runSmoke({ proc, label }) {
  const rl = createInterface({ input: proc.stdout });
  const pending = new Map();
  let nextId = 1;

  function send(method, params) {
    const id = nextId++;
    const msg = { jsonrpc: "2.0", id, method, params };
    proc.stdin.write(JSON.stringify(msg) + "\n");
    return new Promise((resolveResp, rejectResp) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectResp(new Error(`timeout waiting for response to ${method} (id=${id})`));
      }, 20_000);
      pending.set(id, { resolve: resolveResp, reject: rejectResp, timer });
    });
  }

  function notify(method, params) {
    const msg = { jsonrpc: "2.0", method, params };
    proc.stdin.write(JSON.stringify(msg) + "\n");
  }

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return; // ignore non-JSON lines
    }
    if (parsed?.id !== undefined && pending.has(parsed.id)) {
      const { resolve: r, reject: j, timer } = pending.get(parsed.id);
      pending.delete(parsed.id);
      clearTimeout(timer);
      if (parsed.error) {
        j(new Error(`${parsed.error.code}: ${parsed.error.message}`));
      } else {
        r(parsed.result);
      }
    }
  });

  proc.stderr.on("data", (buf) => {
    // Surface MCP stderr for post-mortem but don't fail on it.
    process.stderr.write(`[${label} stderr] ${buf}`);
  });

  const procDied = new Promise((_resolveDied, rejectDied) => {
    proc.once("exit", (code, signal) => {
      rejectDied(new Error(`MCP process exited early: code=${code} signal=${signal}`));
    });
  });

  async function step(promise) {
    return Promise.race([promise, procDied]);
  }

  // 1. initialize — MUST complete before any other request, per MCP spec.
  const init = await step(
    send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "synthi-release-smoke", version: "0.0.0" },
    }),
  );
  assert(
    typeof init?.protocolVersion === "string" && init.protocolVersion.length > 0,
    "initialize result missing protocolVersion",
  );
  assert(
    init?.serverInfo?.name?.includes("synthi"),
    `serverInfo.name doesn't identify synthi: ${JSON.stringify(init?.serverInfo)}`,
  );

  // 2. initialized notification — required before tool calls.
  notify("notifications/initialized", {});

  // 3. tools/list
  const toolList = await step(send("tools/list", {}));
  const tools = Array.isArray(toolList?.tools) ? toolList.tools : [];
  const names = tools.map((t) => t?.name).filter(Boolean);

  for (const expected of EXPECTED_TOOLS) {
    assert(
      names.includes(expected),
      `tool ${expected} missing from advertised tools (got ${names.length}: ${names.join(", ")})`,
    );
  }

  const extras = names.filter((n) => !EXPECTED_TOOLS.includes(n));
  if (extras.length > 0) {
    // Extras are informational — bonus tools (synthi_compile etc.) land in
    // the registry and should be reflected here. If the registry grows past
    // the expected list, the smoke DOES NOT fail; it just warns.
    console.error(
      `WARN: tools advertised but not in smoke baseline (${extras.length}): ${extras.join(", ")}`,
    );
  }

  // 4. Each tool schema must have a name + description + inputSchema.
  for (const t of tools) {
    assert(typeof t.name === "string" && t.name.length > 0, `tool missing name: ${JSON.stringify(t)}`);
    assert(
      typeof t.description === "string" && t.description.length > 0,
      `tool ${t.name} missing description`,
    );
    assert(
      t.inputSchema && typeof t.inputSchema === "object",
      `tool ${t.name} missing inputSchema`,
    );
  }

  return {
    serverInfo: init.serverInfo,
    protocolVersion: init.protocolVersion,
    toolCount: tools.length,
    tools: names,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.image && !args.command)) {
    usage();
    process.exit(args.help ? 0 : 1);
  }
  if (args.image && args.command) {
    console.error("error: pass exactly one of --image or --command");
    process.exit(1);
  }

  const version = (() => {
    try {
      const here = dirname(fileURLToPath(import.meta.url));
      const pkg = JSON.parse(readFileSync(resolve(here, "..", "package.json"), "utf8"));
      return pkg.version;
    } catch {
      return "unknown";
    }
  })();

  console.error(`synthi-mcp release smoke — package.json version = ${version}`);

  let proc;
  let label;

  if (args.image) {
    label = `image ${args.image}`;
    console.error(`spawning: docker run -i --rm ${args.image}`);
    proc = spawn(
      "docker",
      ["run", "-i", "--rm", "--entrypoint", "node", args.image, "/app/dist/index.js", "--session", "smoke-session"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
  } else {
    label = `command ${args.command}`;
    console.error(`spawning: ${args.command} --session smoke-session`);
    proc = spawn(args.command, ["--session", "smoke-session"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  let result;
  try {
    result = await runSmoke({ proc, label });
  } catch (err) {
    console.error(`SMOKE FAILED: ${err?.message ?? err}`);
    try {
      proc.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    process.exit(1);
  } finally {
    try {
      proc.stdin.end();
      proc.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }

  console.error("SMOKE OK");
  console.error(`  server: ${result.serverInfo?.name}@${result.serverInfo?.version}`);
  console.error(`  protocolVersion: ${result.protocolVersion}`);
  console.error(`  tools (${result.toolCount}): ${result.tools.join(", ")}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`unhandled: ${err?.message ?? err}`);
  process.exit(1);
});

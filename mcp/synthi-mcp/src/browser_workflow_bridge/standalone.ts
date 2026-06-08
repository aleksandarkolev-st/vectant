#!/usr/bin/env node
import { loadEnvFile } from "../util/env.js";

const __envLoad = loadEnvFile();

if (!process.env["SYNTHI_VISION_BACKEND"]) {
  process.env["SYNTHI_VISION_BACKEND"] = "agent_side";
}

import {
  resolveBrowserWorkflowBridgePort,
  startBrowserWorkflowBridge,
} from "./server.js";

function argValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const next = argv[index + 1];
  return next && !next.startsWith("--") ? next : undefined;
}

async function main(): Promise<void> {
  if (__envLoad.path) {
    process.stderr.write(
      `synthi-browser-workflow-bridge env: loaded ${__envLoad.loaded} var(s) from ${__envLoad.path} (${__envLoad.skipped_existing} already set)\n`
    );
  }

  const argv = process.argv.slice(2);
  const host = argValue(argv, "--host") ?? process.env["SYNTHI_BROWSER_WORKFLOW_BRIDGE_HOST"] ?? "127.0.0.1";
  const port = resolveBrowserWorkflowBridgePort(argValue(argv, "--port") ?? process.env["SYNTHI_BROWSER_WORKFLOW_BRIDGE_PORT"]) ?? 9466;
  const token = argValue(argv, "--token") ?? process.env["SYNTHI_BROWSER_WORKFLOW_BRIDGE_TOKEN"];
  const bridge = startBrowserWorkflowBridge({
    port,
    host,
    ...(token ? { token } : {}),
  });
  await bridge.ready;
  const auth = token ? " (token-gated)" : " (no auth - local only)";
  process.stderr.write(
    `synthi browser workflow bridge: http://${host}:${port}/browser-workflows/state${auth}\n`
  );

  const shutdown = async (): Promise<void> => {
    await bridge.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  process.stderr.write(
    `synthi browser workflow bridge fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`
  );
  process.exit(1);
});

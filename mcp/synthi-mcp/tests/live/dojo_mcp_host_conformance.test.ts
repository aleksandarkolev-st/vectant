// @ts-nocheck
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const hasLiveHost = Boolean(
  process.env.SYNTHI_DOJO_MCP_HOST_URL
  || process.env.SYNTHI_DOJO_MCP_CONFORMANCE_MCP_COMMAND,
);

const describeLive = hasLiveHost ? describe : describe.skip;

describeLive("live Dojo MCP deployed host conformance", () => {
  it("passes the release conformance harness against the configured host", () => {
    const cwd = process.cwd();
    const outDir = process.env.SYNTHI_DOJO_MCP_CONFORMANCE_OUT_DIR
      || path.join(cwd, "tmp", "dojo-mcp-host-conformance-live");
    const result = spawnSync(process.execPath, [
      "scripts/dojo-mcp-host-conformance.mjs",
      "--require-non-loopback-mcp-host",
      "--out-dir",
      outDir,
    ], {
      cwd,
      env: process.env,
      encoding: "utf8",
      timeout: Number(process.env.SYNTHI_DOJO_MCP_CONFORMANCE_TEST_TIMEOUT_MS || 180_000),
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("Dojo MCP host conformance passed");
  }, 190_000);
});

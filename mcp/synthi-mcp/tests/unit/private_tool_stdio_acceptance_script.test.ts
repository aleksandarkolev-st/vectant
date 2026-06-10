// @ts-nocheck
import { describe, expect, it } from "vitest";
import {
  buildStdioMcpEnv,
  resolveMcpServerCommandSpec,
  selectCdpTargetsToClose,
  strictHostValidateToolArgs,
  stdioAcceptanceAttachEvidence,
} from "../../scripts/private-tool-stdio-acceptance.mjs";

describe("private-tool stdio acceptance harness", () => {
  it("configures the spawned MCP process through hosted runtime env only", () => {
    const env = buildStdioMcpEnv({
      baseEnv: {
        PATH: "/usr/bin",
        SYNTHI_BROWSER_CDP_URL: "ws://local-dev-cdp.example.test/devtools/browser/session",
      },
      SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_FILE: "/tmp/private-tools.enc.json",
      SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_KEY: "private-tool-key",
      SYNTHI_PRIVATE_WORKFLOW_TOOL_SCOPE: "acceptance-scope",
      SYNTHI_HOSTED_BROWSER_CDP_URL: "ws://hosted-runtime.example.test/devtools/browser/session",
      SYNTHI_HOSTED_BROWSER_WORKSPACE_URL: "https://preview.example.test/workspace",
      SYNTHI_WORKSPACE_ID: "acceptance-workspace",
      SYNTHI_AGENT_ID: "stdio_private_tool_acceptance",
    });

    expect(env).toEqual(expect.objectContaining({
      PATH: "/usr/bin",
      SYNTHI_HOSTED_BROWSER_CDP_URL: "ws://hosted-runtime.example.test/devtools/browser/session",
      SYNTHI_HOSTED_BROWSER_WORKSPACE_URL: "https://preview.example.test/workspace",
      SYNTHI_WORKSPACE_ID: "acceptance-workspace",
      SYNTHI_AGENT_ID: "stdio_private_tool_acceptance",
    }));
    expect(env).not.toHaveProperty("SYNTHI_BROWSER_CDP_URL");
    expect(JSON.stringify(env)).not.toMatch(/browser-mcp-live|\/port\/\d+|C:\\\\/i);
  });

  it("defaults the conformance harness to the repo dist stdio server", () => {
    const spec = resolveMcpServerCommandSpec({
      args: {},
      env: {},
      defaultCommand: "/usr/bin/node",
      defaultArgs: ["/repo/mcp/synthi-mcp/dist/index.js"],
      defaultCwd: "/repo/mcp/synthi-mcp",
    });

    expect(spec).toEqual({
      command: "/usr/bin/node",
      args: ["/repo/mcp/synthi-mcp/dist/index.js"],
      cwd: "/repo/mcp/synthi-mcp",
      default_repo_dist: true,
    });
  });

  it("accepts a structured custom deployed MCP server command without shell parsing", () => {
    const spec = resolveMcpServerCommandSpec({
      args: {
        "mcp-command": "synthi-mcp",
        "mcp-args-json": "[\"--stdio\",\"--profile\",\"prod\"]",
        "mcp-cwd": "/srv/synthi",
      },
      env: {},
      defaultCommand: "/usr/bin/node",
      defaultArgs: ["/repo/mcp/synthi-mcp/dist/index.js"],
      defaultCwd: "/repo/mcp/synthi-mcp",
    });

    expect(spec).toEqual({
      command: "synthi-mcp",
      args: ["--stdio", "--profile", "prod"],
      cwd: "/srv/synthi",
      default_repo_dist: false,
    });
  });

  it("rejects malformed custom MCP arg vectors", () => {
    expect(() => resolveMcpServerCommandSpec({
      args: { "mcp-command": "synthi-mcp", "mcp-args-json": "--stdio" },
      env: {},
    })).toThrow("mcp_args_json_invalid");
    expect(() => resolveMcpServerCommandSpec({
      args: { "mcp-command": "synthi-mcp", "mcp-args-json": "[\"--stdio\",42]" },
      env: {},
    })).toThrow("mcp_args_json_must_be_string_array");
  });

  it("requires hosted attach evidence instead of local CDP attach evidence", () => {
    const hostedEvidence = stdioAcceptanceAttachEvidence({
      attachResult: {
        parsed: {
          ok: true,
          runtime: {
            kind: "hosted",
            adapter: "hosted-playwright-cdp",
            workspace_id: "acceptance-workspace",
          },
        },
      },
    });
    const localEvidence = stdioAcceptanceAttachEvidence({
      attachResult: {
        parsed: {
          ok: true,
          runtime: {
            kind: "local-dev-cdp",
            adapter: "playwright-cdp",
          },
        },
      },
    });

    expect(hostedEvidence).toEqual({
      hosted_attach: true,
      local_attach: false,
      runtime_kind: "hosted",
      product_path: "agent_client_to_synthi_mcp_to_broker_to_hosted_browser",
    });
    expect(localEvidence).toEqual(expect.objectContaining({
      hosted_attach: false,
      local_attach: true,
      runtime_kind: "local-dev-cdp",
    }));
  });

  it("does not prune the final CDP page target out from under the hosted runtime", () => {
    expect(selectCdpTargetsToClose([{ id: "keep", type: "webview" }])).toEqual([]);
    expect(selectCdpTargetsToClose([
      { id: "keep", type: "webview" },
      { id: "close", type: "page" },
    ]).map((target) => target.id)).toEqual(["close"]);
  });

  it("validates private tool arguments like a strict deployed MCP host", () => {
    const schema = {
      type: "object",
      properties: {
        run_mode: { type: "string", enum: ["sameSession", "prefixOnly", "coldSession"] },
        confirm_mutation: { type: "boolean" },
        timeout_ms: { type: "number" },
      },
      required: [],
      additionalProperties: false,
    };

    expect(strictHostValidateToolArgs(schema, {})).toEqual([]);
    expect(strictHostValidateToolArgs(schema, { run_mode: "sameSession", timeout_ms: 1000 })).toEqual([]);
    expect(strictHostValidateToolArgs(schema, { script_path: "/tmp/generated.spec.ts" })).toEqual(["additional_property:script_path"]);
    expect(strictHostValidateToolArgs(schema, { run_mode: "desktopChrome" })).toEqual(["enum:run_mode"]);
    expect(strictHostValidateToolArgs(schema, { confirm_mutation: "yes" })).toEqual(["type:confirm_mutation"]);
  });
});

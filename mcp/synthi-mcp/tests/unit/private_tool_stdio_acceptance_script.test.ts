// @ts-nocheck
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildStdioMcpEnv,
  mcpCommandConformance,
  parseBooleanFlag,
  parseJsonObjectArgument,
  privateToolStoreConformance,
  resolveMcpServerCommandSpec,
  resolvePrivateToolStoreSpec,
  runtimeEndpointConformance,
  selectPrivateToolForAcceptance,
  selectCdpTargetsToClose,
  strictHostValidateToolArgs,
  stdioAcceptanceAttachEvidence,
} from "../../scripts/lib/private-tool-stdio-acceptance-helpers.mjs";

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
      cwd: path.resolve("/repo/mcp/synthi-mcp"),
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
      cwd: path.resolve("/srv/synthi"),
      default_repo_dist: false,
    });
  });

  it("can require deployed-host conformance to use a custom MCP command", () => {
    const defaultSpec = resolveMcpServerCommandSpec({
      args: {},
      env: {},
      defaultCommand: "/usr/bin/node",
      defaultArgs: ["/repo/mcp/synthi-mcp/dist/index.js"],
      defaultCwd: "/repo/mcp/synthi-mcp",
    });
    const customSpec = resolveMcpServerCommandSpec({
      args: { "mcp-command": "synthi-mcp" },
      env: {},
      defaultCommand: "/usr/bin/node",
      defaultArgs: ["/repo/mcp/synthi-mcp/dist/index.js"],
      defaultCwd: "/repo/mcp/synthi-mcp",
    });

    expect(mcpCommandConformance({
      commandSpec: defaultSpec,
      requireCustomCommand: false,
    })).toEqual({
      ok: true,
      require_custom_mcp_command: false,
      custom_mcp_command: false,
    });
    expect(mcpCommandConformance({
      commandSpec: defaultSpec,
      requireCustomCommand: true,
    })).toEqual({
      ok: false,
      require_custom_mcp_command: true,
      custom_mcp_command: false,
    });
    expect(mcpCommandConformance({
      commandSpec: customSpec,
      requireCustomCommand: true,
    })).toEqual({
      ok: true,
      require_custom_mcp_command: true,
      custom_mcp_command: true,
    });
  });

  it("resolves external private workflow stores only when the scoped encrypted store is complete", () => {
    expect(resolvePrivateToolStoreSpec({
      args: {},
      env: {},
      defaultFile: "/tmp/default-private-tools.enc.json",
      defaultKey: "default-key",
      defaultScope: "default-scope",
    })).toEqual({
      file: path.resolve("/tmp/default-private-tools.enc.json"),
      key: "default-key",
      scope: "default-scope",
      external: false,
    });

    expect(resolvePrivateToolStoreSpec({
      args: {
        "private-tool-store-file": "/srv/synthi/private-tools.enc.json",
        "private-tool-store-key": "external-key",
        "private-tool-store-scope": "workspace-scope",
      },
      env: {},
      defaultFile: "/tmp/default-private-tools.enc.json",
      defaultKey: "default-key",
      defaultScope: "default-scope",
    })).toEqual({
      file: path.resolve("/srv/synthi/private-tools.enc.json"),
      key: "external-key",
      scope: "workspace-scope",
      external: true,
    });

    expect(() => resolvePrivateToolStoreSpec({
      args: { "private-tool-store-file": "/srv/synthi/private-tools.enc.json" },
      env: {},
      defaultFile: "/tmp/default-private-tools.enc.json",
      defaultKey: "default-key",
      defaultScope: "default-scope",
    })).toThrow("private_tool_store_config_incomplete");
  });

  it("can require deployed-host conformance to use an existing private workflow store", () => {
    expect(privateToolStoreConformance({
      storeSpec: {
      file: path.resolve("/tmp/default-private-tools.enc.json"),
        key: "default-key",
        scope: "default-scope",
        external: false,
      },
      requireExternalStore: false,
    })).toEqual({
      ok: true,
      require_external_private_tool_store: false,
      external_private_tool_store: false,
    });
    expect(privateToolStoreConformance({
      storeSpec: {
        file: "/tmp/default-private-tools.enc.json",
        key: "default-key",
        scope: "default-scope",
        external: false,
      },
      requireExternalStore: true,
    })).toEqual({
      ok: false,
      require_external_private_tool_store: true,
      external_private_tool_store: false,
    });
    expect(privateToolStoreConformance({
      storeSpec: {
      file: path.resolve("/srv/synthi/private-tools.enc.json"),
        key: "external-key",
        scope: "workspace-scope",
        external: true,
      },
      requireExternalStore: true,
    })).toEqual({
      ok: true,
      require_external_private_tool_store: true,
      external_private_tool_store: true,
    });
  });

  it("selects private workflow tools deterministically", () => {
    const tools = [
      { name: "synthi_browser_open" },
      { name: "synthi_app_create_invoice" },
      { name: "synthi_app_export_csv" },
    ];

    expect(selectPrivateToolForAcceptance({
      tools,
      requestedToolName: "synthi_app_export_csv",
    }).name).toBe("synthi_app_export_csv");
    expect(selectPrivateToolForAcceptance({
      tools,
      seededToolName: "synthi_app_create_invoice",
    }).name).toBe("synthi_app_create_invoice");
    expect(selectPrivateToolForAcceptance({
      tools: [{ name: "synthi_app_single" }],
    }).name).toBe("synthi_app_single");
    expect(() => selectPrivateToolForAcceptance({ tools })).toThrow("private_workflow_tool_ambiguous");
    expect(() => selectPrivateToolForAcceptance({
      tools,
      requestedToolName: "synthi_app_missing",
    })).toThrow("private_workflow_tool_not_found");
    expect(() => selectPrivateToolForAcceptance({
      tools: [{ name: "synthi_browser_open" }],
    })).toThrow("private_workflow_tool_missing");
  });

  it("parses explicit boolean flags for conformance gates", () => {
    expect(parseBooleanFlag(undefined)).toBe(false);
    expect(parseBooleanFlag("")).toBe(false);
    expect(parseBooleanFlag("0")).toBe(false);
    expect(parseBooleanFlag("false")).toBe(false);
    expect(parseBooleanFlag("off")).toBe(false);
    expect(parseBooleanFlag("1")).toBe(true);
    expect(parseBooleanFlag("true")).toBe(true);
    expect(parseBooleanFlag("yes")).toBe(true);
  });

  it("parses structured JSON object arguments without accepting arrays or strings", () => {
    expect(parseJsonObjectArgument("{\"run_mode\":\"prefixOnly\",\"confirm_mutation\":false}", "tool_args")).toEqual({
      run_mode: "prefixOnly",
      confirm_mutation: false,
    });
    expect(() => parseJsonObjectArgument("[\"run_mode\"]", "tool_args")).toThrow("tool_args_must_be_object");
    expect(() => parseJsonObjectArgument("not-json", "tool_args")).toThrow("tool_args_invalid_json");
  });

  it("can require host conformance to use a non-loopback runtime endpoint", () => {
    expect(runtimeEndpointConformance({
      cdpUrl: "http://127.0.0.1:37727",
      requireNonLoopbackRuntime: false,
    })).toEqual({
      ok: true,
      require_non_loopback_runtime: false,
      non_loopback_runtime: false,
      runtime_host_class: "loopback",
    });
    expect(runtimeEndpointConformance({
      cdpUrl: "http://localhost:9222",
      requireNonLoopbackRuntime: true,
    })).toEqual({
      ok: false,
      require_non_loopback_runtime: true,
      non_loopback_runtime: false,
      runtime_host_class: "loopback",
    });
    expect(runtimeEndpointConformance({
      cdpUrl: "ws://127.12.0.1/devtools/browser/session",
      requireNonLoopbackRuntime: true,
    })).toEqual({
      ok: false,
      require_non_loopback_runtime: true,
      non_loopback_runtime: false,
      runtime_host_class: "loopback",
    });
    expect(runtimeEndpointConformance({
      cdpUrl: "http://0.0.0.0:9222/json/version",
      requireNonLoopbackRuntime: true,
    })).toEqual({
      ok: false,
      require_non_loopback_runtime: true,
      non_loopback_runtime: false,
      runtime_host_class: "local-bind",
    });
    expect(runtimeEndpointConformance({
      cdpUrl: "wss://hosted-browser-runtime.example.test/devtools/browser/session",
      requireNonLoopbackRuntime: true,
    })).toEqual({
      ok: true,
      require_non_loopback_runtime: true,
      non_loopback_runtime: true,
      runtime_host_class: "remote",
    });
    expect(runtimeEndpointConformance({
      cdpUrl: "not-a-url",
      requireNonLoopbackRuntime: true,
    })).toEqual({
      ok: false,
      require_non_loopback_runtime: true,
      non_loopback_runtime: false,
      runtime_host_class: "invalid",
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

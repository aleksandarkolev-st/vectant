import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { authCheckpointManager } from "../../src/browser/auth.js";
import { browserBroker } from "../../src/browser/broker.js";
import { generatePrivateWorkflowToolManifest } from "../../src/browser/private_tool_manifest.js";
import { privateWorkflowToolRegistry } from "../../src/browser/private_tool_registry.js";
import { browserPlaywrightAdapter } from "../../src/browser/playwright_adapter.js";
import { sourceIdentityRegistry } from "../../src/browser/source_identity.js";
import { compileWorkflowContract } from "../../src/browser/workflow.js";
import type { BrowserTraceEvent } from "../../src/browser/types.js";
import { createSynthiServer } from "../../src/server.js";
import { browserPrivateWorkflowTools, dispatchBrowserTool } from "../../src/tools/browser.js";

beforeEach(() => {
  browserBroker.resetForTests();
  authCheckpointManager.resetForTests();
  privateWorkflowToolRegistry.resetForTests();
  sourceIdentityRegistry.resetForTests();
  vi.restoreAllMocks();
});

describe("private browser workflow MCP tool manifest", () => {
  it("marks clean read-only workflows as available", () => {
    const workflow = compileWorkflowContract([
      event({
        event_id: "open",
        action: "click",
        detail: { element: { role: "button", name: "Open details", source_id: "s_open" } },
        locator_candidates: [
          { kind: "role", locator: "page.getByRole(\"button\", { name: \"Open details\" })", confidence: 0.98, reason: "role" },
        ],
      }),
    ]);

    const manifest = generatePrivateWorkflowToolManifest(workflow.contract);

    expect(manifest).toEqual(expect.objectContaining({
      kind: "privateMcpToolManifest",
      schema_version: "synthi_private_browser_tool_v1",
      status: "available",
      tool_name: "synthi_app_open_details",
      default_run_mode: "sameSession",
      run_modes: ["sameSession"],
      backing_tools: expect.objectContaining({
        run_workflow: "synthi_browser_run_workflow",
        ci_isolated_replay: "synthi_safety_run_ci_isolated_replay",
        auth_readiness: "synthi_auth_get_tool_auth_readiness",
      }),
    }));
    expect(manifest.auth.unattended_ready).toBe(true);
    expect(manifest.mutation.requires_confirmation).toBe(false);
    expect(manifest.surface_replay).toEqual(expect.objectContaining({
      unsupported_count: 0,
      parameterized_count: 0,
      steps: [
        expect.objectContaining({ step_id: "open", kind: "dom", replay: "durable" }),
      ],
    }));
  });

  it("requires confirmation or CI for mutation workflows", () => {
    const workflow = compileWorkflowContract([
      event({
        event_id: "save",
        action: "click",
        detail: { element: { role: "button", name: "Save settings", source_id: "s_save" } },
        locator_candidates: [
          { kind: "role", locator: "page.getByRole(\"button\", { name: \"Save settings\" })", confidence: 0.98, reason: "role" },
        ],
      }),
    ]);

    const manifest = generatePrivateWorkflowToolManifest(workflow.contract);

    expect(manifest.status).toBe("manualOnly");
    expect(manifest.default_run_mode).toBe("confirmBeforeCommit");
    expect(manifest.run_modes).toEqual(["prefixOnly", "confirmBeforeCommit", "ciOnly"]);
    expect(manifest.auth.unattended_ready).toBe(false);
    expect(manifest.mutation).toEqual(expect.objectContaining({
      first_mutation_step_id: "save",
      requires_confirmation: true,
      requires_ci_isolation: true,
    }));
    expect(manifest.safety.blockers).toContain("mutationRequiresIsolation");
  });

  it("marks checkpoint-only authenticated tools manual-only", () => {
    const workflow = compileWorkflowContract([
      event({
        event_id: "open",
        action: "click",
        security: {
          exact_origin_approved: true,
          screenshot_approved: true,
          diagnostics_approved: true,
          auth_checkpoint_approved: true,
        },
        detail: { element: { role: "button", name: "Open details", source_id: "s_open" } },
        locator_candidates: [
          { kind: "role", locator: "page.getByRole(\"button\", { name: \"Open details\" })", confidence: 0.98, reason: "role" },
        ],
      }),
    ]);

    const manifest = generatePrivateWorkflowToolManifest(workflow.contract);

    expect(manifest.status).toBe("manualOnly");
    expect(manifest.auth).toEqual(expect.objectContaining({
      durability: "interactiveCheckpoint",
      unattended_ready: false,
      required: true,
    }));
    expect(manifest.safety.notes.join(" ")).toContain("saved login checkpoint is valid");
  });

  it("marks unsupported-surface workflows blocked", () => {
    const workflow = compileWorkflowContract([
      event({
        event_id: "card",
        frame_id: "payment-frame",
        action: "fill",
        detail: { element: { role: "textbox", label: "Cardholder", source_id: "s_card" } },
        locator_candidates: [
          { kind: "label", locator: "page.getByLabel(\"Cardholder\")", confidence: 0.94, reason: "form_label" },
        ],
      }),
    ]);

    const manifest = generatePrivateWorkflowToolManifest(workflow.contract);

    expect(manifest.status).toBe("blocked");
    expect(manifest.safety.blockers).toContain("iframeNeedsFrameLocator");
  });

  it("does not hide parameterized and unsupported replay surfaces in generated tools", () => {
    const workflow = compileWorkflowContract([
      event({
        event_id: "file-drop",
        event_seq: 1,
        action: "drag",
        detail: {
          drag_class: "fileDrop",
          file_parameter: "UPLOAD_FILE",
          element: { role: "button", name: "Upload area", source_id: "s_upload" },
        },
        locator_candidates: [
          { kind: "role", locator: "page.getByRole(\"button\", { name: \"Upload area\" })", confidence: 0.98, reason: "role" },
        ],
      }),
      event({
        event_id: "canvas",
        event_seq: 2,
        action: "click",
        detail: {
          canvas: true,
          element: { tag: "canvas", label: "Chart", source_id: "s_chart" },
        },
        locator_candidates: [
          { kind: "css", locator: "page.locator(\"canvas\")", confidence: 0.8, reason: "css" },
        ],
      }),
    ]);

    const manifest = generatePrivateWorkflowToolManifest(workflow.contract);

    expect(manifest.surface_replay).toEqual(expect.objectContaining({
      unsupported_count: 1,
      parameterized_count: 1,
    }));
    expect(manifest.surface_replay.steps).toEqual([
      expect.objectContaining({ step_id: "file-drop", kind: "fileDrop", replay: "parameterized" }),
      expect.objectContaining({ step_id: "canvas", kind: "canvas", replay: "unsupported" }),
    ]);
    expect(manifest.parameters).toContainEqual(expect.objectContaining({
      name: "upload_file",
      value_shape: "filePath",
      required: true,
    }));
    expect(manifest.safety.limitations).toContain("canvasCoordinateOnly");
  });

  it("deduplicates repeated workflow parameters by stable parameter name", () => {
    const workflow = compileWorkflowContract([
      event({
        event_id: "email-1",
        event_seq: 1,
        action: "fill",
        value: "ada@example.test",
        detail: { element: { role: "textbox", label: "Email", source_id: "s_email" } },
        locator_candidates: [
          { kind: "label", locator: "page.getByLabel(\"Email\")", confidence: 0.96, reason: "form_label" },
        ],
      }),
      event({
        event_id: "segment",
        event_seq: 2,
        action: "select",
        value: "enterprise",
        detail: { element: { role: "combobox", label: "Segment", source_id: "s_segment" } },
        locator_candidates: [
          { kind: "label", locator: "page.getByLabel(\"Segment\")", confidence: 0.96, reason: "form_label" },
        ],
      }),
      event({
        event_id: "email-2",
        event_seq: 3,
        action: "fill",
        value: "grace@example.test",
        detail: { element: { role: "textbox", label: "Email", source_id: "s_email" } },
        locator_candidates: [
          { kind: "label", locator: "page.getByLabel(\"Email\")", confidence: 0.96, reason: "form_label" },
        ],
      }),
    ]);

    const manifest = generatePrivateWorkflowToolManifest(workflow.contract);

    expect(manifest.parameters.map((parameter) => parameter.name)).toEqual(["email", "segment"]);
    expect(manifest.parameters).toContainEqual(expect.objectContaining({
      name: "email",
      label: "Email",
      value_shape: "email",
      required: true,
    }));
  });

  it("exposes the manifest through the browser MCP tool", async () => {
    const url = "https://app.example.test/settings";
    browserBroker.requestConsent(url);
    browserBroker.registerTabs([{ tab_id: "tab-a", url, active: true }]);
    expect(browserBroker.startTeachMode("tab-a").ok).toBe(true);
    registerSourceToken("s_open");
    browserBroker.recordHumanAction({
      tab_id: "tab-a",
      url,
      origin: "https://app.example.test",
      action: "click",
      element: { role: "button", name: "Open details", source_id: "s_open" },
    });

    const response = await dispatchBrowserTool("synthi_browser_generate_private_tool_manifest", {});

    expect(response?.isError).toBeUndefined();
    expect(response?.structuredContent).toEqual(expect.objectContaining({ ok: true }));
    expect((response?.structuredContent as { manifest: { tool_name: string; status: string } }).manifest).toEqual(
      expect.objectContaining({
        tool_name: "synthi_app_open_details",
        status: "available",
      })
    );
  });

  it("uses live auth readiness when exposing manifests through the browser MCP tool", async () => {
    const url = "https://secure.example.test/settings";
    browserBroker.requestConsent(url);
    browserBroker.registerTabs([{ tab_id: "tab-a", url, active: true }]);
    const enrollment = authCheckpointManager.beginEnrollment(url);
    const checkpoint = authCheckpointManager.finishEnrollment({
      enrollment_id: enrollment.enrollment_id,
      ttl_ms: 60_000,
    });
    expect(checkpoint.ok).toBe(true);
    if (!checkpoint.ok) throw new Error("unexpected checkpoint failure");
    expect(browserBroker.startTeachMode("tab-a").ok).toBe(true);
    registerSourceToken("s_secure");
    browserBroker.recordHumanAction({
      tab_id: "tab-a",
      url,
      origin: "https://secure.example.test",
      action: "click",
      element: { role: "button", name: "Open secure panel", source_id: "s_secure" },
    });

    authCheckpointManager.revoke(checkpoint.checkpoint.checkpoint_id);

    const blocked = await dispatchBrowserTool("synthi_browser_generate_private_tool_manifest", {});
    expect(blocked?.isError).toBeUndefined();
    expect(blocked?.structuredContent).toEqual(expect.objectContaining({ ok: false }));
    expect((blocked?.structuredContent as { manifest: { status: string; auth: { unattended_ready: boolean }; safety: { notes: string[] } } }).manifest).toEqual(expect.objectContaining({
      status: "blocked",
      auth: expect.objectContaining({ unattended_ready: false }),
      safety: expect.objectContaining({
        notes: expect.arrayContaining([expect.stringContaining("checkpointRevoked")]),
      }),
    }));

    const provider = authCheckpointManager.configureRefreshProvider({
      url,
      secret_ref: "synthi://secrets/workspace/auth-refresh",
    });
    expect(provider.ok).toBe(true);
    if (!provider.ok) throw new Error("unexpected provider failure");
    authCheckpointManager.testRefreshProvider(provider.provider.provider_id);

    const available = await dispatchBrowserTool("synthi_browser_generate_private_tool_manifest", {});
    expect(available?.isError).toBeUndefined();
    expect((available?.structuredContent as { manifest: { status: string; auth: { durability: string; unattended_ready: boolean } } }).manifest).toEqual(expect.objectContaining({
      status: "available",
      auth: expect.objectContaining({
        durability: "refreshProvider",
        unattended_ready: true,
      }),
    }));
  });

  it("publishes a taught workflow as a callable private MCP tool", async () => {
    const url = "https://app.example.test/settings";
    browserBroker.requestConsent(url);
    browserBroker.registerTabs([{ tab_id: "tab-a", url, active: true }]);
    browserBroker.selectTab("tab-a");
    expect(browserBroker.startTeachMode("tab-a").ok).toBe(true);
    registerSourceToken("s_open");
    browserBroker.recordHumanAction({
      tab_id: "tab-a",
      url,
      origin: "https://app.example.test",
      action: "click",
      element: { role: "button", name: "Open details", source_id: "s_open" },
      locator_candidates: [
        { kind: "role", locator: "page.getByRole(\"button\", { name: \"Open details\" })", confidence: 0.98, reason: "role" },
      ],
    });

    const published = await dispatchBrowserTool("synthi_browser_publish_private_tool", {});
    expect(published?.isError).toBeUndefined();
    expect((published?.structuredContent as { tool_name: string }).tool_name).toBe("synthi_app_open_details");
    expect(browserPrivateWorkflowTools()).toEqual([
      expect.objectContaining({
        name: "synthi_app_open_details",
        inputSchema: expect.objectContaining({
          type: "object",
          properties: expect.objectContaining({
            run_mode: expect.objectContaining({ enum: ["sameSession", "prefixOnly", "coldSession"] }),
          }),
        }),
      }),
    ]);

    const replay = vi.spyOn(browserPlaywrightAdapter, "replayActionEvent").mockResolvedValue({
      ok: true,
      action: "click",
      tab_id: "tab-a",
      url,
    });

    const response = await dispatchBrowserTool("synthi_app_open_details", {});

    expect(response?.isError).toBeUndefined();
    expect(response?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      private_tool: expect.objectContaining({
        tool_name: "synthi_app_open_details",
        run_mode: "sameSession",
      }),
    }));
    expect(replay).toHaveBeenCalledWith(
      "tab-a",
      expect.objectContaining({ event_id: expect.any(String), action: "click" }),
      "click",
      "page.locator(\"[data-synthi-source-id=\\\"s_open\\\"]\")",
      undefined
    );
  });

  it("requires explicit confirmation before a private MCP tool runs mutation steps", async () => {
    const url = "https://app.example.test/settings";
    browserBroker.requestConsent(url);
    browserBroker.registerTabs([{ tab_id: "tab-a", url, active: true }]);
    browserBroker.selectTab("tab-a");
    expect(browserBroker.startTeachMode("tab-a").ok).toBe(true);
    registerSourceToken("s_save");
    browserBroker.recordHumanAction({
      tab_id: "tab-a",
      url,
      origin: "https://app.example.test",
      action: "click",
      element: { role: "button", name: "Save settings", source_id: "s_save" },
      locator_candidates: [
        { kind: "role", locator: "page.getByRole(\"button\", { name: \"Save settings\" })", confidence: 0.98, reason: "role" },
      ],
    });

    const published = await dispatchBrowserTool("synthi_browser_publish_private_tool", {});
    expect(published?.isError).toBeUndefined();
    expect((published?.structuredContent as { manifest: { status: string } }).manifest.status).toBe("manualOnly");

    const blocked = await dispatchBrowserTool("synthi_app_save_settings", { run_mode: "sameSession" });

    expect(blocked?.isError).toBe(true);
    expect(blocked?.structuredContent).toEqual(expect.objectContaining({
      error: "mutation_confirmation_required",
      tool_name: "synthi_app_save_settings",
      confirmation_field: "confirm_mutation",
      safe_run_modes: expect.arrayContaining(["prefixOnly", "coldSession", "ciOnly"]),
    }));
  });

  it("lets an MCP client publish, discover, and call a generated private workflow tool", async () => {
    const url = "https://app.example.test/settings";
    browserBroker.requestConsent(url);
    browserBroker.registerTabs([{ tab_id: "tab-a", url, active: true }]);
    browserBroker.selectTab("tab-a");
    expect(browserBroker.startTeachMode("tab-a").ok).toBe(true);
    registerSourceToken("s_open");
    browserBroker.recordHumanAction({
      tab_id: "tab-a",
      url,
      origin: "https://app.example.test",
      action: "click",
      element: { role: "button", name: "Open details", source_id: "s_open" },
      locator_candidates: [
        { kind: "role", locator: "page.getByRole(\"button\", { name: \"Open details\" })", confidence: 0.98, reason: "role" },
      ],
    });
    const replay = vi.spyOn(browserPlaywrightAdapter, "replayActionEvent").mockResolvedValue({
      ok: true,
      action: "click",
      tab_id: "tab-a",
      url,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createSynthiServer({ defaultSignalingUrl: "ws://localhost:9000" });
    const client = new Client({ name: "workflow-acceptance-test", version: "0.0.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const beforePublish = await client.listTools();
      expect(beforePublish.tools.map((tool) => tool.name)).not.toContain("synthi_app_open_details");

      const publish = await client.callTool({ name: "synthi_browser_publish_private_tool", arguments: {} });
      expect(publish.isError).not.toBe(true);
      expect(JSON.parse(String(publish.content[0]?.text))).toEqual(expect.objectContaining({
        ok: true,
        tool_name: "synthi_app_open_details",
      }));

      const afterPublish = await client.listTools();
      expect(afterPublish.tools).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: "synthi_app_open_details",
          inputSchema: expect.objectContaining({
            properties: expect.objectContaining({
              run_mode: expect.objectContaining({ enum: ["sameSession", "prefixOnly", "coldSession"] }),
            }),
          }),
        }),
      ]));

      const run = await client.callTool({ name: "synthi_app_open_details", arguments: {} });
      expect(run.isError).not.toBe(true);
      expect(JSON.parse(String(run.content[0]?.text))).toEqual(expect.objectContaining({
        ok: true,
        private_tool: expect.objectContaining({
          tool_name: "synthi_app_open_details",
          run_mode: "sameSession",
        }),
      }));
      expect(replay).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("advertises ciOnly for mutation tools and routes private tool execution through isolated replay", async () => {
    const url = "https://app.example.test/settings";
    browserBroker.requestConsent(url);
    browserBroker.registerTabs([{ tab_id: "tab-a", url, active: true }]);
    browserBroker.selectTab("tab-a");
    expect(browserBroker.startTeachMode("tab-a").ok).toBe(true);
    registerSourceToken("settings.save");
    browserBroker.recordHumanAction({
      tab_id: "tab-a",
      url,
      origin: "https://app.example.test",
      action: "click",
      element: { role: "button", name: "Save settings", source_id: "settings.save" },
      locator_candidates: [
        { kind: "role", locator: "page.getByRole(\"button\", { name: \"Save settings\" })", confidence: 0.98, reason: "role" },
      ],
    });

    const published = await dispatchBrowserTool("synthi_browser_publish_private_tool", {});
    expect(published?.isError).toBeUndefined();
    const manifest = (published?.structuredContent as { manifest: ReturnType<typeof generatePrivateWorkflowToolManifest> }).manifest;

    const tool = browserPrivateWorkflowTools().find((candidate) => candidate.name === manifest.tool_name);
    expect(tool?.inputSchema.properties?.["run_mode"]).toEqual(expect.objectContaining({
      enum: expect.arrayContaining(["prefixOnly", "confirmBeforeCommit", "ciOnly"]),
    }));

    const run = await dispatchBrowserTool(manifest.tool_name, {
      run_mode: "ciOnly",
      workspace_id: "manifest-tests",
    });

    expect(run?.isError).toBeUndefined();
    expect(run?.structuredContent).toEqual(expect.objectContaining({
      ok: false,
      private_tool: expect.objectContaining({
        tool_name: manifest.tool_name,
        run_mode: "ciOnly",
      }),
      replay: expect.objectContaining({
        status: "blocked",
        failure_class: "mutationBlocked",
        mutation_executed: false,
      }),
    }));
  });
});

function event(overrides: Partial<BrowserTraceEvent>): BrowserTraceEvent {
  registerSourceFromEvent(overrides);
  return {
    event_id: "evt",
    trace_id: "trace",
    trace_version: 1,
    event_seq: 1,
    ts: 1,
    tab_id: "tab",
    origin: "https://app.example.test",
    url: "https://app.example.test/settings",
    kind: "human_action",
    ...overrides,
  };
}

function registerSourceFromEvent(event: Partial<BrowserTraceEvent>): void {
  const element = event.detail?.["element"];
  if (!element || typeof element !== "object" || Array.isArray(element)) return;
  const sourceId = (element as { source_id?: unknown }).source_id;
  if (typeof sourceId !== "string" || sourceId.length === 0) return;
  registerSourceToken(sourceId);
}

function registerSourceToken(token: string): void {
  const filePath = `src/${token}.tsx`;
  sourceIdentityRegistry.register({
    workspaceId: "manifest-tests",
    filePath,
    adapter: "unit-test",
    transformVersion: "unit_source_identity_v1",
    tokens: [{ token, file: filePath, tag: "button", line: 1, column: 1 }],
  });
}

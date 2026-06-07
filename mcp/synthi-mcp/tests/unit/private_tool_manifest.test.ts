import { beforeEach, describe, expect, it } from "vitest";
import { browserBroker } from "../../src/browser/broker.js";
import { generatePrivateWorkflowToolManifest } from "../../src/browser/private_tool_manifest.js";
import { sourceIdentityRegistry } from "../../src/browser/source_identity.js";
import { compileWorkflowContract } from "../../src/browser/workflow.js";
import type { BrowserTraceEvent } from "../../src/browser/types.js";
import { dispatchBrowserTool } from "../../src/tools/browser.js";

beforeEach(() => {
  browserBroker.resetForTests();
  sourceIdentityRegistry.resetForTests();
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

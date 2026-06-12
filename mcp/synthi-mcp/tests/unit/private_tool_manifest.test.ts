import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { authCheckpointManager } from "../../src/browser/auth.js";
import { browserBroker } from "../../src/browser/broker.js";
import { dojoSkillRegistry } from "../../src/browser/dojo.js";
import { generatePrivateWorkflowToolManifest } from "../../src/browser/private_tool_manifest.js";
import {
  EncryptedFilePrivateWorkflowToolStore,
  InMemoryPrivateWorkflowToolStore,
  privateWorkflowToolDefinition,
  privateWorkflowToolParameterArgNames,
  privateWorkflowToolRegistry,
} from "../../src/browser/private_tool_registry.js";
import { browserPlaywrightAdapter } from "../../src/browser/playwright_adapter.js";
import { sourceIdentityRegistry } from "../../src/browser/source_identity.js";
import { compileWorkflowContract } from "../../src/browser/workflow.js";
import type { BrowserTraceEvent } from "../../src/browser/types.js";
import { createSynthiServer } from "../../src/server.js";
import { browserPrivateWorkflowTools, dispatchBrowserTool } from "../../src/tools/browser.js";

beforeEach(() => {
  privateWorkflowToolRegistry.useStoreForTests(new InMemoryPrivateWorkflowToolStore());
  browserBroker.resetForTests();
  authCheckpointManager.resetForTests();
  privateWorkflowToolRegistry.resetForTests();
  dojoSkillRegistry.resetForTests();
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
      run_modes: ["sameSession", "coldSession", "prefixOnly"],
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

  it("advertises target origins needed for popup and cross-origin replay", () => {
    const workflow = compileWorkflowContract([
      event({
        event_id: "open-popup",
        event_seq: 1,
        tab_id: "main",
        origin: "https://app.example.test",
        url: "https://app.example.test/settings",
        action: "click",
        detail: {
          element: { role: "button", name: "Open billing", source_id: "s_open_billing" },
          popup_event: true,
          popup_tab_id: "popup",
          popup_origin: "https://billing.example.test",
          popup_url: "https://billing.example.test/account",
          popup_origin_approved: true,
          popup_screenshot_approved: true,
        },
        security: {
          exact_origin_approved: true,
          screenshot_approved: true,
          diagnostics_approved: false,
          auth_checkpoint_approved: false,
          popup_origin_approved: true,
          popup_screenshot_approved: true,
        },
      }),
      event({
        event_id: "fill-popup",
        event_seq: 2,
        tab_id: "popup",
        origin: "https://billing.example.test",
        url: "https://billing.example.test/account",
        action: "fill",
        value: "Ops Ledger",
        detail: {
          element: { role: "textbox", label: "Account", source_id: "s_account" },
          popup_context: true,
          popup_tab_id: "popup",
          opener_tab_id: "main",
          opener_origin: "https://app.example.test",
        },
        security: {
          exact_origin_approved: true,
          screenshot_approved: true,
          diagnostics_approved: false,
          auth_checkpoint_approved: false,
        },
      }),
    ]);

    const manifest = generatePrivateWorkflowToolManifest(workflow.contract);

    expect(manifest.target_origins).toEqual([
      expect.objectContaining({
        origin: "https://app.example.test",
        primary: true,
        kinds: ["page"],
        step_ids: ["open-popup"],
        screenshot_consent_required: true,
      }),
      expect.objectContaining({
        origin: "https://billing.example.test",
        primary: false,
        kinds: ["popup"],
        step_ids: ["fill-popup", "open-popup"],
        screenshot_consent_required: true,
        approved_during_teach: true,
      }),
    ]);
    expect(manifest.safety.failure_classes).toContain("originConsentMissing");
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
    expect(manifest.run_modes).toEqual(["prefixOnly", "coldSession", "confirmBeforeCommit", "ciOnly"]);
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

  it("keeps private tool control arguments separate from legacy colliding parameters", () => {
    const workflow = compileWorkflowContract([
      event({
        event_id: "run-mode",
        event_seq: 1,
        action: "fill",
        value: "agent-value",
        detail: { element: { role: "textbox", label: "Run mode", source_id: "s_run_mode" } },
        locator_candidates: [
          { kind: "label", locator: "page.getByLabel(\"Run mode\")", confidence: 0.96, reason: "form_label" },
        ],
      }),
    ]);
    const manifest = generatePrivateWorkflowToolManifest(workflow.contract);
    const legacyManifest = {
      ...manifest,
      parameters: [
        { ...manifest.parameters[0]!, name: "run_mode", label: "Run mode" },
        { ...manifest.parameters[0]!, name: "workflow_run_mode", label: "Workflow run mode" },
      ],
    };
    const argNames = privateWorkflowToolParameterArgNames(legacyManifest);
    const tool = privateWorkflowToolDefinition({
      workflow_id: legacyManifest.workflow_id,
      tool_name: "synthi_app_legacy_control_collision",
      manifest: legacyManifest,
      registered_at: Date.now(),
    });

    expect(argNames.get("run_mode")).toBe("workflow_run_mode");
    expect(argNames.get("workflow_run_mode")).toBe("workflow_run_mode_2");
    expect(tool.inputSchema.properties?.["run_mode"]).toEqual(expect.objectContaining({
      enum: ["sameSession", "prefixOnly", "coldSession"],
    }));
    expect(tool.inputSchema.properties?.["artifact_root"]).toEqual(expect.objectContaining({
      type: "string",
      description: expect.stringContaining("ciOnly replay reports"),
    }));
    expect(tool.inputSchema.properties?.["workflow_run_mode"]).toEqual(expect.objectContaining({
      type: "string",
      description: expect.stringContaining("workflow parameter: run_mode"),
    }));
    expect(tool.inputSchema.properties?.["workflow_run_mode_2"]).toEqual(expect.objectContaining({
      type: "string",
      description: expect.stringContaining("workflow parameter: workflow_run_mode"),
    }));
    expect(tool.inputSchema.required).toEqual(["proof_capsule", "workflow_run_mode", "workflow_run_mode_2"]);
  });

  it("keeps same-name parameters separate when they target different source identities", () => {
    const workflow = compileWorkflowContract([
      event({
        event_id: "invoice-a",
        event_seq: 1,
        action: "click",
        detail: {
          option_select_event: true,
          selected: true,
          option_value: "Invoice A",
          listbox_name: "Invoice queue",
          element: { role: "option", name: "Invoice A", source_id: "invoice.a" },
        },
        locator_candidates: [
          { kind: "role", locator: "page.getByRole(\"option\", { name: \"Invoice A\" })", confidence: 0.96, reason: "role" },
        ],
      }),
      event({
        event_id: "invoice-c",
        event_seq: 2,
        action: "click",
        detail: {
          option_select_event: true,
          selected: true,
          option_value: "Invoice C",
          listbox_name: "Invoice queue",
          element: { role: "option", name: "Invoice C", source_id: "invoice.c" },
        },
        locator_candidates: [
          { kind: "role", locator: "page.getByRole(\"option\", { name: \"Invoice C\" })", confidence: 0.96, reason: "role" },
        ],
      }),
    ]);

    const manifest = generatePrivateWorkflowToolManifest(workflow.contract);

    expect(workflow.contract.parameters.map((parameter) => parameter.name)).toEqual(["invoice_queue", "invoice_queue_2"]);
    expect(workflow.contract.steps.map((step) => step.action.valueRef)).toEqual(["invoice_queue", "invoice_queue_2"]);
    expect(manifest.parameters.map((parameter) => parameter.name)).toEqual(["invoice_queue", "invoice_queue_2"]);
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
    const storedAuth = authCheckpointManager.saveStorageArtifact({
      checkpoint_id: checkpoint.checkpoint.checkpoint_id,
      storage_state: {
        cookies: [],
        origins: [
          {
            origin: "https://secure.example.test",
            localStorage: [{ name: "session", value: "approved-session" }],
            sessionStorage: [],
          },
        ],
      },
    });
    expect(storedAuth.ok).toBe(true);
    expect(browserBroker.activateAuthCheckpointForTeach({
      app_origin: url,
      checkpoint_id: checkpoint.checkpoint.checkpoint_id,
    }).ok).toBe(true);
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
      mint_command: await writeRefreshMintCommand(await mkdtemp(path.join(os.tmpdir(), "synthi-private-tool-refresh-"))),
      mint_command_admin_approved: true,
    });
    expect(provider.ok).toBe(true);
    if (!provider.ok) throw new Error("unexpected provider failure");
    await authCheckpointManager.testRefreshProvider(provider.provider.provider_id);

    const available = await dispatchBrowserTool("synthi_browser_generate_private_tool_manifest", {});
    expect(available?.isError).toBeUndefined();
    const availableManifest = (available?.structuredContent as { manifest: { status: string; auth: { durability: string; unattended_ready: boolean }; safety: { notes: string[]; failure_classes: string[] } } }).manifest;
    expect(availableManifest).toEqual(expect.objectContaining({
      status: "available",
      auth: expect.objectContaining({
        durability: "refreshProvider",
        unattended_ready: true,
      }),
    }));
    expect(availableManifest.safety.notes.join(" ")).toContain("Validated auth provider is ready");
    expect(availableManifest.safety.notes.join(" ")).not.toMatch(/not configured for unattended|Do not mark this tool unattended durable/i);
    expect(availableManifest.safety.failure_classes).toContain("authRefreshFailed");
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
        description: expect.stringContaining("cannot be called directly"),
        inputSchema: expect.objectContaining({
          type: "object",
          required: ["proof_capsule"],
          properties: expect.objectContaining({
            proof_capsule: expect.objectContaining({ type: "object" }),
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
    attachHostedRuntimeForTest(url);

    const response = await dispatchBrowserTool("synthi_app_open_details", {});

    expect(response?.isError).toBe(true);
    expect(response?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_proof_capsule_required",
      tool_name: "synthi_app_open_details",
      required_tool: "synthi_dojo_run_with_proof_capsule",
    }));
    expect(replay).not.toHaveBeenCalled();
  });

  it("tells agents which target origins need consent before a private tool replay", async () => {
    const url = "https://app.example.test/settings";
    const popupOrigin = "https://billing.example.test";
    browserBroker.requestConsent(url);
    browserBroker.requestConsent(popupOrigin);
    browserBroker.registerTabs([{ tab_id: "tab-a", url, active: true }]);
    browserBroker.selectTab("tab-a");
    expect(browserBroker.startTeachMode("tab-a").ok).toBe(true);
    registerSourceToken("s_open_billing");
    browserBroker.recordHumanAction({
      tab_id: "tab-a",
      url,
      origin: "https://app.example.test",
      action: "click",
      element: { role: "button", name: "Open billing", source_id: "s_open_billing" },
      detail: {
        popup_event: true,
        popup_tab_id: "popup-a",
        popup_origin: popupOrigin,
        popup_url: `${popupOrigin}/account`,
        popup_origin_approved: true,
        popup_screenshot_approved: true,
      },
      security: {
        exact_origin_approved: true,
        screenshot_approved: true,
        diagnostics_approved: false,
        auth_checkpoint_approved: false,
        popup_origin_approved: true,
        popup_screenshot_approved: true,
      },
      locator_candidates: [
        { kind: "role", locator: "page.getByRole(\"button\", { name: \"Open billing\" })", confidence: 0.98, reason: "role" },
      ],
    });

    const published = await dispatchBrowserTool("synthi_browser_publish_private_tool", {});
    expect(published?.isError).toBeUndefined();
    const toolName = (published?.structuredContent as { tool_name: string }).tool_name;
    browserBroker.revokeConsent(popupOrigin, "later-agent-session-missing-popup-consent");
    const replay = vi.spyOn(browserPlaywrightAdapter, "replayActionEvent").mockResolvedValue({
      ok: true,
      action: "click",
      tab_id: "tab-a",
      url,
    });

    const blocked = await dispatchBrowserTool(toolName, {});

    expect(blocked?.isError).toBe(true);
    expect(blocked?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_proof_capsule_required",
      required_tool: "synthi_dojo_run_with_proof_capsule",
      issue_capsule_tool: "synthi_dojo_issue_proof_capsule",
      blocked_by: ["direct_private_workflow_tool_call"],
    }));
    expect(replay).not.toHaveBeenCalled();
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
      error: "dojo_proof_capsule_required",
      tool_name: "synthi_app_save_settings",
      required_tool: "synthi_dojo_run_with_proof_capsule",
      issue_capsule_tool: "synthi_dojo_issue_proof_capsule",
    }));

    const blockedBooleanOnly = await dispatchBrowserTool("synthi_app_save_settings", {
      run_mode: "sameSession",
      confirm_mutation: true,
    });
    expect(blockedBooleanOnly?.isError).toBe(true);
    expect(blockedBooleanOnly?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_proof_capsule_required",
    }));

    const replay = vi.spyOn(browserPlaywrightAdapter, "replayActionEvent").mockResolvedValue({
      ok: true,
      action: "click",
      tab_id: "tab-a",
      url,
    });
    attachHostedRuntimeForTest(url);
    const confirmed = await dispatchBrowserTool("synthi_app_save_settings", {
      run_mode: "sameSession",
      confirm_mutation: true,
      mutation_confirmation: "confirm:synthi_app_save_settings:test",
    });

    expect(confirmed?.isError).toBe(true);
    expect(confirmed?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_proof_capsule_required",
      required_tool: "synthi_dojo_run_with_proof_capsule",
    }));
    expect(replay).not.toHaveBeenCalled();
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
      let toolListChangedNotifications = 0;
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        toolListChangedNotifications += 1;
      });
      const beforePublish = await client.listTools();
      expect(beforePublish.tools.map((tool) => tool.name)).not.toContain("synthi_app_open_details");
      expect(beforePublish.tools.map((tool) => tool.name)).toContain("synthi_browser_list_private_tools");

      const publish = await client.callTool({ name: "synthi_browser_publish_private_tool", arguments: {} });
      expect(publish.isError).not.toBe(true);
      expect(JSON.parse(String(publish.content[0]?.text))).toEqual(expect.objectContaining({
        ok: true,
        tool_name: "synthi_app_open_details",
      }));
      await waitForCondition(() => toolListChangedNotifications > 0);

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

      const listedPrivateTools = await client.callTool({ name: "synthi_browser_list_private_tools", arguments: {} });
      expect(listedPrivateTools.isError).not.toBe(true);
      expect(JSON.parse(String(listedPrivateTools.content[0]?.text))).toEqual(expect.objectContaining({
        ok: true,
        count: 1,
        tools: expect.arrayContaining([
          expect.objectContaining({
            tool_name: "synthi_app_open_details",
            workflow_id: expect.any(String),
            run_modes: ["sameSession", "prefixOnly", "coldSession"],
            default_run_mode: "sameSession",
            tool: expect.objectContaining({
              name: "synthi_app_open_details",
              inputSchema: expect.objectContaining({
                properties: expect.objectContaining({
                  run_mode: expect.objectContaining({ enum: ["sameSession", "prefixOnly", "coldSession"] }),
                }),
              }),
            }),
          }),
        ]),
      }));

      attachHostedRuntimeForTest(url);
      const run = await client.callTool({ name: "synthi_app_open_details", arguments: {} });
      expect(run.isError).toBe(true);
      expect(JSON.parse(String(run.content[0]?.text))).toEqual(expect.objectContaining({
        error: "dojo_proof_capsule_required",
        required_tool: "synthi_dojo_run_with_proof_capsule",
        tool_name: "synthi_app_open_details",
      }));
      expect(replay).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("tells strict agents to attach the hosted runtime before browser-backed private tool replay", async () => {
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

    const response = await dispatchBrowserTool("synthi_app_open_details", {});

    expect(response?.isError).toBe(true);
    expect(response?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_proof_capsule_required",
      tool_name: "synthi_app_open_details",
      required_tool: "synthi_dojo_run_with_proof_capsule",
      product_path: "agent_to_dojo_license_kernel_to_proof_validator_to_private_workflow_tool",
    }));
    expect(JSON.stringify(response?.structuredContent)).not.toContain("SYNTHI_BROWSER_CDP_URL=");
  });

  it("rejects invalid private tool run modes instead of coercing them", async () => {
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

    const published = await dispatchBrowserTool("synthi_browser_publish_private_tool", {});
    expect(published?.isError).toBeUndefined();
    const response = await dispatchBrowserTool("synthi_app_open_details", { run_mode: "desktopChrome" });

    expect(response?.isError).toBe(true);
    expect(response?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_proof_capsule_required",
      required_tool: "synthi_dojo_run_with_proof_capsule",
      tool_name: "synthi_app_open_details",
    }));
    expect(replay).not.toHaveBeenCalled();
  });

  it("persists published private tools with encrypted workflow artifacts for later MCP discovery", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "synthi-private-tools-"));
    const filePath = path.join(directory, "private-tools.enc.json");
    privateWorkflowToolRegistry.useStoreForTests(new EncryptedFilePrivateWorkflowToolStore({
      file_path: filePath,
      key: "unit-test-private-tool-key",
      scope_id: "tenant-a:workspace-a",
    }));
    privateWorkflowToolRegistry.resetForTests();

    const url = "https://app.example.test/settings";
    browserBroker.requestConsent(url);
    browserBroker.registerTabs([{ tab_id: "tab-a", url, active: true }]);
    browserBroker.selectTab("tab-a");
    expect(browserBroker.startTeachMode("tab-a").ok).toBe(true);
    registerSourceToken("s_token");
    browserBroker.recordHumanAction({
      tab_id: "tab-a",
      url,
      origin: "https://app.example.test",
      action: "fill",
      value: "secret-value-that-must-not-be-plaintext",
      element: { role: "textbox", label: "Access token", source_id: "s_token" },
      locator_candidates: [
        { kind: "label", locator: "page.getByLabel(\"Access token\")", confidence: 0.98, reason: "form_label" },
      ],
    });

    const publish = await dispatchBrowserTool("synthi_browser_publish_private_tool", {});
    expect(publish?.isError).toBeUndefined();
    const publishedToolName = (publish?.structuredContent as { tool_name: string }).tool_name;

    const persisted = await readFile(filePath, "utf8");
    expect(persisted).toContain("synthi_private_workflow_tool_store_envelope_v1");
    expect(persisted).not.toMatch(/app\.example|Access token|secret-value-that-must-not-be-plaintext|tenant-a|workspace-a/);
    if (process.platform !== "win32") {
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    }
    expect((await readdir(directory)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);

    browserBroker.resetForTests();
    privateWorkflowToolRegistry.useStoreForTests(new EncryptedFilePrivateWorkflowToolStore({
      file_path: filePath,
      key: "unit-test-private-tool-key",
      scope_id: "tenant-a:workspace-a",
    }));
    browserBroker.requestConsent(url);
    browserBroker.registerTabs([{ tab_id: "tab-b", url, active: true }]);
    browserBroker.selectTab("tab-b");
    attachHostedRuntimeForTest(url);
    const replay = vi.spyOn(browserPlaywrightAdapter, "replayActionEvent").mockResolvedValue({
      ok: true,
      action: "fill",
      tab_id: "tab-b",
      url,
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createSynthiServer({ defaultSignalingUrl: "ws://localhost:9000" });
    const client = new Client({ name: "workflow-persisted-acceptance-test", version: "0.0.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tools = await client.listTools();
      expect(tools.tools).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: publishedToolName,
          inputSchema: expect.objectContaining({
            properties: expect.objectContaining({
              access_token: expect.objectContaining({ format: "password" }),
            }),
          }),
        }),
      ]));

      const manifestLookup = await client.callTool({
        name: "synthi_browser_get_private_tool_manifest",
        arguments: { tool_name: publishedToolName },
      });
      expect(manifestLookup.isError).not.toBe(true);
      const lookupBody = JSON.parse(String(manifestLookup.content[0]?.text));
      expect(lookupBody).toEqual(expect.objectContaining({
        ok: true,
        tool_name: publishedToolName,
        workflow_id: expect.any(String),
        manifest: expect.objectContaining({
          tool_name: publishedToolName,
          parameters: expect.arrayContaining([
            expect.objectContaining({
              name: "access_token",
              redacted: true,
              value_shape: "secret",
            }),
          ]),
        }),
        tool: expect.objectContaining({
          name: publishedToolName,
          inputSchema: expect.objectContaining({
            properties: expect.objectContaining({
              access_token: expect.objectContaining({ format: "password" }),
            }),
          }),
        }),
      }));
      expect(JSON.stringify(lookupBody)).not.toMatch(/secret-value-that-must-not-be-plaintext/);

      const run = await client.callTool({
        name: publishedToolName,
        arguments: { access_token: "agent-supplied-value" },
      });
      expect(run.isError).toBe(true);
      expect(JSON.parse(String(run.content[0]?.text))).toEqual(expect.objectContaining({
        error: "dojo_proof_capsule_required",
        required_tool: "synthi_dojo_run_with_proof_capsule",
        tool_name: publishedToolName,
      }));
      expect(replay).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("works behind a strict MCP host that validates the advertised private tool schema", async () => {
    const url = "https://app.example.test/settings";
    browserBroker.requestConsent(url);
    browserBroker.registerTabs([{ tab_id: "tab-a", url, active: true }]);
    browserBroker.selectTab("tab-a");
    attachHostedRuntimeForTest(url);
    expect(browserBroker.startTeachMode("tab-a").ok).toBe(true);
    registerSourceToken("s_token");
    browserBroker.recordHumanAction({
      tab_id: "tab-a",
      url,
      origin: "https://app.example.test",
      action: "fill",
      value: "secret-value-that-must-not-be-plaintext",
      element: { role: "textbox", label: "Access token", source_id: "s_token" },
      locator_candidates: [
        { kind: "label", locator: "page.getByLabel(\"Access token\")", confidence: 0.98, reason: "form_label" },
      ],
    });
    const replay = vi.spyOn(browserPlaywrightAdapter, "replayActionEvent").mockResolvedValue({
      ok: true,
      action: "fill",
      tab_id: "tab-a",
      url,
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createSynthiServer({ defaultSignalingUrl: "ws://localhost:9000" });
    const client = new Client({ name: "strict-host-private-tool-test", version: "0.0.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const publish = await client.callTool({ name: "synthi_browser_publish_private_tool", arguments: {} });
      expect(publish.isError).not.toBe(true);
      const toolName = JSON.parse(String(publish.content[0]?.text)).tool_name;
      const listed = await client.listTools();
      const privateTool = listed.tools.find((tool) => tool.name === toolName);
      expect(privateTool?.inputSchema).toEqual(expect.objectContaining({
        type: "object",
        required: ["proof_capsule", "access_token"],
        additionalProperties: false,
        properties: expect.objectContaining({
          proof_capsule: expect.objectContaining({ type: "object" }),
          access_token: expect.objectContaining({ type: "string", format: "password" }),
          run_mode: expect.objectContaining({ enum: ["sameSession", "prefixOnly", "coldSession"] }),
        }),
      }));

      expect(await strictHostCallTool(client, privateTool, {})).toEqual(expect.objectContaining({
        ok: false,
        errors: expect.arrayContaining(["missing_required:proof_capsule", "missing_required:access_token"]),
      }));
      expect(await strictHostCallTool(client, privateTool, {
        access_token: "agent-supplied-value",
        script_path: "/tmp/brittle/generated.spec.ts",
      })).toEqual(expect.objectContaining({
        ok: false,
        errors: expect.arrayContaining(["missing_required:proof_capsule", "additional_property:script_path"]),
      }));
      expect(await strictHostCallTool(client, privateTool, {
        access_token: "agent-supplied-value",
        run_mode: "desktopChrome",
      })).toEqual(expect.objectContaining({
        ok: false,
        errors: expect.arrayContaining(["missing_required:proof_capsule", "enum:run_mode"]),
      }));
      expect(replay).not.toHaveBeenCalled();

      const run = await strictHostCallTool(client, privateTool, {
        proof_capsule: { schema_version: "synthi.dojo.proofCapsule.v1" },
        access_token: "agent-supplied-value",
        run_mode: "sameSession",
      });

      expect(run.ok).toBe(true);
      expect(run.result?.isError).toBe(true);
      expect(JSON.parse(String(run.result?.content[0]?.text))).toEqual(expect.objectContaining({
        error: "dojo_proof_capsule_required",
        required_tool: "synthi_dojo_run_with_proof_capsule",
        tool_name: toolName,
      }));
      expect(replay).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("advertises ciOnly for mutation backing tools while direct execution remains proof-gated", async () => {
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
    expect(tool?.inputSchema.properties?.["mutation_confirmation"]).toEqual(expect.objectContaining({
      type: "string",
    }));

    const run = await dispatchBrowserTool(manifest.tool_name, {
      run_mode: "ciOnly",
      workspace_id: "manifest-tests",
    });

    expect(run?.isError).toBe(true);
    expect(run?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_proof_capsule_required",
      tool_name: manifest.tool_name,
      required_tool: "synthi_dojo_run_with_proof_capsule",
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

function attachHostedRuntimeForTest(workspaceUrl: string): void {
  browserBroker.setRuntimeAttachment({
    kind: "hosted",
    workspace_id: "manifest-tests",
    runtime_id: null,
    workspace_url: workspaceUrl,
    adapter: "hosted-playwright-cdp",
  });
}

async function strictHostCallTool(
  client: Client,
  tool: { name: string; inputSchema?: unknown } | undefined,
  args: Record<string, unknown>
): Promise<{ ok: false; errors: string[] } | { ok: true; result: Awaited<ReturnType<Client["callTool"]>> }> {
  if (!tool) return { ok: false, errors: ["tool_not_listed"] };
  const errors = strictHostValidateToolArgs(tool.inputSchema, args);
  if (errors.length > 0) return { ok: false, errors };
  const result = await client.callTool({ name: tool.name, arguments: args });
  return { ok: true, result };
}

function strictHostValidateToolArgs(schema: unknown, args: Record<string, unknown>): string[] {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return ["schema_not_object"];
  const objectSchema = schema as {
    type?: unknown;
    properties?: unknown;
    required?: unknown;
    additionalProperties?: unknown;
  };
  const errors: string[] = [];
  if (objectSchema.type !== "object") errors.push("schema_type_not_object");
  const properties = objectSchema.properties && typeof objectSchema.properties === "object" && !Array.isArray(objectSchema.properties)
    ? objectSchema.properties as Record<string, unknown>
    : {};
  const required = Array.isArray(objectSchema.required)
    ? objectSchema.required.filter((item): item is string => typeof item === "string")
    : [];
  for (const name of required) {
    if (!Object.prototype.hasOwnProperty.call(args, name)) errors.push(`missing_required:${name}`);
  }
  if (objectSchema.additionalProperties === false) {
    for (const name of Object.keys(args)) {
      if (!Object.prototype.hasOwnProperty.call(properties, name)) errors.push(`additional_property:${name}`);
    }
  }
  for (const [name, value] of Object.entries(args)) {
    const property = properties[name];
    if (!property || typeof property !== "object" || Array.isArray(property)) continue;
    const propertySchema = property as { type?: unknown; enum?: unknown; pattern?: unknown };
    if (propertySchema.type === "string" && typeof value !== "string") errors.push(`type:${name}`);
    if (propertySchema.type === "boolean" && typeof value !== "boolean") errors.push(`type:${name}`);
    if (propertySchema.type === "number" && typeof value !== "number") errors.push(`type:${name}`);
    if (Array.isArray(propertySchema.enum) && !propertySchema.enum.includes(value)) errors.push(`enum:${name}`);
    if (typeof propertySchema.pattern === "string" && typeof value === "string") {
      const pattern = new RegExp(propertySchema.pattern);
      if (!pattern.test(value)) errors.push(`pattern:${name}`);
    }
  }
  return errors;
}

async function writeRefreshMintCommand(directory: string): Promise<string> {
  const scriptPath = path.join(directory, `mint-refresh-${Date.now()}.mjs`);
  await writeFile(scriptPath, `
const origin = process.env.SYNTHI_AUTH_APP_ORIGIN;
if (!origin || !process.env.SYNTHI_AUTH_SECRET_REF) process.exit(2);
const host = new URL(origin).hostname;
const output = JSON.stringify({
  ok: true,
  storage_state: {
    cookies: [{ name: "sid", value: "private-tool-cookie-secret", domain: host, path: "/", httpOnly: true, secure: true }],
    origins: [{ origin, localStorage: [{ name: "session", value: "private-tool-local-secret" }], sessionStorage: [] }]
  },
  ttl_ms: 60000
});
if (process.env.SYNTHI_AUTH_PROVIDER_OUTPUT_PATH) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(process.env.SYNTHI_AUTH_PROVIDER_OUTPUT_PATH, output);
}
process.stdout.write(output);
`, "utf8");
  return `${shellQuote(process.execPath)} ${shellQuote(scriptPath)}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition_timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

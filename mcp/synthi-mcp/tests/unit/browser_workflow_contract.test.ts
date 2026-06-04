import { beforeEach, describe, expect, it } from "vitest";
import { browserBroker } from "../../src/browser/broker.js";
import { classifyWorkflowReplayBlock, classifyWorkflowReplayFailure, compileWorkflowContract, planWorkflowReplay } from "../../src/browser/workflow.js";
import { eventLog } from "../../src/events/index.js";
import { ADVERTISED_TOOLS } from "../../src/tool_registry.js";
import { BROWSER_TOOL_NAMES, dispatchBrowserTool } from "../../src/tools/browser.js";

beforeEach(() => {
  browserBroker.resetForTests();
  eventLog._resetForTests();
});

describe("browser workflow contract compiler", () => {
  it("compiles same-origin teach steps into a workflow card and contract", () => {
    browserBroker.requestConsent("https://app.example.com");
    browserBroker.registerTabs([{ tab_id: "app", url: "https://app.example.com/settings", active: true }]);
    expect(browserBroker.startTeachMode("app").ok).toBe(true);

    browserBroker.recordHumanAction({
      tab_id: "app",
      url: "https://app.example.com/settings",
      origin: "https://app.example.com",
      action: "fill",
      field_name: "Test token",
      value: "dev@example.com",
      element: { label: "Test token", role: "textbox", css: "#token" },
    });
    browserBroker.recordHumanAction({
      tab_id: "app",
      url: "https://app.example.com/settings",
      origin: "https://app.example.com",
      action: "click",
      element: { role: "button", name: "Save workspace state", test_id: "workspace-save" },
    });

    const workflow = browserBroker.compiledWorkflow();

    expect(workflow.card.title).toBe("Save workspace state");
    expect(workflow.card.state).toEqual(expect.arrayContaining(["Draft", "Runnable", "Auth-ready", "Mutation-limited", "Limited"]));
    expect(workflow.card.status).toContain("Background hardening stops before mutation");
    expect(workflow.contract.appOrigin).toBe("https://app.example.com");
    expect(workflow.contract.parameters).toEqual([
      expect.objectContaining({ name: "test_token", valueShape: "email", redacted: false }),
    ]);
    expect(workflow.contract.lane0).toEqual(expect.objectContaining({
      reducer_version: "lane0_deterministic_v1",
      annotated_event_count: 2,
      stale_annotation_count: 0,
    }));
    expect(workflow.contract.steps[0]?.semanticPlan).toEqual(expect.objectContaining({
      groupLabel: "Save workspace state workflow",
      confidence: "high",
    }));
    expect(workflow.contract.mutationBoundaryPlan.firstMutationStepId).toBe("browser_evt_2");
    expect(workflow.contract.mutationBoundaryPlan.defaultReplayMode).toBe("prefixOnly");
    expect(workflow.contract.counterfactualPlan).toEqual(expect.objectContaining({
      mode: "readOnlyPrefix",
      readOnly: true,
      stopsBeforeStepId: "browser_evt_2",
    }));
    expect(workflow.contract.counterfactualPlan.profiles).toContainEqual(expect.objectContaining({
      name: "desktop",
      enabled: true,
      replayMode: "prefixOnly",
    }));
    expect(workflow.contract.sourceIdentityCoverage.status).toBe("missing");
    expect(workflow.contract.sourceAffordancePatches).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stepId: "browser_evt_2",
        reason: "mutationBoundary",
        suggestedAttribute: "data-synthi-mutation-boundary=\"save.workspace.state\"",
      }),
    ]));
    expect(workflow.contract.publishPlan).toEqual(expect.objectContaining({
      privateToolName: "synthi_app_save_workspace_state",
      readiness: "manualOnly",
      unattendedReady: false,
      mutationMode: "confirmBeforeCommit",
    }));
    expect(workflow.contract.publishPlan.runModes).toEqual(["prefixOnly", "confirmBeforeCommit", "ciOnly"]);
    expect(workflow.contract.generatedOutputs[2]).toEqual(expect.objectContaining({
      kind: "privateMcpToolManifest",
      status: "available",
    }));
    expect(workflow.contract.limitations).toContain("sourceIdentityMissing");
    expect(workflow.contract.limitations).toContain("mutationRequiresIsolation");
    expect(workflow.contract.failureClasses).toEqual(expect.arrayContaining(["locatorDrift", "mutationBlocked", "sourceIdentityMissing"]));
    expect(workflow.contract.generatedOutputs[0]).toEqual(expect.objectContaining({ kind: "playwright", status: "available" }));
    expect(workflow.contract.generatedOutputs[1]).toEqual(expect.objectContaining({ kind: "sourceAffordancePatch", status: "available" }));
  });

  it("marks redacted inputs as secret parameters without leaking values", () => {
    const workflow = compileWorkflowContract([
      {
        event_id: "secret",
        trace_id: "trace",
        trace_version: 1,
        event_seq: 1,
        ts: 1,
        tab_id: "tab",
        origin: "https://app.example.com",
        url: "https://app.example.com",
        kind: "human_action",
        action: "fill",
        value: "[REDACTED]",
        redacted: true,
        detail: {
          field_name: "API token",
          element: { label: "API token", role: "textbox" },
        },
        locator_candidates: [
          { kind: "label", locator: "page.getByLabel(\"API token\")", confidence: 0.94, reason: "form_label" },
        ],
      },
    ]);

    expect(JSON.stringify(workflow)).not.toContain("sk-live");
    expect(workflow.contract.parameters[0]).toEqual(expect.objectContaining({
      name: "api_token",
      valueShape: "secret",
      redacted: true,
    }));
    expect(workflow.contract.limitations).toContain("redactedInputValue");
  });

  it("surfaces cross-origin traces as limited instead of silently compiling them as durable", () => {
    const workflow = compileWorkflowContract([
      baseEvent({ event_id: "one", event_seq: 1, origin: "https://app.example.com", url: "https://app.example.com" }),
      baseEvent({ event_id: "two", event_seq: 2, origin: "https://billing.example.com", url: "https://billing.example.com/pay" }),
    ]);

    expect(workflow.contract.limitations).toContain("crossOriginTrace");
    expect(workflow.card.state).toContain("Limited");
  });

  it("blocks same-tab replay for popup and multi-tab traces", () => {
    const events = [
      baseEvent({ event_id: "main", event_seq: 1, tab_id: "main", detail: { element: { role: "button", name: "Open billing" } } }),
      baseEvent({
        event_id: "popup",
        event_seq: 2,
        tab_id: "popup",
        origin: "https://billing.example.com",
        url: "https://billing.example.com/pay",
        detail: { surface: "popup", element: { role: "button", name: "Continue" } },
      }),
    ];

    const workflow = compileWorkflowContract(events);
    const replay = planWorkflowReplay(events, "sameSession");

    expect(workflow.contract.limitations).toEqual(expect.arrayContaining(["crossOriginTrace", "popupOrMultiTab"]));
    expect(workflow.contract.mutationBoundaryPlan.defaultReplayMode).toBe("blocked");
    expect(workflow.contract.replayModes).toEqual([]);
    expect(workflow.contract.generatedOutputs[0]).toEqual(expect.objectContaining({ kind: "playwright", status: "blocked" }));
    expect(workflow.contract.publishPlan).toEqual(expect.objectContaining({
      readiness: "blocked",
      unattendedReady: false,
    }));
    expect(workflow.contract.generatedOutputs[2]).toEqual(expect.objectContaining({
      kind: "privateMcpToolManifest",
      status: "blocked",
    }));
    expect(workflow.card.state).toEqual(expect.arrayContaining(["Blocked", "Limited"]));
    expect(replay.status).toBe("blocked");
    expect(replay.warnings[0]).toContain("popup or multi-tab");
    expect(classifyWorkflowReplayBlock(replay)).toBe("unsafeEnvironment");
  });

  it("blocks iframe traces that lack a durable frame locator", () => {
    const events = [
      baseEvent({
        event_id: "card",
        frame_id: "checkout-frame",
        detail: { element: { role: "textbox", label: "Cardholder" } },
      }),
    ];

    const workflow = compileWorkflowContract(events);
    const replay = planWorkflowReplay(events, "prefixOnly");

    expect(workflow.contract.steps[0]?.limitations).toContain("iframeNeedsFrameLocator");
    expect(workflow.contract.mutationBoundaryPlan.defaultReplayMode).toBe("blocked");
    expect(replay.status).toBe("blocked");
    expect(classifyWorkflowReplayBlock(replay)).toBe("locatorDrift");
  });

  it("surfaces coordinate and pointer limitations without marking them hardened", () => {
    const workflow = compileWorkflowContract([
      baseEvent({
        event_id: "chart",
        event_seq: 1,
        detail: {
          pointer_drag: true,
          element: { tag: "canvas", label: "Revenue chart", source_id: "src_chart" },
        },
      }),
    ]);

    expect(workflow.contract.limitations).toEqual(expect.arrayContaining(["canvasCoordinateOnly", "pointerDragUnreliable"]));
    expect(workflow.contract.failureClasses).toEqual(expect.arrayContaining(["canvasUnreliable", "pointerDragUnreliable"]));
    expect(workflow.contract.steps[0]?.surfacePlan).toEqual(expect.objectContaining({
      kind: "canvas",
      replay: "unsupported",
    }));
    expect(workflow.contract.mutationBoundaryPlan.defaultReplayMode).toBe("sameSession");
    expect(workflow.contract.counterfactualPlan.profiles).toContainEqual(expect.objectContaining({
      name: "mobile",
      enabled: false,
    }));
  });

  it("keeps semantically bridged canvas actions reviewable without coordinate-only durability claims", () => {
    const workflow = compileWorkflowContract([
      baseEvent({
        event_id: "canvas-bridge",
        detail: {
          canvas: true,
          canvas_replay_mode: "semanticBridge",
          element: { tag: "canvas", label: "Node graph", source_id: "src_graph" },
        },
      }),
    ]);

    expect(workflow.contract.limitations).not.toContain("canvasCoordinateOnly");
    expect(workflow.contract.steps[0]?.surfacePlan).toEqual(expect.objectContaining({
      kind: "canvas",
      replay: "durable",
    }));
  });

  it("blocks closed Shadow DOM traces unless a bridge or external affordance exists", () => {
    const events = [
      baseEvent({
        event_id: "shadow",
        detail: {
          closed_shadow_dom: true,
          element: { role: "button", name: "Submit inside component" },
        },
      }),
    ];

    const workflow = compileWorkflowContract(events);
    const replay = planWorkflowReplay(events, "sameSession");

    expect(workflow.contract.limitations).toContain("closedShadowDomBlocked");
    expect(workflow.contract.failureClasses).toContain("closedShadowDomBlocked");
    expect(workflow.contract.generatedOutputs[0]).toEqual(expect.objectContaining({ kind: "playwright", status: "blocked" }));
    expect(replay.status).toBe("blocked");
    expect(classifyWorkflowReplayBlock(replay)).toBe("closedShadowDomBlocked");
  });

  it("allows closed Shadow DOM only when an explicit dev bridge is recorded", () => {
    const workflow = compileWorkflowContract([
      baseEvent({
        event_id: "shadow-bridge",
        detail: {
          closed_shadow_dom: true,
          dev_shadow_bridge: true,
          element: { role: "button", name: "Submit inside component", source_id: "src_shadow" },
        },
      }),
    ]);

    expect(workflow.contract.limitations).not.toContain("closedShadowDomBlocked");
    expect(workflow.contract.steps[0]?.surfacePlan).toEqual(expect.objectContaining({
      kind: "closedShadowDom",
      replay: "sameSessionOnly",
    }));
  });

  it("classifies explicit drag surface replay plans", () => {
    const workflow = compileWorkflowContract([
      baseEvent({
        event_id: "native-drag",
        event_seq: 1,
        action: "drag",
        value: "page.getByRole(\"list\", { name: \"Done\" })",
        detail: {
          drag_class: "nativeHtmlDnd",
          element: { role: "listitem", name: "Task", source_id: "src_task" },
        },
      }),
      baseEvent({
        event_id: "file-drop",
        event_seq: 2,
        action: "drag",
        detail: {
          drag_class: "fileDrop",
          file_parameter: "UPLOAD_FILE",
          element: { role: "button", name: "Upload area", source_id: "src_upload" },
        },
      }),
      baseEvent({
        event_id: "pointer-drag",
        event_seq: 3,
        action: "drag",
        detail: {
          drag_mode: true,
          drag_class: "pointerSensor",
          element: { role: "slider", name: "Budget", source_id: "src_budget" },
        },
      }),
    ]);

    expect(workflow.contract.steps.map((step) => step.surfacePlan.kind)).toEqual([
      "nativeHtmlDrag",
      "fileDrop",
      "pointerDrag",
    ]);
    expect(workflow.contract.steps[0]?.surfacePlan.replay).toBe("durable");
    expect(workflow.contract.steps[1]?.surfacePlan.replay).toBe("parameterized");
    expect(workflow.contract.steps[2]?.limitations).toContain("pointerDragUnreliable");
    expect(workflow.contract.parameters).toContainEqual(expect.objectContaining({
      name: "upload_file",
      sourceStepId: "file-drop",
      valueShape: "filePath",
    }));
  });

  it("marks clean read-only workflows ready for a private MCP tool manifest", () => {
    const workflow = compileWorkflowContract([
      baseEvent({
        event_id: "open-details",
        event_seq: 1,
        action: "click",
        detail: {
          element: { role: "button", name: "Open details", source_id: "src_open_details" },
        },
      }),
    ]);

    expect(workflow.contract.limitations).toEqual([]);
    expect(workflow.contract.publishPlan).toEqual(expect.objectContaining({
      privateToolName: "synthi_app_open_details",
      readiness: "ready",
      unattendedReady: true,
      mutationMode: "readOnly",
      authDurability: "noneRequired",
    }));
    expect(workflow.contract.publishPlan.runModes).toEqual(["sameSession"]);
    expect(workflow.contract.generatedOutputs[2]).toEqual(expect.objectContaining({
      kind: "privateMcpToolManifest",
      status: "available",
    }));
  });

  it("marks checkpoint-only authenticated workflows manual-only for publishing", () => {
    const workflow = compileWorkflowContract([
      baseEvent({
        event_id: "open-billing",
        event_seq: 1,
        action: "click",
        security: {
          exact_origin_approved: true,
          screenshot_approved: true,
          diagnostics_approved: true,
          auth_checkpoint_approved: true,
        },
        detail: {
          element: { role: "button", name: "Open billing", source_id: "src_open_billing" },
        },
      }),
    ]);

    expect(workflow.contract.authPlan).toEqual(expect.objectContaining({
      required: true,
      durability: "interactiveCheckpoint",
    }));
    expect(workflow.card.state).toContain("Auth-ready");
    expect(workflow.contract.publishPlan).toEqual(expect.objectContaining({
      readiness: "manualOnly",
      unattendedReady: false,
      authDurability: "interactiveCheckpoint",
    }));
    expect(workflow.contract.publishPlan.notes.join(" ")).toContain("saved login checkpoint is valid");
  });

  it("allows unattended publishing only with explicit durable auth metadata", () => {
    const workflow = compileWorkflowContract([
      baseEvent({
        event_id: "open-billing",
        event_seq: 1,
        action: "click",
        detail: {
          auth_durability: "refreshProvider",
          element: { role: "button", name: "Open billing", source_id: "src_open_billing" },
        },
      }),
    ]);

    expect(workflow.contract.authPlan).toEqual(expect.objectContaining({
      required: true,
      durability: "refreshProvider",
    }));
    expect(workflow.contract.publishPlan).toEqual(expect.objectContaining({
      readiness: "ready",
      unattendedReady: true,
      authDurability: "refreshProvider",
    }));
  });

  it("plans prefix-only replay up to but not including the first mutation boundary", () => {
    const events = [
      baseEvent({ event_id: "open", event_seq: 1, action: "click", detail: { element: { role: "button", name: "Open form" } } }),
      baseEvent({ event_id: "save", event_seq: 2, action: "click", detail: { element: { role: "button", name: "Save changes" } } }),
      baseEvent({ event_id: "after", event_seq: 3, action: "click", detail: { element: { role: "button", name: "Continue" } } }),
    ];

    const prefix = planWorkflowReplay(events, "prefixOnly");
    const sameSession = planWorkflowReplay(events, "sameSession");
    const coldSession = planWorkflowReplay(events, "coldSession");

    expect(prefix.status).toBe("stoppedAtMutationBoundary");
    expect(prefix.stoppedBeforeStepId).toBe("save");
    expect(prefix.events.map((event) => event.event_id)).toEqual(["open"]);
    expect(coldSession.status).toBe("stoppedAtMutationBoundary");
    expect(coldSession.warnings[0]).toContain("fresh browser context");
    expect(sameSession.status).toBe("ready");
    expect(sameSession.events.map((event) => event.event_id)).toEqual(["open", "save", "after"]);
  });

  it("advertises and dispatches workflow contract tools", async () => {
    expect(BROWSER_TOOL_NAMES).toContain("synthi_browser_compile_workflow");
    expect(BROWSER_TOOL_NAMES).toContain("synthi_browser_run_workflow");
    expect(ADVERTISED_TOOLS).toContain("synthi_browser_compile_workflow");
    expect(ADVERTISED_TOOLS).toContain("synthi_browser_run_workflow");

    const result = await dispatchBrowserTool("synthi_browser_compile_workflow", {});
    expect(result?.isError).toBeUndefined();
    expect((result?.structuredContent as { workflow: { card: { status: string } } }).workflow.card.status).toContain("Blocked");
  });

  it("classifies replay failures by concrete browser boundary", () => {
    expect(classifyWorkflowReplayFailure(new Error("auth checkpoint expired"))).toBe("authExpired");
    expect(classifyWorkflowReplayFailure(new Error("mutation boundary blocked by safety policy"))).toBe("mutationBlocked");
    expect(classifyWorkflowReplayFailure(new Error("canvas replay missing semantic bridge"))).toBe("canvasUnreliable");
    expect(classifyWorkflowReplayFailure(new Error("pointer drag calibration missing"))).toBe("pointerDragUnreliable");
    expect(classifyWorkflowReplayFailure(new Error("closed Shadow DOM not reachable"))).toBe("closedShadowDomBlocked");
  });
});

function baseEvent(overrides: Partial<Parameters<typeof compileWorkflowContract>[0][number]>) {
  return {
    event_id: "evt",
    trace_id: "trace",
    trace_version: 1,
    event_seq: 1,
    ts: 1,
    tab_id: "tab",
    origin: "https://app.example.com",
    url: "https://app.example.com",
    kind: "human_action" as const,
    action: "click" as const,
    detail: {
      element: { role: "button", name: "Continue" },
    },
    locator_candidates: [
      { kind: "role" as const, locator: "page.getByRole(\"button\", { name: \"Continue\" })", confidence: 0.98, reason: "role" },
    ],
    ...overrides,
  };
}

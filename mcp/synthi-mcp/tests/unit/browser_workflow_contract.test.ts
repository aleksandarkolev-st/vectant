import { beforeEach, describe, expect, it } from "vitest";
import { browserBroker } from "../../src/browser/broker.js";
import { sourceIdentityRegistry } from "../../src/browser/source_identity.js";
import { classifyWorkflowReplayBlock, classifyWorkflowReplayFailure, compileWorkflowContract, planWorkflowReplay } from "../../src/browser/workflow.js";
import { eventLog } from "../../src/events/index.js";
import { ADVERTISED_TOOLS } from "../../src/tool_registry.js";
import { BROWSER_TOOL_NAMES, dispatchBrowserTool } from "../../src/tools/browser.js";

beforeEach(() => {
  browserBroker.resetForTests();
  sourceIdentityRegistry.resetForTests();
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

  it("coalesces repeated fills on the same target before the next action", () => {
    browserBroker.requestConsent("https://app.example.com");
    browserBroker.registerTabs([{ tab_id: "app", url: "https://app.example.com/settings", active: true }]);
    expect(browserBroker.startTeachMode("app").ok).toBe(true);

    for (const value of ["t", "to", "tok", "token-final"]) {
      browserBroker.recordHumanAction({
        tab_id: "app",
        url: "https://app.example.com/settings",
        origin: "https://app.example.com",
        action: "fill",
        field_name: "Test token",
        value,
        element: { label: "Test token", role: "textbox", css: "#token" },
      });
    }
    browserBroker.recordHumanAction({
      tab_id: "app",
      url: "https://app.example.com/settings",
      origin: "https://app.example.com",
      action: "click",
      element: { role: "button", name: "Save workspace state", test_id: "workspace-save" },
    });

    const workflow = browserBroker.compiledWorkflow();

    expect(browserBroker.traceSnapshot()).toHaveLength(5);
    expect(workflow.contract.steps).toHaveLength(2);
    expect(workflow.contract.steps.map((step) => step.label)).toEqual([
      "Fill Test token",
      "Click Save workspace state",
    ]);
    expect(workflow.contract.parameters).toEqual([
      expect.objectContaining({ name: "test_token", valueShape: "shortText" }),
    ]);
  });

  it("coalesces browser double-click noise and keeps context-menu actions durable", () => {
    browserBroker.requestConsent("https://app.example.com");
    browserBroker.registerTabs([{ tab_id: "app", url: "https://app.example.com/records", active: true }]);
    expect(browserBroker.startTeachMode("app").ok).toBe(true);

    for (const action of ["dblclick", "click", "click"] as const) {
      browserBroker.recordHumanAction({
        tab_id: "app",
        url: "https://app.example.com/records",
        origin: "https://app.example.com",
        action,
        detail: action === "dblclick" ? { dblclick_event: true } : { click_event: true },
        element: { role: "button", name: "Open record", test_id: "record-open" },
      });
    }
    browserBroker.recordHumanAction({
      tab_id: "app",
      url: "https://app.example.com/records",
      origin: "https://app.example.com",
      action: "contextmenu",
      detail: { contextmenu_event: true },
      element: { role: "row", name: "Open record", test_id: "record-row" },
    });

    const workflow = browserBroker.compiledWorkflow();
    const replay = planWorkflowReplay(browserBroker.traceSnapshot(), "sameSession");

    expect(browserBroker.traceSnapshot()).toHaveLength(4);
    expect(workflow.contract.steps.map((step) => step.label)).toEqual([
      "Double-click Open record",
      "Open context menu for Open record",
    ]);
    expect(replay.events.map((event) => event.action)).toEqual(["dblclick", "contextmenu"]);
  });

  it("annotates the latest taught click with download metadata", () => {
    const url = "https://app.example.com/reports";
    browserBroker.requestConsent(url);
    browserBroker.registerTabs([{ tab_id: "app", url, active: true }]);
    expect(browserBroker.startTeachMode("app").ok).toBe(true);
    expect(browserBroker.recordHumanAction({
      tab_id: "app",
      url,
      origin: "https://app.example.com",
      action: "click",
      element: { role: "link", name: "Download report", test_id: "download-report" },
    }).ok).toBe(true);

    const annotated = browserBroker.annotateLatestHumanAction({
      tab_id: "app",
      url,
      origin: "https://app.example.com",
      actions: ["click"],
      detail: {
        download_event: true,
        suggested_filename: "report.csv",
      },
      within_ms: 5000,
    });

    expect(annotated.ok).toBe(true);
    expect(browserBroker.traceSnapshot()[0]?.detail).toEqual(expect.objectContaining({
      download_event: true,
      suggested_filename: "report.csv",
    }));
  });

  it("treats write-method network evidence as a mutation boundary", () => {
    const url = "https://app.example.com/query";
    browserBroker.requestConsent(url);
    browserBroker.registerTabs([{ tab_id: "app", url, active: true }]);
    expect(browserBroker.startTeachMode("app").ok).toBe(true);
    expect(browserBroker.recordHumanAction({
      tab_id: "app",
      url,
      origin: "https://app.example.com",
      action: "click",
      element: { role: "button", name: "Run query", test_id: "run-query" },
    }).ok).toBe(true);

    const annotated = browserBroker.annotateLatestHumanAction({
      tab_id: "app",
      url,
      origin: "https://app.example.com",
      actions: ["click"],
      detail: {
        network_event: true,
        network_method: "POST",
        network_url: "https://app.example.com/api/query",
        resource_type: "fetch",
      },
      within_ms: 5000,
    });

    expect(annotated.ok).toBe(true);
    const workflow = browserBroker.compiledWorkflow();
    const step = workflow.contract.steps[0];

    expect(step?.mutation).toEqual(expect.objectContaining({
      kind: "unknown",
      evidence: ["network_method_implies_mutation"],
      requiresIsolation: true,
    }));
    expect(workflow.contract.mutationBoundaryPlan.firstMutationStepId).toBe(step?.stepId);
    expect(workflow.contract.mutationBoundaryPlan.defaultReplayMode).toBe("prefixOnly");
    expect(workflow.contract.limitations).toContain("mutationRequiresIsolation");
    expect(workflow.contract.failureClasses).toContain("mutationBlocked");
    expect(planWorkflowReplay(browserBroker.traceSnapshot(), "prefixOnly")).toEqual(expect.objectContaining({
      status: "stoppedAtMutationBoundary",
      stoppedBeforeStepId: step?.stepId,
    }));
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

  it("models clipboard paste as caller-supplied secret test data", () => {
    const workflow = compileWorkflowContract([
      {
        event_id: "paste-key",
        trace_id: "trace",
        trace_version: 1,
        event_seq: 1,
        ts: 10,
        tab_id: "tab",
        origin: "https://app.example.com",
        url: "https://app.example.com",
        kind: "human_action",
        action: "press",
        value: "Control+V",
        detail: {
          field_name: "API token",
          element: { label: "API token", role: "textbox" },
        },
        locator_candidates: [
          { kind: "label", locator: "page.getByLabel(\"API token\")", confidence: 0.94, reason: "form_label" },
        ],
      },
      {
        event_id: "paste-token",
        trace_id: "trace",
        trace_version: 1,
        event_seq: 2,
        ts: 20,
        tab_id: "tab",
        origin: "https://app.example.com",
        url: "https://app.example.com",
        kind: "human_action",
        action: "fill",
        detail: {
          field_name: "API token",
          clipboard_event: true,
          clipboard_mode: "paste",
          paste_event: true,
          paste_parameter: "API_TOKEN_PASTE",
          pasted_text_length: 18,
          pasted_text_redacted: true,
          element: { label: "API token", role: "textbox" },
        },
        locator_candidates: [
          { kind: "label", locator: "page.getByLabel(\"API token\")", confidence: 0.94, reason: "form_label" },
        ],
      },
      {
        event_id: "paste-fill-noise",
        trace_id: "trace",
        trace_version: 1,
        event_seq: 3,
        ts: 60,
        tab_id: "tab",
        origin: "https://app.example.com",
        url: "https://app.example.com",
        kind: "human_action",
        action: "fill",
        value: "super-secret",
        detail: {
          field_name: "API token",
          input_debounced: true,
          element: { label: "API token", role: "textbox" },
        },
        locator_candidates: [
          { kind: "label", locator: "page.getByLabel(\"API token\")", confidence: 0.94, reason: "form_label" },
        ],
      },
    ]);

    expect(workflow.contract.steps).toHaveLength(1);
    expect(workflow.contract.parameters[0]).toEqual(expect.objectContaining({
      name: "api_token_paste",
      valueShape: "secret",
      required: true,
      redacted: true,
    }));
    expect(workflow.contract.steps[0]?.surfacePlan).toEqual(expect.objectContaining({
      kind: "clipboardPaste",
      replay: "parameterized",
    }));
    expect(JSON.stringify(workflow.contract)).not.toContain("super-secret");
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

  it("allows same-origin popup continuation when opener linkage is captured", () => {
    const events = [
      baseEvent({
        event_id: "open-help",
        event_seq: 1,
        tab_id: "main",
        action: "click",
        detail: {
          popup_event: true,
          popup_url: "https://app.example.com/help",
          popup_tab_id: "popup",
          opener_tab_id: "main",
          element: { role: "button", name: "Open help", source_id: "src_open_help" },
        },
      }),
      baseEvent({
        event_id: "popup-search",
        event_seq: 2,
        tab_id: "popup",
        action: "fill",
        value: "contracts",
        url: "https://app.example.com/help",
        detail: {
          popup_context: true,
          popup_tab_id: "popup",
          opener_tab_id: "main",
          opener_origin: "https://app.example.com",
          element: { role: "textbox", label: "Search help", source_id: "src_help_search" },
        },
        locator_candidates: [
          { kind: "label", locator: "page.getByLabel(\"Search help\")", confidence: 0.94, reason: "form_label" },
        ],
      }),
    ];

    const workflow = compileWorkflowContract(events);
    const replay = planWorkflowReplay(events, "sameSession");

    expect(workflow.contract.limitations).not.toContain("popupOrMultiTab");
    expect(workflow.contract.mutationBoundaryPlan.defaultReplayMode).not.toBe("blocked");
    expect(replay.status).toBe("ready");
  });

  it("blocks popup continuation when the opener event is missing", () => {
    const events = [
      baseEvent({
        event_id: "popup-search",
        event_seq: 1,
        tab_id: "popup",
        action: "fill",
        value: "contracts",
        url: "https://app.example.com/help",
        detail: {
          popup_context: true,
          popup_tab_id: "popup",
          opener_tab_id: "main",
          opener_origin: "https://app.example.com",
          element: { role: "textbox", label: "Search help", source_id: "src_help_search" },
        },
        locator_candidates: [
          { kind: "label", locator: "page.getByLabel(\"Search help\")", confidence: 0.94, reason: "form_label" },
        ],
      }),
      baseEvent({
        event_id: "main",
        event_seq: 2,
        tab_id: "main",
        action: "click",
        detail: { element: { role: "button", name: "Close", source_id: "src_close" } },
      }),
    ];

    const workflow = compileWorkflowContract(events);
    const replay = planWorkflowReplay(events, "sameSession");

    expect(workflow.contract.limitations).toContain("popupOrMultiTab");
    expect(replay.status).toBe("blocked");
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

  it("allows iframe traces when a durable frame locator is captured", () => {
    const events = [
      baseEvent({
        event_id: "card",
        frame_id: "checkout-frame",
        detail: {
          frame_locator: "iframe[data-testid=\"checkout-frame\"]",
          element: { role: "textbox", label: "Cardholder", source_id: "src_cardholder" },
        },
      }),
    ];

    const workflow = compileWorkflowContract(events);
    const replay = planWorkflowReplay(events, "sameSession");

    expect(workflow.contract.steps[0]?.limitations).not.toContain("iframeNeedsFrameLocator");
    expect(workflow.contract.limitations).not.toContain("iframeNeedsFrameLocator");
    expect(workflow.contract.mutationBoundaryPlan.defaultReplayMode).not.toBe("blocked");
    expect(replay.status).toBe("ready");
  });

  it("treats open shadow DOM traces as durable when a piercing locator is captured", () => {
    const events = [
      baseEvent({
        event_id: "shadow-name",
        event_seq: 1,
        action: "fill",
        value: "Ada Shadow",
        detail: {
          shadow_dom: "open",
          shadow_host_tag: "profile-card",
          shadow_host_css: "profile-card",
          shadow_inner_css: "label > input",
          element: { role: "textbox", label: "Shadow name", css: "profile-card label > input", source_id: "src_shadow_name" },
        },
        locator_candidates: [
          { kind: "css", locator: "page.locator(\"profile-card label > input\")", confidence: 0.58, reason: "stable_css_selector" },
        ],
      }),
    ];

    const workflow = compileWorkflowContract(events);
    const replay = planWorkflowReplay(events, "sameSession");

    expect(workflow.contract.steps[0]?.surfacePlan).toEqual(expect.objectContaining({
      kind: "openShadowDom",
      replay: "durable",
    }));
    expect(workflow.contract.limitations).not.toContain("closedShadowDomBlocked");
    expect(workflow.contract.mutationBoundaryPlan.defaultReplayMode).not.toBe("blocked");
    expect(replay.status).toBe("ready");
  });

  it("models accepted native prompt responses as redacted required parameters", () => {
    const workflow = compileWorkflowContract([
      baseEvent({
        event_id: "prompt-rename",
        event_seq: 1,
        action: "click",
        detail: {
          dialog_event: true,
          dialog_type: "prompt",
          dialog_message: "Enter workspace name",
          dialog_prompt_value: "[REDACTED]",
          dialog_prompt_value_redacted: true,
          dialog_accepted: true,
          observed_effects: ["Renamed workspace to [REDACTED]"],
          observed_effects_redacted: true,
          element: { role: "button", name: "Rename workspace", test_id: "rename-workspace", source_id: "src_rename_workspace" },
        },
        locator_candidates: [
          { kind: "test_id", locator: "page.getByTestId(\"rename-workspace\")", confidence: 0.99, reason: "test_id" },
        ],
      }),
    ]);

    expect(workflow.contract.steps[0]?.action.valueRef).toBe("enter_workspace_name");
    expect(workflow.contract.parameters).toContainEqual(expect.objectContaining({
      name: "enter_workspace_name",
      valueShape: "secret",
      required: true,
      redacted: true,
    }));
    expect(workflow.contract.steps[0]?.surfacePlan).toEqual(expect.objectContaining({
      kind: "dom",
      replay: "parameterized",
    }));
  });

  it("surfaces coordinate and pointer limitations and blocks replay", () => {
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
    expect(workflow.contract.mutationBoundaryPlan.defaultReplayMode).toBe("blocked");
    expect(workflow.contract.counterfactualPlan).toEqual(expect.objectContaining({
      mode: "blocked",
      profiles: [],
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

  it("classifies code editor replay strategies in surface plans", () => {
    const workflow = compileWorkflowContract([
      baseEvent({
        event_id: "textarea-editor",
        event_seq: 1,
        action: "fill",
        detail: {
          editor_surface: "textarea",
          editor_backing: "textarea",
          editor_replay_strategy: "fill",
          element: { role: "textbox", label: "Automation script", source_id: "src_editor" },
        },
      }),
      baseEvent({
        event_id: "custom-editor",
        event_seq: 2,
        action: "fill",
        detail: {
          editor_surface: "codemirror",
          editor_backing: "hiddenTextarea",
          editor_replay_strategy: "keyboardInsert",
          element: { role: "textbox", name: "Query editor", source_id: "src_query" },
        },
      }),
    ]);

    expect(workflow.contract.steps[0]?.surfacePlan).toEqual(expect.objectContaining({
      kind: "dom",
      replay: "durable",
    }));
    expect(workflow.contract.steps[1]?.surfacePlan).toEqual(expect.objectContaining({
      kind: "dom",
      replay: "sameSessionOnly",
    }));
    expect(workflow.contract.steps[1]?.surfacePlan.notes[0]).toContain("keyboard insertion");
  });

  it("classifies terminal-like keyboard text entry as parameterized keyboard insertion", () => {
    const workflow = compileWorkflowContract([
      baseEvent({
        event_id: "terminal-text",
        event_seq: 1,
        action: "fill",
        value: "deploy preview",
        detail: {
          keyboard_text_entry: true,
          text_entry_mode: "keyboardInsert",
          element: { role: "application", name: "Terminal surface", source_id: "terminal.shell" },
        },
      }),
    ]);

    expect(workflow.contract.steps[0]?.action.valueRef).toBe("terminal_surface");
    expect(workflow.contract.parameters[0]).toEqual(expect.objectContaining({
      name: "terminal_surface",
      valueShape: "shortText",
    }));
    expect(workflow.contract.steps[0]?.surfacePlan).toEqual(expect.objectContaining({
      kind: "dom",
      replay: "parameterized",
    }));
    expect(workflow.contract.steps[0]?.surfacePlan.notes[0]).toContain("keyboard typing");
  });

  it("classifies copy and cut as clipboard transfer surfaces", () => {
    const workflow = compileWorkflowContract([
      baseEvent({
        event_id: "copy-key",
        event_seq: 1,
        action: "press",
        value: "Control+C",
        detail: {
          element: { tag: "textarea", role: "textbox", label: "Release notes", source_id: "notes.editor" },
        },
      }),
      baseEvent({
        event_id: "copy-range",
        event_seq: 2,
        action: "copy",
        detail: {
          clipboard_event: true,
          clipboard_mode: "copy",
          selection_start: 0,
          selection_end: 5,
          element: { tag: "textarea", role: "textbox", label: "Release notes", source_id: "notes.editor" },
        },
      }),
      baseEvent({
        event_id: "cut-key",
        event_seq: 3,
        action: "press",
        value: "Control+X",
        detail: {
          element: { tag: "textarea", role: "textbox", label: "Release notes", source_id: "notes.editor" },
        },
      }),
      baseEvent({
        event_id: "cut-range",
        event_seq: 4,
        action: "cut",
        detail: {
          clipboard_event: true,
          clipboard_mode: "cut",
          selection_start: 6,
          selection_end: 10,
          element: { tag: "textarea", role: "textbox", label: "Release notes", source_id: "notes.editor" },
        },
      }),
      baseEvent({
        event_id: "cut-fill-noise",
        event_seq: 5,
        action: "fill",
        value: "alpha gamma",
        detail: {
          input_debounced: true,
          element: { tag: "textarea", role: "textbox", label: "Release notes", source_id: "notes.editor" },
        },
      }),
    ]);

    expect(workflow.contract.steps).toHaveLength(2);
    expect(workflow.contract.steps[0]?.surfacePlan).toEqual(expect.objectContaining({
      kind: "clipboardCopy",
      replay: "durable",
    }));
    expect(workflow.contract.steps[1]?.surfacePlan).toEqual(expect.objectContaining({
      kind: "clipboardCut",
      replay: "durable",
    }));
    expect(workflow.contract.steps[0]?.expectedEffects[0]).toContain("clipboard");
    expect(workflow.contract.steps[1]?.expectedEffects[0]).toContain("removed");
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
        event_id: "clipboard-drop",
        event_seq: 3,
        action: "drag",
        detail: {
          drag_mode: true,
          drag_class: "clipboardDrop",
          clipboard_parameter: "RELEASE_NOTES_DROP",
          dropped_text_redacted: true,
          element: { tag: "textarea", role: "textbox", label: "Release notes", source_id: "src_notes" },
        },
      }),
      baseEvent({
        event_id: "pointer-drag",
        event_seq: 4,
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
      "clipboardDrop",
      "pointerDrag",
    ]);
    expect(workflow.contract.steps[0]?.surfacePlan.replay).toBe("durable");
    expect(workflow.contract.steps[1]?.surfacePlan.replay).toBe("parameterized");
    expect(workflow.contract.steps[2]?.surfacePlan.replay).toBe("parameterized");
    expect(workflow.contract.steps[3]?.limitations).toContain("pointerDragUnreliable");
    expect(workflow.contract.steps[3]?.surfacePlan.replay).toBe("blocked");
    expect(workflow.contract.parameters).toContainEqual(expect.objectContaining({
      name: "upload_file",
      sourceStepId: "file-drop",
      valueShape: "filePath",
    }));
    expect(workflow.contract.parameters).toContainEqual(expect.objectContaining({
      name: "release_notes_drop",
      sourceStepId: "clipboard-drop",
      valueShape: "secret",
      redacted: true,
    }));
  });

  it("allows calibrated pointer drags as same-session replay without unblocking unknown pointer drags", () => {
    const events = [
      baseEvent({
        event_id: "pointer-drag",
        event_seq: 1,
        action: "drag",
        value: "page.getByRole(\"list\", { name: \"Done\" })",
        detail: {
          drag_mode: true,
          drag_class: "pointerSensor",
          pointer_drag: true,
          pointer_replay: "calibrated",
          pointer_start_x_ratio: 0.5,
          pointer_start_y_ratio: 0.5,
          pointer_end_x_ratio: 0.5,
          pointer_end_y_ratio: 0.5,
          drop_locator: "page.getByRole(\"list\", { name: \"Done\" })",
          element: { role: "listitem", name: "Task", source_id: "src_task" },
        },
        locator_candidates: [
          { kind: "role", locator: "page.getByRole(\"listitem\", { name: \"Task\" })", confidence: 0.98, reason: "role" },
        ],
      }),
    ];
    const workflow = compileWorkflowContract(events);
    const replay = planWorkflowReplay(events, "sameSession");

    expect(workflow.contract.limitations).not.toContain("pointerDragUnreliable");
    expect(workflow.contract.steps[0]?.surfacePlan).toEqual(expect.objectContaining({
      kind: "pointerDrag",
      replay: "sameSessionOnly",
    }));
    expect(replay.status).toBe("ready");
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

  it("does not count unregistered source identity tokens as linked", () => {
    const workflow = compileWorkflowContract([
      rawBaseEvent({
        event_id: "open-details",
        event_seq: 1,
        action: "click",
        detail: {
          element: { role: "button", name: "Open details", source_id: "src_unregistered" },
        },
      }),
    ]);

    expect(workflow.contract.sourceIdentityCoverage).toEqual(expect.objectContaining({
      linkedSteps: 0,
      totalSteps: 1,
      status: "missing",
    }));
    expect(workflow.contract.steps[0]?.sourcePlan).toEqual(expect.objectContaining({
      status: "missing",
      sourceId: "src_unregistered",
      missingReason: "sourceTokenMissing",
    }));
    expect(workflow.contract.limitations).toContain("sourceIdentityMissing");
  });

  it("resolves registered source identity tokens into step metadata", () => {
    registerSourceToken("src_registered", "src/components/DetailsButton.tsx");

    const workflow = compileWorkflowContract([
      rawBaseEvent({
        event_id: "open-details",
        event_seq: 1,
        action: "click",
        detail: {
          element: { role: "button", name: "Open details", source_id: "src_registered" },
        },
      }),
    ]);

    expect(workflow.contract.sourceIdentityCoverage).toEqual(expect.objectContaining({
      linkedSteps: 1,
      totalSteps: 1,
      status: "complete",
    }));
    expect(workflow.contract.steps[0]?.sourcePlan).toEqual(expect.objectContaining({
      status: "linked",
      sourceId: "src_registered",
      workspaceId: "test-workspace",
      filePath: "src/components/DetailsButton.tsx",
      line: 1,
      column: 1,
      adapter: "unit-test",
      transformVersion: "unit_source_identity_v1",
    }));
    expect(workflow.contract.limitations).not.toContain("sourceIdentityMissing");
  });

  it("does not require source identity for route navigation steps", () => {
    const events = [
      rawBaseEvent({
        event_id: "route",
        event_seq: 1,
        kind: "navigation",
        action: "navigate",
        url: "https://app.example.com/review#queue",
        locator_candidates: [],
        detail: { navigation_event: true },
      }),
    ];
    const workflow = compileWorkflowContract(events);
    const replay = planWorkflowReplay(events, "sameSession");

    expect(workflow.contract.steps[0]).toEqual(expect.objectContaining({
      label: "Open /review",
      sourcePlan: { status: "notRequired" },
      limitations: [],
    }));
    expect(workflow.contract.sourceIdentityCoverage).toEqual(expect.objectContaining({
      linkedSteps: 1,
      totalSteps: 1,
      status: "complete",
    }));
    expect(workflow.contract.limitations).not.toContain("sourceIdentityMissing");
    expect(workflow.contract.limitations).not.toContain("unresolvedStep");
    expect(replay.status).toBe("ready");
    expect(replay.events).toHaveLength(1);
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
    expect(workflow.contract.failureClasses).toEqual(expect.arrayContaining(["authMissing", "authExpired"]));
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

  it("blocks pointer drag replay before runtime execution", () => {
    const events = [
      baseEvent({
        event_id: "drag",
        event_seq: 1,
        action: "drag",
        value: "page.getByRole(\"list\", { name: \"Done\" })",
        detail: {
          drag_mode: true,
          drag_class: "pointerSensor",
          element: { role: "listitem", name: "Task" },
        },
      }),
    ];

    const workflow = compileWorkflowContract(events);
    const replay = planWorkflowReplay(events, "sameSession");

    expect(workflow.contract.limitations).toContain("pointerDragUnreliable");
    expect(workflow.contract.mutationBoundaryPlan.defaultReplayMode).toBe("blocked");
    expect(replay).toEqual(expect.objectContaining({
      status: "blocked",
      events: [],
      warnings: expect.arrayContaining([
        "Replay blocked: pointer or sensor-based drag requires calibrated replay support.",
      ]),
    }));
    expect(classifyWorkflowReplayBlock(replay)).toBe("pointerDragUnreliable");
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
    expect(classifyWorkflowReplayFailure(new Error("Timeout 30000ms exceeded waiting for URL"), baseEvent({
      action: "navigate",
      kind: "navigation",
    }))).toBe("routeChanged");
    expect(classifyWorkflowReplayFailure(new Error("net::ERR_CONNECTION_REFUSED"))).toBe("networkFailure");
    expect(classifyWorkflowReplayFailure(new Error("hydration boundary not ready"))).toBe("hydrationDelay");
  });
});

function baseEvent(overrides: Partial<Parameters<typeof compileWorkflowContract>[0][number]>) {
  registerSourceFromEvent(overrides);
  return rawBaseEvent(overrides);
}

function rawBaseEvent(overrides: Partial<Parameters<typeof compileWorkflowContract>[0][number]>) {
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

function registerSourceFromEvent(event: Partial<Parameters<typeof compileWorkflowContract>[0][number]>): void {
  const element = event.detail?.["element"];
  if (!element || typeof element !== "object" || Array.isArray(element)) return;
  const sourceId = (element as { source_id?: unknown }).source_id;
  if (typeof sourceId !== "string" || sourceId.length === 0) return;
  registerSourceToken(sourceId);
}

function registerSourceToken(token: string, filePath = `src/${token}.tsx`): void {
  sourceIdentityRegistry.register({
    workspaceId: "test-workspace",
    filePath,
    adapter: "unit-test",
    transformVersion: "unit_source_identity_v1",
    tokens: [{ token, file: filePath, tag: "button", line: 1, column: 1 }],
  });
}

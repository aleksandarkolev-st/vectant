import { beforeEach, describe, expect, it } from "vitest";
import { browserBroker } from "../../src/browser/broker.js";
import { classifyWorkflowReplayBlock, compileWorkflowContract, planWorkflowReplay } from "../../src/browser/workflow.js";
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
    expect(workflow.contract.mutationBoundaryPlan.defaultReplayMode).toBe("sameSession");
    expect(workflow.contract.counterfactualPlan.profiles).toContainEqual(expect.objectContaining({
      name: "mobile",
      enabled: false,
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

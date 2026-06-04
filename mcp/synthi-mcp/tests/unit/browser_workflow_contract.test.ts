import { beforeEach, describe, expect, it } from "vitest";
import { browserBroker } from "../../src/browser/broker.js";
import { compileWorkflowContract } from "../../src/browser/workflow.js";
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
    expect(workflow.contract.mutationBoundaryPlan.firstMutationStepId).toBe("browser_evt_2");
    expect(workflow.contract.mutationBoundaryPlan.defaultReplayMode).toBe("prefixOnly");
    expect(workflow.contract.sourceIdentityCoverage.status).toBe("missing");
    expect(workflow.contract.limitations).toContain("sourceIdentityMissing");
    expect(workflow.contract.limitations).toContain("mutationRequiresIsolation");
    expect(workflow.contract.failureClasses).toEqual(expect.arrayContaining(["locatorDrift", "mutationBlocked", "sourceIdentityMissing"]));
    expect(workflow.contract.generatedOutputs[0]).toEqual(expect.objectContaining({ kind: "playwright", status: "available" }));
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

  it("advertises and dispatches the compile workflow tool", async () => {
    expect(BROWSER_TOOL_NAMES).toContain("synthi_browser_compile_workflow");
    expect(ADVERTISED_TOOLS).toContain("synthi_browser_compile_workflow");

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

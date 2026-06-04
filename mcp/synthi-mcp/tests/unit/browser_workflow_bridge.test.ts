import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { browserBroker } from "../../src/browser/broker.js";
import {
  buildBrowserWorkflowPanelState,
  resolveBrowserWorkflowBridgePort,
  startBrowserWorkflowBridge,
} from "../../src/browser_workflow_bridge/server.js";
import { eventLog } from "../../src/events/index.js";

type Bridge = ReturnType<typeof startBrowserWorkflowBridge>;

function baseUrl(bridge: Bridge): string {
  const addr = bridge.server.address() as AddressInfo;
  return `http://127.0.0.1:${addr.port}`;
}

describe("browser workflow bridge", () => {
  let bridge: Bridge | null = null;

  beforeEach(() => {
    browserBroker.resetForTests();
    eventLog._resetForTests();
  });

  afterEach(async () => {
    if (bridge) {
      await bridge.close();
      bridge = null;
    }
  });

  it("resolveBrowserWorkflowBridgePort validates env values", () => {
    expect(resolveBrowserWorkflowBridgePort(undefined)).toBeUndefined();
    expect(resolveBrowserWorkflowBridgePort("")).toBeUndefined();
    expect(resolveBrowserWorkflowBridgePort("banana")).toBeUndefined();
    expect(resolveBrowserWorkflowBridgePort("0")).toBeUndefined();
    expect(resolveBrowserWorkflowBridgePort("70000")).toBeUndefined();
    expect(resolveBrowserWorkflowBridgePort("9466")).toBe(9466);
    expect(resolveBrowserWorkflowBridgePort("9466.9")).toBe(9466);
  });

  it("healthz returns ok and answers CORS preflight", async () => {
    bridge = startBrowserWorkflowBridge({ port: 0 });
    await bridge.ready;
    const health = await fetch(`${baseUrl(bridge)}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.text()).toBe("ok\n");

    const preflight = await fetch(`${baseUrl(bridge)}/browser-workflows/tool`, {
      method: "OPTIONS",
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("rejects requests missing a configured token", async () => {
    bridge = startBrowserWorkflowBridge({ port: 0, token: "s3cret" });
    await bridge.ready;
    const noHeader = await fetch(`${baseUrl(bridge)}/browser-workflows/state`);
    expect(noHeader.status).toBe(401);

    const withHeader = await fetch(`${baseUrl(bridge)}/browser-workflows/state`, {
      headers: { "X-Synthi-Workflow-Token": "s3cret" },
    });
    expect(withHeader.status).toBe(200);
  });

  it("returns panel-safe state without screenshots or local desktop assumptions", async () => {
    const url = "https://app.example.test/settings";
    browserBroker.requestConsent(url, "granted", "unit", { screenshot: true, diagnostics: true });
    browserBroker.registerTabs([{ tab_id: "tab-a", url, title: "Settings", active: true }]);
    browserBroker.selectTab("tab-a");
    browserBroker.setRuntimeAttachment({
      kind: "hosted",
      workspace_id: "workspace-a",
      runtime_id: "runtime-a",
      workspace_url: url,
      adapter: "hosted-playwright-cdp",
    });

    const state = buildBrowserWorkflowPanelState();
    expect(state).toEqual(expect.objectContaining({
      workspaceLabel: "workspace-a",
      runtime: expect.objectContaining({ status: "attached" }),
      observe: expect.objectContaining({ status: "ready" }),
    }));
    const serialized = JSON.stringify(state);
    expect(serialized).not.toContain("screenshot_base64");
    expect(serialized).not.toMatch(/local chrome|desktop extension|C:\\\\/i);
  });

  it("dispatches stale panel action aliases to current MCP workflow tools", async () => {
    seedSaveWorkflow();
    bridge = startBrowserWorkflowBridge({ port: 0 });
    await bridge.ready;

    const res = await fetch(`${baseUrl(bridge)}/browser-workflows/tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: "synthi_workflow_compile_contract", arguments: {} }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean;
      tool: string;
      requested_tool: string;
      state: {
        workflow: { contractStatus: string; stepCount: number };
        steps: Array<{ id: string; label: string }>;
      };
    };
    expect(body.ok).toBe(true);
    expect(body.requested_tool).toBe("synthi_workflow_compile_contract");
    expect(body.tool).toBe("synthi_browser_compile_workflow");
    expect(body.state.workflow.contractStatus).toBe("compiled");
    expect(body.state.workflow.stepCount).toBe(2);
    expect(body.state.steps.map((step) => step.label)).toEqual([
      "Fill Email",
      "Click Save settings",
    ]);
  });

  it("returns unknown tool errors with the current state snapshot", async () => {
    bridge = startBrowserWorkflowBridge({ port: 0 });
    await bridge.ready;

    const res = await fetch(`${baseUrl(bridge)}/browser-workflows/tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: "synthi_nope", arguments: {} }),
    });
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string; state?: unknown };
    expect(body.error).toBe("unknown_workflow_tool");
    expect(body.state).toBeTruthy();
  });
});

function seedSaveWorkflow(): void {
  const url = "https://app.example.test/settings";
  browserBroker.requestConsent(url, "granted", "unit", { screenshot: true, diagnostics: true });
  browserBroker.registerTabs([{ tab_id: "tab-a", url, title: "Settings", active: true }]);
  browserBroker.selectTab("tab-a");
  browserBroker.setRuntimeAttachment({
    kind: "hosted",
    workspace_id: "workspace-a",
    runtime_id: "runtime-a",
    workspace_url: url,
    adapter: "hosted-playwright-cdp",
  });
  expect(browserBroker.startTeachMode("tab-a").ok).toBe(true);
  browserBroker.recordHumanAction({
    tab_id: "tab-a",
    url,
    origin: "https://app.example.test",
    action: "fill",
    value: "hello@example.test",
    field_name: "email",
    element: { tag: "input", label: "Email", source_id: "s_email" },
  });
  browserBroker.recordHumanAction({
    tab_id: "tab-a",
    url,
    origin: "https://app.example.test",
    action: "click",
    element: { tag: "button", role: "button", name: "Save settings", source_id: "s_save" },
  });
}

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { browserBroker } from "../../src/browser/broker.js";
import { privateWorkflowToolRegistry } from "../../src/browser/private_tool_registry.js";
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
    privateWorkflowToolRegistry.resetForTests();
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

  it("rejects cross-site browser origins when the local bridge has no token", async () => {
    bridge = startBrowserWorkflowBridge({ port: 0 });
    await bridge.ready;

    const tool = await fetch(`${baseUrl(bridge)}/browser-workflows/tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
      body: JSON.stringify({ tool: "synthi_browser_compile_workflow", arguments: {} }),
    });
    expect(tool.status).toBe(403);
    expect(await tool.json()).toEqual({ error: "origin_not_allowed" });

    const overlay = await fetch(`${baseUrl(bridge)}/browser-workflows/overlay`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
      body: JSON.stringify({ action: "state" }),
    });
    expect(overlay.status).toBe(403);
    expect(await overlay.json()).toEqual({ error: "origin_not_allowed" });
  });

  it("allows no-token workflow requests from loopback browser origins", async () => {
    bridge = startBrowserWorkflowBridge({ port: 0 });
    await bridge.ready;

    const res = await fetch(`${baseUrl(bridge)}/browser-workflows/tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" },
      body: JSON.stringify({ tool: "synthi_browser_compile_workflow", arguments: {} }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; tool: string };
    expect(body).toEqual(expect.objectContaining({
      ok: true,
      tool: "synthi_browser_compile_workflow",
    }));
  });

  it("allows workflow lease tools through the local workflow bridge", async () => {
    bridge = startBrowserWorkflowBridge({ port: 0 });
    await bridge.ready;

    const acquire = await fetch(`${baseUrl(bridge)}/browser-workflows/tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" },
      body: JSON.stringify({
        tool: "synthi_browser_acquire_lease",
        arguments: { owner: "bridge-test", lease_ms: 5000, reason: "unit" },
      }),
    });
    expect(acquire.status).toBe(200);
    const acquireBody = await acquire.json() as { ok: boolean; tool: string; result?: { lease?: { lease_id?: string } } };
    expect(acquireBody).toEqual(expect.objectContaining({
      ok: true,
      tool: "synthi_browser_acquire_lease",
    }));
    const leaseId = acquireBody.result?.lease?.lease_id;
    expect(leaseId).toBeTruthy();

    const release = await fetch(`${baseUrl(bridge)}/browser-workflows/tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" },
      body: JSON.stringify({
        tool: "synthi_browser_release_lease",
        arguments: { lease_id: leaseId, reason: "unit-complete" },
      }),
    });
    expect(release.status).toBe(200);
    const releaseBody = await release.json() as { ok: boolean; tool: string };
    expect(releaseBody).toEqual(expect.objectContaining({
      ok: true,
      tool: "synthi_browser_release_lease",
    }));
  });

  it("requires a token when the workflow bridge is not loopback-bound", async () => {
    bridge = startBrowserWorkflowBridge({ port: 0, host: "0.0.0.0" });
    await bridge.ready;

    const res = await fetch(`${baseUrl(bridge)}/browser-workflows/state`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "workflow_bridge_token_required" });
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

  it("keeps panel state safe when the selected tab has no consentable origin", async () => {
    const workspaceUrl = "https://app.example.test/workspace";
    browserBroker.requestConsent(workspaceUrl, "granted", "unit", { screenshot: true, diagnostics: true });
    browserBroker.registerTabs([{ tab_id: "tab-blank", url: "about:blank", title: "Blank", active: true }]);
    browserBroker.selectTab("tab-blank");
    browserBroker.setRuntimeAttachment({
      kind: "hosted",
      workspace_id: "workspace-a",
      runtime_id: "runtime-a",
      workspace_url: workspaceUrl,
      adapter: "hosted-playwright-cdp",
    });

    const state = buildBrowserWorkflowPanelState() as {
      runtime: { status: string };
      observe: { status: string; selectedTabId: string | null; consent: unknown };
    };
    expect(state.runtime.status).toBe("attached");
    expect(state.observe.status).toBe("needsConsent");
    expect(state.observe.selectedTabId).toBe("tab-blank");
    expect(state.observe.consent).toBeNull();
  });

  it("surfaces sanitized recording issues in panel review state", async () => {
    const url = "https://app.example.test/settings";
    browserBroker.requestConsent(url, "granted", "unit", { screenshot: true, diagnostics: true });
    browserBroker.registerTabs([{ tab_id: "tab-a", url, title: "Settings", active: true }]);
    browserBroker.selectTab("tab-a");
    browserBroker.setRuntimeAttachment({
      kind: "hosted",
      workspace_id: "workspace-a",
      runtime_id: "runtime-a",
      workspace_url: "https://ide.example.test/workspace/workspace-a",
      adapter: "hosted-playwright-cdp",
    });
    expect(browserBroker.startTeachMode("tab-a")).toEqual(expect.objectContaining({ ok: true }));
    browserBroker.recordTeachRecordingIssue("popup_origin_consent_required", {
      tab_id: "tab-a",
      url,
      origin: "https://app.example.test",
      action: "click",
      detail: {
        popup_origin: "https://checkout.example.test",
        selector: "#pay",
        value: "secret-token",
      },
    }, "hosted-playwright-adapter");

    const state = buildBrowserWorkflowPanelState() as {
      unresolvedSteps: Array<{ label: string; detail: string; popupOrigin?: string }>;
      diagnostics: { recordingIssues: unknown[] };
    };

    expect(state.unresolvedSteps).toEqual([
      expect.objectContaining({
        label: "Popup consent required",
        detail: expect.stringContaining("https://checkout.example.test"),
        popupOrigin: "https://checkout.example.test",
      }),
    ]);
    expect(state.diagnostics.recordingIssues).toHaveLength(1);
    expect(JSON.stringify(state)).not.toMatch(/secret-token|#pay|selector|value/);
  });

  it("keeps workspace-shell annotation failures diagnostic-only", async () => {
    const previewUrl = "https://preview.example.test/settings";
    const workspaceUrl = "https://ide.example.test/workspace/workspace-a";
    browserBroker.requestConsent(previewUrl, "granted", "unit", { screenshot: true, diagnostics: true });
    browserBroker.registerTabs([{ tab_id: "preview", url: previewUrl, title: "Preview", active: true }]);
    browserBroker.selectTab("preview");
    browserBroker.setRuntimeAttachment({
      kind: "hosted",
      workspace_id: "workspace-a",
      runtime_id: "runtime-a",
      workspace_url: workspaceUrl,
      adapter: "hosted-playwright-cdp",
    });
    expect(browserBroker.startTeachMode("preview")).toEqual(expect.objectContaining({ ok: true }));
    browserBroker.recordTeachRecordingIssue("teach_tab_mismatch", {
      tab_id: "workspace-shell",
      url: workspaceUrl,
      origin: "https://ide.example.test",
      action: "click",
      detail: {
        selector: "[data-workflow-overlay]",
        value: "secret-token",
      },
    }, "hosted-playwright-annotation");

    const state = buildBrowserWorkflowPanelState() as {
      unresolvedSteps: unknown[];
      diagnostics: { recordingIssues: Array<{ blocking: boolean; url: string }> };
    };

    expect(state.unresolvedSteps).toEqual([]);
    expect(state.diagnostics.recordingIssues).toEqual([
      expect.objectContaining({ blocking: false, url: workspaceUrl }),
    ]);
    expect(JSON.stringify(state)).not.toMatch(/secret-token|selector|data-workflow-overlay/);
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

  it("lets the workflow bridge fetch a published private tool manifest", async () => {
    seedSaveWorkflow();
    bridge = startBrowserWorkflowBridge({ port: 0 });
    await bridge.ready;

    const publish = await fetch(`${baseUrl(bridge)}/browser-workflows/tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: "synthi_browser_publish_private_tool", arguments: {} }),
    });
    expect(publish.status).toBe(200);
    const publishBody = await publish.json() as {
      result?: { tool_name?: string };
    };
    const toolName = publishBody.result?.tool_name;
    expect(toolName).toMatch(/^synthi_app_/);

    const lookup = await fetch(`${baseUrl(bridge)}/browser-workflows/tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tool: "synthi_browser_get_private_tool_manifest",
        arguments: { tool_name: toolName },
      }),
    });

    expect(lookup.status).toBe(200);
    const lookupBody = await lookup.json() as {
      ok: boolean;
      result?: {
        manifest?: { tool_name?: string; kind?: string };
        tool?: { name?: string; inputSchema?: unknown };
      };
    };
    expect(lookupBody.ok).toBe(true);
    expect(lookupBody.result?.manifest).toEqual(expect.objectContaining({
      tool_name: toolName,
      kind: "privateMcpToolManifest",
    }));
    expect(lookupBody.result?.tool).toEqual(expect.objectContaining({
      name: toolName,
      inputSchema: expect.any(Object),
    }));
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

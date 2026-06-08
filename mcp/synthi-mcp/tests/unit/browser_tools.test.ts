import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authCheckpointManager } from "../../src/browser/auth.js";
import { browserBroker } from "../../src/browser/broker.js";
import { browserBridgeServer } from "../../src/browser/bridge_server.js";
import { browserPlaywrightAdapter } from "../../src/browser/playwright_adapter.js";
import { BROWSER_ACTION_KINDS } from "../../src/browser/types.js";
import type { BrowserSnapshot, BrowserTab } from "../../src/browser/types.js";
import { eventLog } from "../../src/events/index.js";
import { ADVERTISED_TOOLS } from "../../src/tool_registry.js";
import { BROWSER_TOOL_NAMES, BROWSER_TOOLS, browserWorkflowOverlayAction, dispatchBrowserTool } from "../../src/tools/browser.js";

const originalBrowserCdpUrl = process.env["SYNTHI_BROWSER_CDP_URL"];
const originalHostedBrowserCdpUrl = process.env["SYNTHI_HOSTED_BROWSER_CDP_URL"];

beforeEach(() => {
  browserBroker.resetForTests();
  authCheckpointManager.resetForTests();
  eventLog._resetForTests();
  delete process.env["SYNTHI_BROWSER_CDP_URL"];
  delete process.env["SYNTHI_HOSTED_BROWSER_CDP_URL"];
});

afterEach(async () => {
  vi.restoreAllMocks();
  await browserBridgeServer.stop();
  if (originalBrowserCdpUrl === undefined) {
    delete process.env["SYNTHI_BROWSER_CDP_URL"];
  } else {
    process.env["SYNTHI_BROWSER_CDP_URL"] = originalBrowserCdpUrl;
  }
  if (originalHostedBrowserCdpUrl === undefined) {
    delete process.env["SYNTHI_HOSTED_BROWSER_CDP_URL"];
  } else {
    process.env["SYNTHI_HOSTED_BROWSER_CDP_URL"] = originalHostedBrowserCdpUrl;
  }
});

describe("browser MCP tool surface", () => {
  it("advertises every browser tool in the capability registry", () => {
    for (const name of BROWSER_TOOL_NAMES) {
      expect(ADVERTISED_TOOLS).toContain(name);
      expect(BROWSER_TOOLS.some((tool) => tool.name === name)).toBe(true);
    }
  });

  it("defaults workflow replay to a cold session", () => {
    const tool = BROWSER_TOOLS.find((candidate) => candidate.name === "synthi_browser_run_workflow");
    const mode = tool?.inputSchema.properties?.["mode"] as { default?: string } | undefined;
    expect(mode?.default).toBe("coldSession");
  });

  it("advertises the canonical browser action set for direct agent actions", () => {
    const tool = BROWSER_TOOLS.find((candidate) => candidate.name === "synthi_browser_action");
    const action = tool?.inputSchema.properties?.["action"] as { enum?: string[] } | undefined;

    expect(action?.enum).toEqual([...BROWSER_ACTION_KINDS]);
    expect(action?.enum).toEqual(expect.arrayContaining(["dblclick", "contextmenu"]));
  });

  it("returns null for non-browser tool dispatch", async () => {
    expect(await dispatchBrowserTool("synthi_health", {})).toBeNull();
  });

  it("round-trips exact-origin consent through browser tools", async () => {
    const grant = await dispatchBrowserTool("synthi_browser_request_consent", {
      url: "https://app.example.com",
      screenshot: false,
      reason: "unit-test",
    });
    expect(grant?.isError).toBeUndefined();
    expect((grant?.structuredContent as { consent: { status: string } }).consent.status).toBe("granted");
    expect((grant?.structuredContent as { consent: { screenshot: string; diagnostics: string } }).consent).toEqual(
      expect.objectContaining({ screenshot: "denied", diagnostics: "granted" })
    );

    const records = await dispatchBrowserTool("synthi_browser_get_consent", {
      url: "https://app.example.com/path",
    });
    expect((records?.structuredContent as { consent: Array<{ origin: string; status: string }> }).consent).toEqual([
      expect.objectContaining({ origin: "https://app.example.com", status: "granted" }),
    ]);

    const revoke = await dispatchBrowserTool("synthi_browser_revoke_consent", {
      url: "https://app.example.com",
      reason: "done",
    });
    expect((revoke?.structuredContent as { consent: { status: string } }).consent.status).toBe("denied");
  });

  it("acquires and releases browser control leases through tools", async () => {
    const acquired = await dispatchBrowserTool("synthi_browser_acquire_lease", {
      owner: "agent",
      lease_ms: 5000,
      reason: "unit-test",
    });
    expect(acquired?.isError).toBeUndefined();
    const leaseId = (acquired?.structuredContent as { lease: { lease_id: string } }).lease.lease_id;
    expect(leaseId).toMatch(/^browser_lease_/);

    const released = await dispatchBrowserTool("synthi_browser_release_lease", {
      lease_id: leaseId,
      reason: "complete",
    });
    expect(released?.structuredContent).toEqual({ ok: true, released: true });
  });

  it("dispatches durable pointer and scroll agent actions through Playwright", async () => {
    const url = "https://app.example.com/records";
    browserBroker.requestConsent(url);
    browserBroker.registerTabs([{ tab_id: "app", url, title: "Records", active: true }]);
    const lease = browserBroker.acquireLease("agent", 5000, "direct-actions");
    const action = vi.spyOn(browserPlaywrightAdapter, "action").mockImplementation(async (tabId, kind) => ({
      ok: true,
      action: kind,
      tab_id: tabId,
      url,
    }));

    const doubleClicked = await dispatchBrowserTool("synthi_browser_action", {
      lease_id: lease.lease_id,
      tab_id: "app",
      action: "dblclick",
      selector: "page.getByRole(\"button\", { name: \"Open record\" })",
    });
    const contextMenu = await dispatchBrowserTool("synthi_browser_action", {
      lease_id: lease.lease_id,
      tab_id: "app",
      action: "contextmenu",
      selector: "page.getByRole(\"row\", { name: \"Open record\" })",
    });
    const scroll = await dispatchBrowserTool("synthi_browser_action", {
      lease_id: lease.lease_id,
      tab_id: "app",
      action: "scroll",
      selector: "page.getByTestId(\"records-scroll\")",
      value: "{\"top\":240,\"left\":0}",
    });

    expect(doubleClicked?.isError).toBeUndefined();
    expect(contextMenu?.isError).toBeUndefined();
    expect(scroll?.isError).toBeUndefined();
    expect(action).toHaveBeenNthCalledWith(
      1,
      "app",
      "dblclick",
      "page.getByRole(\"button\", { name: \"Open record\" })",
      undefined
    );
    expect(action).toHaveBeenNthCalledWith(
      2,
      "app",
      "contextmenu",
      "page.getByRole(\"row\", { name: \"Open record\" })",
      undefined
    );
    expect(action).toHaveBeenNthCalledWith(
      3,
      "app",
      "scroll",
      "page.getByTestId(\"records-scroll\")",
      "{\"top\":240,\"left\":0}"
    );
  });

  it("denies snapshot before any authorized tab is selected", async () => {
    const response = await dispatchBrowserTool("synthi_browser_snapshot", {});
    expect(response?.isError).toBe(true);
    expect((response?.structuredContent as { error: string }).error).toBe("browser_tool_failed");
    expect((response?.structuredContent as { message: string }).message).toBe("tab_not_authorized");
  });

  it("does not let agent preview observe self-grant screenshot consent", async () => {
    const previewUrl = "http://localhost:5174/dashboard";
    mockPreviewAdapter(previewUrl);

    const response = await dispatchBrowserTool("synthi_browser_observe_preview", {
      workspace_url: "http://localhost:3000/workspace/workspace-a",
      preview_url: previewUrl,
    });

    expect(response?.isError).toBe(true);
    expect(response?.structuredContent).toEqual(expect.objectContaining({
      error: "origin_consent_required",
      required_tool_call: expect.objectContaining({ name: "synthi_browser_request_consent" }),
    }));
    expect(browserBroker.getConsent(previewUrl)[0]).toEqual(expect.objectContaining({
      status: "unset",
      screenshot: "unset",
    }));
  });

  it("requires explicit screenshot consent for agent preview observe", async () => {
    const previewUrl = "http://localhost:5174/dashboard";
    mockPreviewAdapter(previewUrl);
    browserBroker.requestConsent(previewUrl, "granted", "unit", {
      screenshot: false,
      diagnostics: false,
    });

    const response = await dispatchBrowserTool("synthi_browser_observe_preview", {
      workspace_url: "http://localhost:3000/workspace/workspace-a",
      preview_url: previewUrl,
    });

    expect(response?.isError).toBe(true);
    expect(response?.structuredContent).toEqual(expect.objectContaining({
      error: "screenshot_consent_required",
      required_tool_call: expect.objectContaining({ name: "synthi_browser_request_consent" }),
    }));
    expect(browserBroker.getConsent(previewUrl)[0]).toEqual(expect.objectContaining({
      status: "granted",
      screenshot: "denied",
      diagnostics: "denied",
    }));
  });

  it("lets hosted overlay observe grant exact-origin screenshot consent from a user gesture", async () => {
    const previewUrl = "http://localhost:5174/dashboard";
    mockPreviewAdapter(previewUrl);
    browserBroker.setRuntimeAttachment({
      kind: "hosted",
      workspace_id: "workspace-a",
      runtime_id: "runtime-a",
      workspace_url: "http://localhost:3000/workspace/workspace-a",
      adapter: "unit-test",
    });

    const state = await browserWorkflowOverlayAction({
      action: "observe",
      url: previewUrl,
      tab_id: "",
      page_url: previewUrl,
    });

    expect(state).toEqual(expect.objectContaining({
      ok: true,
      observed: true,
      url: previewUrl,
    }));
    expect(browserBroker.getConsent(previewUrl)[0]).toEqual(expect.objectContaining({
      status: "granted",
      screenshot: "granted",
      diagnostics: "denied",
    }));
  });

  it("replays the requested saved workflow id instead of the current trace", async () => {
    const url = "https://app.example.com/dashboard";
    browserBroker.requestConsent(url);
    browserBroker.registerTabs([{ tab_id: "app", url, title: "Dashboard", active: true }]);
    expect(browserBroker.startTeachMode("app").ok).toBe(true);
    expect(browserBroker.recordHumanAction({
      tab_id: "app",
      url,
      origin: "https://app.example.com",
      action: "click",
      element: { tag: "button", role: "button", name: "Open reports" },
    }).ok).toBe(true);
    const workflowA = browserBroker.compiledWorkflow().contract.workflowId;

    expect(browserBroker.startTeachMode("app").ok).toBe(true);
    expect(browserBroker.recordHumanAction({
      tab_id: "app",
      url,
      origin: "https://app.example.com",
      action: "click",
      element: { tag: "button", role: "button", name: "Open billing" },
    }).ok).toBe(true);
    const workflowB = browserBroker.compiledWorkflow().contract.workflowId;
    expect(workflowB).not.toBe(workflowA);

    const action = vi.spyOn(browserPlaywrightAdapter, "action").mockResolvedValue({
      ok: true,
      action: "click",
      tab_id: "app",
      url,
    });
    const lease = browserBroker.acquireLease("agent", 5000, "workflow-id-replay");

    const replay = await dispatchBrowserTool("synthi_browser_run_workflow", {
      lease_id: lease.lease_id,
      tab_id: "app",
      workflow_id: workflowA,
      mode: "sameSession",
    });

    expect(replay?.isError).toBeUndefined();
    expect((replay?.structuredContent as { workflow_id: string; replay: { steps_run: number } })).toEqual(
      expect.objectContaining({
        workflow_id: workflowA,
        replay: expect.objectContaining({ steps_run: 1 }),
      })
    );
    expect(action).toHaveBeenCalledTimes(1);
    expect(action.mock.calls[0]?.[2]).toContain("Open reports");

    const missing = await dispatchBrowserTool("synthi_browser_run_workflow", {
      lease_id: lease.lease_id,
      tab_id: "app",
      workflow_id: "workflow_missing",
      mode: "sameSession",
    });
    expect(missing?.isError).toBe(true);
    expect(missing?.structuredContent).toEqual({
      error: "workflow_not_found",
      workflow_id: "workflow_missing",
    });
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("blocks auth-required workflow replay when live auth readiness is revoked", async () => {
    const url = "https://secure.example.com/settings";
    browserBroker.requestConsent(url);
    browserBroker.registerTabs([{ tab_id: "app", url, active: true }]);
    browserBroker.selectTab("app");
    const enrollment = authCheckpointManager.beginEnrollment(url);
    const checkpoint = authCheckpointManager.finishEnrollment({
      enrollment_id: enrollment.enrollment_id,
      ttl_ms: 60_000,
    });
    expect(checkpoint.ok).toBe(true);
    if (!checkpoint.ok) throw new Error("unexpected checkpoint failure");
    expect(authCheckpointManager.saveStorageArtifact({
      checkpoint_id: checkpoint.checkpoint.checkpoint_id,
      storage_state: {
        cookies: [{ name: "sid", value: "secure-cookie", domain: "secure.example.com", path: "/" }],
        origins: [{ origin: "https://secure.example.com", localStorage: [{ name: "session", value: "secure-local" }] }],
      },
    }).ok).toBe(true);
    expect(browserBroker.startTeachMode("app").ok).toBe(true);
    expect(browserBroker.recordHumanAction({
      tab_id: "app",
      url,
      origin: "https://secure.example.com",
      action: "click",
      element: { tag: "button", role: "button", name: "Open secure panel" },
    }).ok).toBe(true);
    const workflowId = browserBroker.compiledWorkflow().contract.workflowId;
    authCheckpointManager.revoke(checkpoint.checkpoint.checkpoint_id);
    const lease = browserBroker.acquireLease("agent", 5000, "auth-replay");
    const replay = vi.spyOn(browserPlaywrightAdapter, "replayActionEvent").mockResolvedValue({
      ok: true,
      action: "click",
      tab_id: "app",
      url,
    });

    const response = await dispatchBrowserTool("synthi_browser_run_workflow", {
      lease_id: lease.lease_id,
      tab_id: "app",
      workflow_id: workflowId,
      mode: "sameSession",
    });

    expect(response?.isError).toBe(true);
    expect(response?.structuredContent).toEqual(expect.objectContaining({
      error: "workflow_auth_not_ready",
      workflow_id: workflowId,
      auth_status: "checkpointRevoked",
      unattended: false,
    }));
    expect(replay).not.toHaveBeenCalled();
  });

  it("captures hosted auth storage through a broker-owned artifact without returning values", async () => {
    const url = "https://secure.example.com/settings";
    browserBroker.requestConsent(url);
    browserBroker.registerTabs([{ tab_id: "app", url, active: true }]);
    browserBroker.selectTab("app");
    browserBroker.setRuntimeAttachment({
      kind: "hosted",
      workspace_id: "workspace-a",
      runtime_id: "runtime-a",
      workspace_url: "https://ide.example.com/workspace/a",
      adapter: "unit-test",
    });
    const enrollment = authCheckpointManager.beginEnrollment(url);
    const checkpoint = authCheckpointManager.finishEnrollment({
      enrollment_id: enrollment.enrollment_id,
      app_url: url,
      redirect_chain: ["https://idp.example.com/login"],
      ttl_ms: 60_000,
    });
    expect(checkpoint.ok).toBe(true);
    if (!checkpoint.ok) throw new Error("unexpected checkpoint failure");
    const capture = vi.spyOn(browserPlaywrightAdapter, "captureAuthStorageState").mockResolvedValue({
      cookies: [
        { name: "sid", value: "secret-cookie-value", domain: "secure.example.com", path: "/" },
        { name: "idp", value: "secret-idp-cookie", domain: "idp.example.com", path: "/" },
      ],
      origins: [
        {
          origin: "https://secure.example.com",
          localStorage: [{ name: "session", value: "secret-local" }],
          sessionStorage: [{ name: "csrf", value: "secret-session" }],
        },
      ],
    });

    const response = await dispatchBrowserTool("synthi_browser_capture_auth_checkpoint_storage", {
      checkpoint_id: checkpoint.checkpoint.checkpoint_id,
      tab_id: "app",
    });

    expect(response?.isError).toBeUndefined();
    expect(capture).toHaveBeenCalledWith("app", ["https://secure.example.com", "https://idp.example.com"]);
    const bodyText = JSON.stringify(response?.structuredContent);
    expect(bodyText).not.toMatch(/secret-cookie|secret-local|secret-session|secret-idp/);
    expect(response?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      checkpoint_id: checkpoint.checkpoint.checkpoint_id,
      storage_artifact: expect.objectContaining({
        app_origin: "https://secure.example.com",
        cookie_count: 2,
        local_storage_entry_count: 1,
        session_storage_entry_count: 1,
      }),
      auth_readiness: expect.objectContaining({
        ready: true,
        status: "ready",
      }),
    }));
    expect(authCheckpointManager.storageArtifactForCheckpoint(checkpoint.checkpoint.checkpoint_id)?.state.origins[0]?.localStorage?.[0]).toEqual({
      name: "session",
      value: "secret-local",
    });
  });

  it("restores captured auth storage internally for cold workflow replay", async () => {
    const url = "https://secure.example.com/settings";
    browserBroker.requestConsent(url);
    browserBroker.registerTabs([{ tab_id: "app", url, active: true }]);
    browserBroker.selectTab("app");
    const enrollment = authCheckpointManager.beginEnrollment(url);
    const checkpoint = authCheckpointManager.finishEnrollment({
      enrollment_id: enrollment.enrollment_id,
      app_url: url,
      ttl_ms: 60_000,
    });
    expect(checkpoint.ok).toBe(true);
    if (!checkpoint.ok) throw new Error("unexpected checkpoint failure");
    expect(authCheckpointManager.saveStorageArtifact({
      checkpoint_id: checkpoint.checkpoint.checkpoint_id,
      storage_state: {
        cookies: [{ name: "sid", value: "secret-cookie-value", domain: "secure.example.com", path: "/" }],
        origins: [{
          origin: "https://secure.example.com",
          localStorage: [{ name: "session", value: "secret-local" }],
          sessionStorage: [{ name: "csrf", value: "secret-session" }],
        }],
      },
    }).ok).toBe(true);
    expect(browserBroker.startTeachMode("app").ok).toBe(true);
    expect(browserBroker.recordHumanAction({
      tab_id: "app",
      url,
      origin: "https://secure.example.com",
      action: "click",
      element: { tag: "button", role: "button", name: "Open secure panel" },
    }).ok).toBe(true);
    const workflowId = browserBroker.compiledWorkflow().contract.workflowId;
    const openCold = vi.spyOn(browserPlaywrightAdapter, "openCold").mockResolvedValue({ tab_id: "cold", url });
    vi.spyOn(browserPlaywrightAdapter, "listTabs").mockResolvedValue([{ tab_id: "cold", url, active: true }]);
    const replay = vi.spyOn(browserPlaywrightAdapter, "replayActionEvent").mockResolvedValue({
      ok: true,
      action: "click",
      tab_id: "cold",
      url,
    });
    const lease = browserBroker.acquireLease("agent", 5000, "auth-cold-replay");

    const response = await dispatchBrowserTool("synthi_browser_run_workflow", {
      lease_id: lease.lease_id,
      tab_id: "app",
      workflow_id: workflowId,
      mode: "coldSession",
    });

    expect(response?.isError).toBeUndefined();
    expect(openCold).toHaveBeenCalledWith(url, expect.objectContaining({
      cookies: [expect.objectContaining({ name: "sid", value: "secret-cookie-value" })],
      origins: [expect.objectContaining({
        origin: "https://secure.example.com",
        localStorage: [expect.objectContaining({ name: "session", value: "secret-local" })],
        sessionStorage: [expect.objectContaining({ name: "csrf", value: "secret-session" })],
      })],
    }));
    expect(replay).toHaveBeenCalledWith("cold", expect.any(Object), "click", expect.stringContaining("Open secure panel"), undefined);
    expect(JSON.stringify(response?.structuredContent)).not.toMatch(/secret-cookie|secret-local|secret-session/);
  });

  it("exports saved mutation workflows in prefix-only mode by default", async () => {
    const url = "https://app.example.com/query";
    browserBroker.requestConsent(url);
    browserBroker.registerTabs([{ tab_id: "app", url, title: "Query", active: true }]);
    expect(browserBroker.startTeachMode("app").ok).toBe(true);
    expect(browserBroker.recordHumanAction({
      tab_id: "app",
      url,
      origin: "https://app.example.com",
      action: "click",
      detail: {
        network_method: "POST",
        network_url: "https://app.example.com/api/query",
      },
      element: { tag: "button", role: "button", name: "Run query" },
    }).ok).toBe(true);
    const workflowId = browserBroker.compiledWorkflow().contract.workflowId;

    const generated = await dispatchBrowserTool("synthi_browser_generate_script", {
      workflow_id: workflowId,
    });

    expect(generated?.isError).toBeUndefined();
    const body = generated?.structuredContent as { mode: string; code: string };
    expect(body.mode).toBe("prefixOnly");
    expect(body.code).toContain("// Mutation boundary:");
    expect(body.code).toContain("await expect(target1).toBeEnabled();");
    expect(body.code).not.toContain("await target1.click();");
  });

  it("replays native drag workflows whose drop target is stored in event detail", async () => {
    const url = "https://app.example.com/board";
    const dropLocator = "page.getByRole(\"list\", { name: \"Done\" })";
    browserBroker.requestConsent(url);
    browserBroker.registerTabs([{ tab_id: "app", url, title: "Board", active: true }]);
    expect(browserBroker.startTeachMode("app").ok).toBe(true);
    expect(browserBroker.recordHumanAction({
      tab_id: "app",
      url,
      origin: "https://app.example.com",
      action: "drag",
      detail: {
        drag_mode: true,
        drag_class: "nativeHtmlDnd",
        drop_locator: dropLocator,
      },
      element: { tag: "div", role: "listitem", name: "Revenue audit" },
    }).ok).toBe(true);
    const workflowId = browserBroker.compiledWorkflow().contract.workflowId;

    const action = vi.spyOn(browserPlaywrightAdapter, "action").mockResolvedValue({
      ok: true,
      action: "drag",
      tab_id: "app",
      url,
    });
    const lease = browserBroker.acquireLease("agent", 5000, "detail-drop-locator");

    const replay = await dispatchBrowserTool("synthi_browser_run_workflow", {
      lease_id: lease.lease_id,
      tab_id: "app",
      workflow_id: workflowId,
      mode: "sameSession",
    });

    expect(replay?.isError).toBeUndefined();
    expect((replay?.structuredContent as { ok: boolean; replay: { steps_run: number } })).toEqual(expect.objectContaining({
      ok: true,
      replay: expect.objectContaining({ steps_run: 1 }),
    }));
    expect(action).toHaveBeenCalledTimes(1);
    expect(action).toHaveBeenCalledWith("app", "drag", expect.stringContaining("Revenue audit"), dropLocator);
  });

  it("replays calibrated pointer drags through the event-aware adapter path", async () => {
    const url = "https://app.example.com/board";
    const dropLocator = "page.getByRole(\"list\", { name: \"Done\" })";
    browserBroker.requestConsent(url);
    browserBroker.registerTabs([{ tab_id: "app", url, title: "Board", active: true }]);
    expect(browserBroker.startTeachMode("app").ok).toBe(true);
    expect(browserBroker.recordHumanAction({
      tab_id: "app",
      url,
      origin: "https://app.example.com",
      action: "drag",
      value: dropLocator,
      detail: {
        drag_mode: true,
        drag_class: "pointerSensor",
        pointer_drag: true,
        pointer_replay: "calibrated",
        pointer_start_x_ratio: 0.5,
        pointer_start_y_ratio: 0.5,
        pointer_end_x_ratio: 0.5,
        pointer_end_y_ratio: 0.5,
        pointer_steps: 12,
        drop_locator: dropLocator,
      },
      element: { tag: "div", role: "listitem", name: "Revenue audit", source_id: "board.revenue" },
    }).ok).toBe(true);
    const workflowId = browserBroker.compiledWorkflow().contract.workflowId;
    const replayAction = vi.spyOn(browserPlaywrightAdapter, "replayActionEvent").mockResolvedValue({
      ok: true,
      action: "drag",
      tab_id: "app",
      url,
      detail: { pointer_replay: "calibrated" },
    });
    const lease = browserBroker.acquireLease("agent", 5000, "calibrated-pointer-drag");

    const replay = await dispatchBrowserTool("synthi_browser_run_workflow", {
      lease_id: lease.lease_id,
      tab_id: "app",
      workflow_id: workflowId,
      mode: "sameSession",
    });

    expect(replay?.isError).toBeUndefined();
    expect((replay?.structuredContent as { ok: boolean; replay: { steps_run: number } })).toEqual(expect.objectContaining({
      ok: true,
      replay: expect.objectContaining({ steps_run: 1 }),
    }));
    expect(replayAction).toHaveBeenCalledWith(
      "app",
      expect.objectContaining({
        action: "drag",
        value: dropLocator,
        detail: expect.objectContaining({
          pointer_replay: "calibrated",
          drop_locator: dropLocator,
        }),
      }),
      "drag",
      expect.stringContaining("board.revenue"),
      dropLocator
    );
  });

  it("replays calibrated resize-handle drags through the event-aware adapter path", async () => {
    const url = "https://app.example.com/workspace";
    const dropLocator = "page.getByRole(\"group\", { name: \"Resizable workspace\" })";
    browserBroker.requestConsent(url);
    browserBroker.registerTabs([{ tab_id: "app", url, title: "Workspace", active: true }]);
    expect(browserBroker.startTeachMode("app").ok).toBe(true);
    expect(browserBroker.recordHumanAction({
      tab_id: "app",
      url,
      origin: "https://app.example.com",
      action: "drag",
      value: dropLocator,
      detail: {
        drag_mode: true,
        drag_class: "pointerSensor",
        pointer_drag: true,
        pointer_replay: "calibrated",
        pointer_start_x_ratio: 0.5,
        pointer_start_y_ratio: 0.5,
        pointer_end_x_ratio: 0.58,
        pointer_end_y_ratio: 0.5,
        pointer_steps: 10,
        drop_locator: dropLocator,
        resize_handle: true,
        resize_axis: "x",
        aria_orientation: "vertical",
      },
      element: { tag: "div", role: "separator", name: "Resize panels", source_id: "layout.resize.handle" },
    }).ok).toBe(true);
    const workflowId = browserBroker.compiledWorkflow().contract.workflowId;
    const replayAction = vi.spyOn(browserPlaywrightAdapter, "replayActionEvent").mockResolvedValue({
      ok: true,
      action: "drag",
      tab_id: "app",
      url,
      detail: { pointer_replay: "calibrated", resize_handle: true },
    });
    const lease = browserBroker.acquireLease("agent", 5000, "calibrated-resize-handle");

    const replay = await dispatchBrowserTool("synthi_browser_run_workflow", {
      lease_id: lease.lease_id,
      tab_id: "app",
      workflow_id: workflowId,
      mode: "sameSession",
    });

    expect(replay?.isError).toBeUndefined();
    expect((replay?.structuredContent as { ok: boolean; replay: { steps_run: number } })).toEqual(expect.objectContaining({
      ok: true,
      replay: expect.objectContaining({ steps_run: 1 }),
    }));
    expect(replayAction).toHaveBeenCalledWith(
      "app",
      expect.objectContaining({
        action: "drag",
        value: dropLocator,
        detail: expect.objectContaining({
          pointer_replay: "calibrated",
          drop_locator: dropLocator,
          resize_handle: true,
          resize_axis: "x",
        }),
      }),
      "drag",
      expect.stringContaining("layout.resize.handle"),
      dropLocator
    );
  });

  it("replays annotated popup workflow actions through the adapter replay path", async () => {
    const url = "https://app.example.com/dashboard";
    browserBroker.requestConsent(url);
    browserBroker.registerTabs([{ tab_id: "app", url, title: "Dashboard", active: true }]);
    expect(browserBroker.startTeachMode("app").ok).toBe(true);
    expect(browserBroker.recordHumanAction({
      tab_id: "app",
      url,
      origin: "https://app.example.com",
      action: "click",
      detail: {
        popup_event: true,
        popup_url: "https://app.example.com/help",
        popup_title: "Workflow Help",
      },
      element: { tag: "a", role: "button", name: "Open help", test_id: "open-help" },
    }).ok).toBe(true);
    const workflowId = browserBroker.compiledWorkflow().contract.workflowId;
    const replayAction = vi.spyOn(browserPlaywrightAdapter, "replayActionEvent").mockResolvedValue({
      ok: true,
      action: "click",
      tab_id: "app",
      url,
      detail: { popup_url: "https://app.example.com/help" },
    });
    const lease = browserBroker.acquireLease("agent", 5000, "popup-replay");

    const replay = await dispatchBrowserTool("synthi_browser_run_workflow", {
      lease_id: lease.lease_id,
      tab_id: "app",
      workflow_id: workflowId,
      mode: "sameSession",
    });

    expect(replay?.isError).toBeUndefined();
    expect((replay?.structuredContent as { ok: boolean; replay: { steps_run: number } })).toEqual(expect.objectContaining({
      ok: true,
      replay: expect.objectContaining({ steps_run: 1 }),
    }));
    expect(replayAction).toHaveBeenCalledTimes(1);
    expect(replayAction.mock.calls[0]?.[1].detail).toEqual(expect.objectContaining({
      popup_event: true,
      popup_url: "https://app.example.com/help",
    }));
  });

  it("replays same-origin popup continuation steps on the runtime popup tab", async () => {
    const url = "https://app.example.com/dashboard";
    const popupUrl = "https://app.example.com/help";
    browserBroker.requestConsent(url);
    browserBroker.registerTabs([{ tab_id: "app", url, title: "Dashboard", active: true }]);
    expect(browserBroker.startTeachMode("app").ok).toBe(true);
    expect(browserBroker.recordHumanAction({
      tab_id: "app",
      url,
      origin: "https://app.example.com",
      action: "click",
      detail: {
        popup_event: true,
        popup_url: popupUrl,
        popup_title: "Workflow Help",
        popup_tab_id: "recorded-popup",
        opener_tab_id: "app",
      },
      element: { tag: "a", role: "button", name: "Open help", test_id: "open-help", source_id: "src_open_help" },
    }).ok).toBe(true);
    expect(browserBroker.recordHumanAction({
      tab_id: "recorded-popup",
      url: popupUrl,
      origin: "https://app.example.com",
      action: "fill",
      value: "contracts",
      detail: {
        popup_context: true,
        popup_tab_id: "recorded-popup",
        opener_tab_id: "app",
        opener_origin: "https://app.example.com",
      },
      element: { tag: "input", role: "textbox", label: "Search help", source_id: "src_help_search" },
    }).ok).toBe(true);
    const workflowId = browserBroker.compiledWorkflow().contract.workflowId;
    const replayAction = vi.spyOn(browserPlaywrightAdapter, "replayActionEvent").mockImplementation(async (tabId, event, action) => ({
      ok: true,
      action,
      tab_id: tabId,
      url: event.url,
      detail: event.detail?.["popup_event"] === true ? { popup_tab_id: "runtime-popup" } : undefined,
    }));
    const lease = browserBroker.acquireLease("agent", 5000, "popup-continuation-replay");

    const replay = await dispatchBrowserTool("synthi_browser_run_workflow", {
      lease_id: lease.lease_id,
      tab_id: "app",
      workflow_id: workflowId,
      mode: "sameSession",
    });

    expect(replay?.isError).toBeUndefined();
    expect((replay?.structuredContent as { ok: boolean; replay: { steps_run: number } })).toEqual(expect.objectContaining({
      ok: true,
      replay: expect.objectContaining({ steps_run: 2 }),
    }));
    expect(replayAction.mock.calls[0]?.[0]).toBe("app");
    expect(replayAction.mock.calls[1]?.[0]).toBe("runtime-popup");
    expect(replayAction.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      action: "fill",
      tab_id: "recorded-popup",
      value: "contracts",
    }));
  });

  it("replays range control workflows through the event-aware adapter path", async () => {
    const url = "https://app.example.com/settings";
    browserBroker.requestConsent(url);
    browserBroker.registerTabs([{ tab_id: "app", url, title: "Settings", active: true }]);
    expect(browserBroker.startTeachMode("app").ok).toBe(true);
    expect(browserBroker.recordHumanAction({
      tab_id: "app",
      url,
      origin: "https://app.example.com",
      action: "fill",
      value: "75",
      detail: {
        control_kind: "range",
        range_control: true,
        min: "0",
        max: "100",
        step: "5",
      },
      element: { tag: "input", type: "range", label: "Budget", source_id: "settings.budget" },
    }).ok).toBe(true);
    const workflowId = browserBroker.compiledWorkflow().contract.workflowId;
    const replayAction = vi.spyOn(browserPlaywrightAdapter, "replayActionEvent").mockResolvedValue({
      ok: true,
      action: "fill",
      tab_id: "app",
      url,
      detail: { control_kind: "range", value: "75" },
    });
    const lease = browserBroker.acquireLease("agent", 5000, "range-replay");

    const replay = await dispatchBrowserTool("synthi_browser_run_workflow", {
      lease_id: lease.lease_id,
      tab_id: "app",
      workflow_id: workflowId,
      mode: "sameSession",
    });

    expect(replay?.isError).toBeUndefined();
    expect((replay?.structuredContent as { ok: boolean; replay: { steps_run: number } })).toEqual(expect.objectContaining({
      ok: true,
      replay: expect.objectContaining({ steps_run: 1 }),
    }));
    expect(replayAction).toHaveBeenCalledWith(
      "app",
      expect.objectContaining({
        action: "fill",
        value: "75",
        detail: expect.objectContaining({ control_kind: "range", range_control: true }),
      }),
      "fill",
      expect.stringContaining("settings.budget"),
      "75"
    );
  });

  it("replays native multi-select workflows with all selected values", async () => {
    const url = "https://app.example.com/settings";
    browserBroker.requestConsent(url);
    browserBroker.registerTabs([{ tab_id: "app", url, title: "Settings", active: true }]);
    expect(browserBroker.startTeachMode("app").ok).toBe(true);
    expect(browserBroker.recordHumanAction({
      tab_id: "app",
      url,
      origin: "https://app.example.com",
      action: "select",
      value: JSON.stringify(["qa", "design"]),
      detail: {
        multiple_select: true,
        select_values: ["qa", "design"],
        selected_option_labels: ["QA", "Design"],
      },
      element: { tag: "select", role: "combobox", label: "Teams", source_id: "settings.teams" },
    }).ok).toBe(true);
    const workflowId = browserBroker.compiledWorkflow().contract.workflowId;
    const replayAction = vi.spyOn(browserPlaywrightAdapter, "replayActionEvent").mockResolvedValue({
      ok: true,
      action: "select",
      tab_id: "app",
      url,
      detail: { select_values: ["qa", "design"] },
    });
    const lease = browserBroker.acquireLease("agent", 5000, "multi-select-replay");

    const replay = await dispatchBrowserTool("synthi_browser_run_workflow", {
      lease_id: lease.lease_id,
      tab_id: "app",
      workflow_id: workflowId,
      mode: "sameSession",
    });

    expect(replay?.isError).toBeUndefined();
    expect((replay?.structuredContent as { ok: boolean; replay: { steps_run: number } })).toEqual(expect.objectContaining({
      ok: true,
      replay: expect.objectContaining({ steps_run: 1 }),
    }));
    expect(replayAction).toHaveBeenCalledWith(
      "app",
      expect.objectContaining({
        action: "select",
        detail: expect.objectContaining({
          multiple_select: true,
          select_values: ["qa", "design"],
        }),
      }),
      "select",
      expect.stringContaining("settings.teams"),
      "[\"qa\",\"design\"]"
    );
  });

  it("replays custom code editor fills through the event-aware adapter path", async () => {
    const url = "https://app.example.com/editor";
    browserBroker.requestConsent(url);
    browserBroker.registerTabs([{ tab_id: "app", url, title: "Editor", active: true }]);
    expect(browserBroker.startTeachMode("app").ok).toBe(true);
    expect(browserBroker.recordHumanAction({
      tab_id: "app",
      url,
      origin: "https://app.example.com",
      action: "fill",
      value: "function run() { return 42; }",
      detail: {
        editor_surface: "codemirror",
        editor_backing: "hiddenTextarea",
        editor_replay_strategy: "keyboardInsert",
      },
      element: {
        tag: "div",
        role: "textbox",
        name: "Query editor",
        test_id: "query-editor",
        source_id: "editor.query",
        editor_surface: "codemirror",
        editor_backing: "hiddenTextarea",
        editor_replay_strategy: "keyboardInsert",
      },
    }).ok).toBe(true);
    const workflowId = browserBroker.compiledWorkflow().contract.workflowId;
    const replayAction = vi.spyOn(browserPlaywrightAdapter, "replayActionEvent").mockResolvedValue({
      ok: true,
      action: "fill",
      tab_id: "app",
      url,
      detail: { editor_replay_strategy: "keyboardInsert" },
    });
    const lease = browserBroker.acquireLease("agent", 5000, "editor-replay");

    const replay = await dispatchBrowserTool("synthi_browser_run_workflow", {
      lease_id: lease.lease_id,
      tab_id: "app",
      workflow_id: workflowId,
      mode: "sameSession",
    });

    expect(replay?.isError).toBeUndefined();
    expect((replay?.structuredContent as { ok: boolean; replay: { steps_run: number } })).toEqual(expect.objectContaining({
      ok: true,
      replay: expect.objectContaining({ steps_run: 1 }),
    }));
    expect(replayAction).toHaveBeenCalledWith(
      "app",
      expect.objectContaining({
        action: "fill",
        detail: expect.objectContaining({ editor_replay_strategy: "keyboardInsert" }),
      }),
      "fill",
      expect.stringContaining("query-editor"),
      "function run() { return 42; }"
    );
  });

  it("requires a caller-provided or environment-provided CDP endpoint for browser attach", async () => {
    const response = await dispatchBrowserTool("synthi_browser_attach", {});

    expect(response?.isError).toBe(true);
    expect(response?.structuredContent).toEqual({
      error: "browser_cdp_url_required",
      env: "SYNTHI_BROWSER_CDP_URL",
      arg: "cdp_url",
    });
    expect(browserBridgeServer.isRunning()).toBe(false);
  });

  it("keeps hosted workspace attach separate from the local CDP harness", async () => {
    process.env["SYNTHI_BROWSER_CDP_URL"] = "http://127.0.0.1:9222";
    const response = await dispatchBrowserTool("synthi_browser_attach_current_workspace", {
      workspace_id: "workspace-a",
      workspace_url: "https://workspace.example.test/workspace/browser",
    });

    expect(response?.isError).toBe(true);
    expect(response?.structuredContent).toEqual(expect.objectContaining({
      error: "hosted_runtime_not_configured",
      low_level_local_dev_tool: "synthi_browser_attach",
    }));
    expect((response?.structuredContent as {
      runtime: { configured: boolean; ignored_local_dev_env: string[]; required_env: string[] };
    }).runtime).toEqual(expect.objectContaining({
      configured: false,
      ignored_local_dev_env: ["SYNTHI_BROWSER_CDP_URL"],
      required_env: ["SYNTHI_HOSTED_BROWSER_CDP_URL"],
    }));
    expect(browserBroker.runtimeAttachment()).toBeNull();
  });

  it("returns high-level workflow diagnostics without requiring raw trace reads", async () => {
    browserBroker.requestConsent("https://app.example.com");
    browserBroker.registerTabs([{ tab_id: "app", url: "https://app.example.com/settings", active: true }]);
    expect(browserBroker.startTeachMode("app").ok).toBe(true);
    browserBroker.recordHumanAction({
      tab_id: "app",
      url: "https://app.example.com/settings",
      origin: "https://app.example.com",
      action: "click",
      element: {},
    });

    const status = await dispatchBrowserTool("synthi_browser_get_trace_status", {});
    expect(status?.isError).toBeUndefined();
    expect((status?.structuredContent as {
      trace_status: {
        event_count: number;
        action_count: number;
        origins: string[];
        workflow_state: string[];
        unresolved_count: number;
        lane0: { annotated_event_count: number };
      };
    }).trace_status).toEqual(expect.objectContaining({
      event_count: 1,
      action_count: 1,
      origins: ["https://app.example.com"],
      unresolved_count: 1,
      lane0: expect.objectContaining({ annotated_event_count: 1 }),
    }));
    expect((status?.structuredContent as { trace_status: { workflow_state: string[] } }).trace_status.workflow_state).toContain("Limited");

    const lane0 = await dispatchBrowserTool("synthi_browser_get_lane0_status", {});
    expect(lane0?.isError).toBeUndefined();
    expect((lane0?.structuredContent as { lane0: { reducer_version: string; annotated_event_count: number } }).lane0).toEqual(
      expect.objectContaining({ reducer_version: "lane0_deterministic_v1", annotated_event_count: 1 })
    );

    const answered = await dispatchBrowserTool("synthi_browser_answer_teach_question", {
      question_id: "q_source_1",
      step_id: "browser_evt_1",
      answer: "Use the stable affordance",
      accepted_affordance: "data-synthi-affordance=\"recorded.target\"",
    });
    expect(answered?.isError).toBeUndefined();
    expect((answered?.structuredContent as { teach_question_answers_count: number; answer: { question_id: string } })).toEqual(
      expect.objectContaining({
        teach_question_answers_count: 1,
        answer: expect.objectContaining({ question_id: "q_source_1" }),
      })
    );

    const card = await dispatchBrowserTool("synthi_browser_get_workflow_card", {});
    expect(card?.isError).toBeUndefined();
    expect((card?.structuredContent as { card: { title: string; primaryCta: string } }).card).toEqual(
      expect.objectContaining({ title: "Recorded target", primaryCta: "reviewLimitations" })
    );

    const unresolved = await dispatchBrowserTool("synthi_browser_get_unresolved_steps", {});
    expect(unresolved?.isError).toBeUndefined();
    expect((unresolved?.structuredContent as { steps: Array<{ limitations: string[]; suggested_affordances: unknown[] }> }).steps[0]).toEqual(
      expect.objectContaining({
        limitations: expect.arrayContaining(["sourceIdentityMissing", "unresolvedStep"]),
        suggested_affordances: expect.arrayContaining([
          expect.objectContaining({ suggested_attribute: "data-synthi-affordance=\"recorded.target\"" }),
        ]),
      })
    );

    const explanation = await dispatchBrowserTool("synthi_browser_explain_failure", {
      failure_class: "closedShadowDomBlocked",
      failed_step_id: "browser_evt_1",
    });
    expect(explanation?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      failure_class: "closedShadowDomBlocked",
      failed_step_id: "browser_evt_1",
      workflow_id: expect.any(String),
      failed_step: expect.objectContaining({
        step_id: "browser_evt_1",
        label: "Click recorded target",
        action: "click",
        locator_confidence: "none",
        source_status: "missing",
        limitations: expect.arrayContaining(["sourceIdentityMissing", "unresolvedStep"]),
        suggested_next_tool: "synthi_browser_get_unresolved_steps",
      }),
      suggested_next_action: expect.stringContaining("shadow bridge"),
    }));

    const statusAfterAnswer = await dispatchBrowserTool("synthi_browser_get_trace_status", {});
    expect((statusAfterAnswer?.structuredContent as {
      trace_status: { teach_question_answers_count: number };
    }).trace_status.teach_question_answers_count).toBe(1);
  });

  it("supports primary begin/end teach aliases with workflow card output", async () => {
    browserBroker.requestConsent("https://app.example.com");
    browserBroker.registerTabs([{ tab_id: "app", url: "https://app.example.com/settings", active: true }]);

    const begin = await dispatchBrowserTool("synthi_browser_begin_teach", {
      tab_id: "app",
      goal: "Save settings",
    });
    expect(begin?.isError).toBeUndefined();
    expect((begin?.structuredContent as { primary_tool: string; goal: string; teach: { active: boolean } })).toEqual(
      expect.objectContaining({
        primary_tool: "synthi_browser_begin_teach",
        goal: "Save settings",
        teach: expect.objectContaining({ active: true }),
      })
    );

    browserBroker.recordHumanAction({
      tab_id: "app",
      url: "https://app.example.com/settings",
      origin: "https://app.example.com",
      action: "click",
      element: { tag: "button", role: "button", name: "Save settings", source_id: "s_save" },
    });

    const end = await dispatchBrowserTool("synthi_browser_end_teach", { reason: "complete" });
    expect(end?.isError).toBeUndefined();
    expect((end?.structuredContent as {
      primary_tool: string;
      card: { title: string; stepCount: number };
      replay: { first_mutation_step_id: string };
    })).toEqual(expect.objectContaining({
      primary_tool: "synthi_browser_end_teach",
      card: expect.objectContaining({ title: "Save settings", stepCount: 1 }),
      replay: expect.objectContaining({ first_mutation_step_id: "browser_evt_1" }),
    }));
  });

  it("summarizes hosted toolbox state without exposing taught values", async () => {
    const url = "https://app.example.com/settings";
    browserBroker.setRuntimeAttachment({
      kind: "hosted",
      workspace_id: "workspace-a",
      runtime_id: "runtime-a",
      workspace_url: "https://workspace.example.test/workspace/workspace-a",
      adapter: "unit-test",
    });
    browserBroker.requestConsent(url);
    browserBroker.registerTabs([{ tab_id: "app", url, title: "Settings", active: true }]);
    browserBroker.selectTab("app");
    expect(browserBroker.startTeachMode("app").ok).toBe(true);
    expect(browserBroker.recordHumanAction({
      tab_id: "app",
      url,
      origin: "https://app.example.com",
      action: "fill",
      value: "do-not-expose",
      field_name: "API token",
      element: { tag: "input", role: "textbox", label: "API token", source_id: "s_token" },
    }).ok).toBe(true);

    const state = await browserWorkflowOverlayAction({
      action: "state",
      tab_id: "app",
      page_url: url,
    });

    expect(state).toEqual(expect.objectContaining({
      ok: true,
      status: "recording",
      label: "Recording",
      recording: true,
      observed: true,
      stepCount: 1,
      lastAction: "Filled",
      lastTarget: "API token",
      url,
    }));
    expect(JSON.stringify(state)).not.toContain("do-not-expose");
  });

  it("requires file path parameters before replaying taught file drops", async () => {
    const url = "https://app.example.com/uploads";
    browserBroker.requestConsent(url);
    browserBroker.registerTabs([{ tab_id: "app", url, active: true }]);
    expect(browserBroker.startTeachMode("app").ok).toBe(true);
    expect(browserBroker.recordHumanAction({
      tab_id: "app",
      url,
      origin: "https://app.example.com",
      action: "drag",
      detail: {
        drag_mode: true,
        drag_class: "fileDrop",
        file_parameter: "UPLOAD_FILE",
      },
      element: { role: "button", name: "Upload area", source_id: "s_upload" },
    }).ok).toBe(true);
    const lease = browserBroker.acquireLease("agent", 5000, "test-file-drop");

    const replay = await dispatchBrowserTool("synthi_browser_run_workflow", {
      lease_id: lease.lease_id,
      tab_id: "app",
      mode: "sameSession",
    });

    expect(replay?.isError).toBeUndefined();
    expect((replay?.structuredContent as {
      ok: boolean;
      replay: { status: string; failure_class: string; failed_step_id: string; error: string };
    })).toEqual(expect.objectContaining({
      ok: false,
      replay: expect.objectContaining({
        status: "failed",
        failure_class: "testDataMissing",
        failed_step_id: "browser_evt_1",
        error: "missing_file_parameter:upload_file",
      }),
    }));
  });

  it("requires and forwards clipboard paste parameters for workflow replay", async () => {
    const url = "https://app.example.com/settings";
    browserBroker.requestConsent(url);
    browserBroker.registerTabs([{ tab_id: "app", url, active: true }]);
    expect(browserBroker.startTeachMode("app").ok).toBe(true);
    expect(browserBroker.recordHumanAction({
      tab_id: "app",
      url,
      origin: "https://app.example.com",
      action: "fill",
      detail: {
        clipboard_event: true,
        clipboard_mode: "paste",
        paste_event: true,
        paste_parameter: "API_TOKEN_PASTE",
      },
      element: { tag: "input", role: "textbox", label: "API token", source_id: "s_token" },
    }).ok).toBe(true);
    const lease = browserBroker.acquireLease("agent", 5000, "test-clipboard-paste");
    const replayAction = vi.spyOn(browserPlaywrightAdapter, "replayActionEvent").mockResolvedValue({
      ok: true,
      action: "fill",
      tab_id: "app",
      url,
    });

    const missing = await dispatchBrowserTool("synthi_browser_run_workflow", {
      lease_id: lease.lease_id,
      tab_id: "app",
      mode: "sameSession",
    });

    expect((missing?.structuredContent as {
      ok: boolean;
      replay: { status: string; failure_class: string; failed_step_id: string; error: string };
    })).toEqual(expect.objectContaining({
      ok: false,
      replay: expect.objectContaining({
        status: "failed",
        failure_class: "testDataMissing",
        failed_step_id: "browser_evt_1",
        error: "missing_clipboard_parameter:api_token_paste",
      }),
    }));
    expect(replayAction).not.toHaveBeenCalled();

    const replay = await dispatchBrowserTool("synthi_browser_run_workflow", {
      lease_id: lease.lease_id,
      tab_id: "app",
      mode: "sameSession",
      parameters: { api_token_paste: "agent-provided-token" },
    });

    expect(replay?.isError).toBeUndefined();
    expect((replay?.structuredContent as { ok: boolean; replay: { steps_run: number } })).toEqual(expect.objectContaining({
      ok: true,
      replay: expect.objectContaining({ steps_run: 1 }),
    }));
    expect(replayAction).toHaveBeenCalledWith(
      "app",
      expect.objectContaining({ event_id: "browser_evt_1" }),
      "fill",
      expect.any(String),
      "agent-provided-token"
    );
  });

  it("requires and forwards clipboard drop parameters for workflow replay", async () => {
    const url = "https://app.example.com/settings";
    browserBroker.requestConsent(url);
    browserBroker.registerTabs([{ tab_id: "app", url, active: true }]);
    expect(browserBroker.startTeachMode("app").ok).toBe(true);
    expect(browserBroker.recordHumanAction({
      tab_id: "app",
      url,
      origin: "https://app.example.com",
      action: "drag",
      detail: {
        drag_mode: true,
        drag_class: "clipboardDrop",
        clipboard_event: true,
        clipboard_mode: "drop",
        clipboard_drop_event: true,
        clipboard_parameter: "RELEASE_NOTES_DROP",
      },
      element: { tag: "textarea", role: "textbox", label: "Release notes", source_id: "s_notes" },
    }).ok).toBe(true);
    const lease = browserBroker.acquireLease("agent", 5000, "test-clipboard-drop");
    const replayAction = vi.spyOn(browserPlaywrightAdapter, "replayActionEvent").mockResolvedValue({
      ok: true,
      action: "drag",
      tab_id: "app",
      url,
    });

    const missing = await dispatchBrowserTool("synthi_browser_run_workflow", {
      lease_id: lease.lease_id,
      tab_id: "app",
      mode: "sameSession",
    });

    expect((missing?.structuredContent as {
      ok: boolean;
      replay: { status: string; failure_class: string; failed_step_id: string; error: string };
    })).toEqual(expect.objectContaining({
      ok: false,
      replay: expect.objectContaining({
        status: "failed",
        failure_class: "testDataMissing",
        failed_step_id: "browser_evt_1",
        error: "missing_clipboard_drop_parameter:release_notes_drop",
      }),
    }));
    expect(replayAction).not.toHaveBeenCalled();

    const replay = await dispatchBrowserTool("synthi_browser_run_workflow", {
      lease_id: lease.lease_id,
      tab_id: "app",
      mode: "sameSession",
      parameters: { release_notes_drop: "agent dropped note" },
    });

    expect(replay?.isError).toBeUndefined();
    expect((replay?.structuredContent as { ok: boolean; replay: { steps_run: number } })).toEqual(expect.objectContaining({
      ok: true,
      replay: expect.objectContaining({ steps_run: 1 }),
    }));
    expect(replayAction).toHaveBeenCalledWith(
      "app",
      expect.objectContaining({ event_id: "browser_evt_1" }),
      "drag",
      expect.any(String),
      "agent dropped note"
    );
  });

  it("requires and forwards native prompt parameters for workflow replay", async () => {
    const url = "https://app.example.com/settings";
    browserBroker.requestConsent(url);
    browserBroker.registerTabs([{ tab_id: "app", url, active: true }]);
    expect(browserBroker.startTeachMode("app").ok).toBe(true);
    expect(browserBroker.recordHumanAction({
      tab_id: "app",
      url,
      origin: "https://app.example.com",
      action: "click",
      detail: {
        dialog_event: true,
        dialog_type: "prompt",
        dialog_message: "Enter workspace name",
        dialog_prompt_value: "[REDACTED]",
        dialog_prompt_value_redacted: true,
        dialog_accepted: true,
      },
      element: { role: "button", name: "Rename workspace", source_id: "s_rename_workspace" },
    }).ok).toBe(true);
    const lease = browserBroker.acquireLease("agent", 5000, "test-prompt-dialog");
    const replayAction = vi.spyOn(browserPlaywrightAdapter, "replayActionEvent").mockResolvedValue({
      ok: true,
      action: "click",
      tab_id: "app",
      url,
    });

    const missing = await dispatchBrowserTool("synthi_browser_run_workflow", {
      lease_id: lease.lease_id,
      tab_id: "app",
      mode: "sameSession",
    });

    expect((missing?.structuredContent as {
      ok: boolean;
      replay: { status: string; failure_class: string; failed_step_id: string; error: string };
    })).toEqual(expect.objectContaining({
      ok: false,
      replay: expect.objectContaining({
        status: "failed",
        failure_class: "testDataMissing",
        failed_step_id: "browser_evt_1",
        error: "missing_dialog_prompt_parameter:enter_workspace_name",
      }),
    }));
    expect(replayAction).not.toHaveBeenCalled();

    const replay = await dispatchBrowserTool("synthi_browser_run_workflow", {
      lease_id: lease.lease_id,
      tab_id: "app",
      mode: "sameSession",
      parameters: { enter_workspace_name: "Agent Workspace" },
    });

    expect(replay?.isError).toBeUndefined();
    expect((replay?.structuredContent as { ok: boolean; replay: { steps_run: number } })).toEqual(expect.objectContaining({
      ok: true,
      replay: expect.objectContaining({ steps_run: 1 }),
    }));
    expect(replayAction).toHaveBeenCalledWith(
      "app",
      expect.objectContaining({ event_id: "browser_evt_1" }),
      "click",
      expect.any(String),
      undefined,
      { dialogPromptValue: "Agent Workspace" }
    );
  });
});

function mockPreviewAdapter(previewUrl: string): void {
  const tab: BrowserTab = {
    tab_id: "preview",
    url: previewUrl,
    title: "Preview",
    active: true,
  };
  const snapshot: BrowserSnapshot = {
    tab_id: "preview",
    url: previewUrl,
    origin: new URL(previewUrl).origin,
    title: "Preview",
    screenshot_base64: Buffer.from("preview").toString("base64"),
    dom: { title: "Preview" },
  };
  vi.spyOn(browserPlaywrightAdapter, "openOrNavigate").mockResolvedValue(tab);
  vi.spyOn(browserPlaywrightAdapter, "open").mockResolvedValue(tab);
  vi.spyOn(browserPlaywrightAdapter, "listTabs").mockResolvedValue([
    { tab_id: "workspace", url: "http://localhost:3000/workspace/workspace-a", title: "Workspace", active: false },
    tab,
  ]);
  vi.spyOn(browserPlaywrightAdapter, "selectTab").mockResolvedValue(tab);
  vi.spyOn(browserPlaywrightAdapter, "snapshot").mockResolvedValue(snapshot);
}

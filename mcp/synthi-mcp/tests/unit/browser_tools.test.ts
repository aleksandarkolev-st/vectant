import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { browserBroker } from "../../src/browser/broker.js";
import { browserBridgeServer } from "../../src/browser/bridge_server.js";
import { eventLog } from "../../src/events/index.js";
import { ADVERTISED_TOOLS } from "../../src/tool_registry.js";
import { BROWSER_TOOL_NAMES, BROWSER_TOOLS, browserWorkflowOverlayAction, dispatchBrowserTool } from "../../src/tools/browser.js";

const originalBrowserCdpUrl = process.env["SYNTHI_BROWSER_CDP_URL"];
const originalHostedBrowserCdpUrl = process.env["SYNTHI_HOSTED_BROWSER_CDP_URL"];

beforeEach(() => {
  browserBroker.resetForTests();
  eventLog._resetForTests();
  delete process.env["SYNTHI_BROWSER_CDP_URL"];
  delete process.env["SYNTHI_HOSTED_BROWSER_CDP_URL"];
});

afterEach(async () => {
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

  it("denies snapshot before any authorized tab is selected", async () => {
    const response = await dispatchBrowserTool("synthi_browser_snapshot", {});
    expect(response?.isError).toBe(true);
    expect((response?.structuredContent as { error: string }).error).toBe("browser_tool_failed");
    expect((response?.structuredContent as { message: string }).message).toBe("tab_not_authorized");
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
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { browserBroker } from "../../src/browser/broker.js";
import { dojoSkillRegistry } from "../../src/browser/dojo.js";
import { browserPlaywrightAdapter } from "../../src/browser/playwright_adapter.js";
import { privateWorkflowToolRegistry } from "../../src/browser/private_tool_registry.js";
import { replayIsolationProfiles } from "../../src/browser/safety.js";
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
    dojoSkillRegistry.resetForTests();
    replayIsolationProfiles.resetForTests();
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

  it("hydrates replay isolation profile state for the workflows panel", async () => {
    const workspaceId = "workspace-a";
    replayIsolationProfiles.set({
      workspace_id: workspaceId,
      kind: "ciIsolated",
      base_url: "https://preview.example.test",
      ci_command: "npm run workflow:ci",
      data_reset_command: "npm run workflow:reset",
      reset_assertion_command: "npm run workflow:assert-reset",
      postcondition_command: "npm run workflow:assert-saved",
      reset_profile_id: "release-reset-v1",
      state_seed_id: "release-fixture-v1",
      allow_mutation_replay: true,
    });
    browserBroker.setRuntimeAttachment({
      kind: "hosted",
      workspace_id: workspaceId,
      runtime_id: "runtime-a",
      workspace_url: "https://ide.example.test/workspace/workspace-a",
      adapter: "hosted-playwright-cdp",
    });

    const state = buildBrowserWorkflowPanelState() as {
      isolation_profile: {
        workspace_id: string;
        readiness: string;
        can_run_full_mutation_replay: boolean;
      };
      profile_manifest: {
        schema_version: string;
        commands: Record<string, string>;
        reset_profile_id: string;
        state_seed_id: string;
      };
      mutation_plan: { ci_full_replay: { blockers: string[] } };
    };

    expect(state.isolation_profile).toEqual(expect.objectContaining({
      workspace_id: workspaceId,
      readiness: "ciIsolatedReady",
      can_run_full_mutation_replay: true,
    }));
    expect(state.profile_manifest).toEqual(expect.objectContaining({
      schema_version: "synthi.replayIsolationProfile.v1",
      reset_profile_id: "release-reset-v1",
      state_seed_id: "release-fixture-v1",
      commands: expect.objectContaining({
        ci: "npm run workflow:ci",
        data_reset: "npm run workflow:reset",
        reset_assertion: "npm run workflow:assert-reset",
        postcondition: "npm run workflow:assert-saved",
      }),
    }));
    expect(state.mutation_plan.ci_full_replay.blockers).toEqual(expect.any(Array));
    expect(JSON.stringify(state)).not.toMatch(/local chrome|browser-mcp-live|\/port\/\d+|C:\\\\/i);
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

  it("surfaces Dojo skill-card state and routes the panel publish alias through license-first publishing", async () => {
    seedSaveWorkflow();
    const draft = buildBrowserWorkflowPanelState() as {
      dojo: {
        status: string;
        skillId: string;
        scenarioCount: number;
        skillCard: { practiced: string };
        license: { blockedActions: string[] };
      };
    };
    expect(draft.dojo).toEqual(expect.objectContaining({
      status: "draft",
      skillId: "dojo_save_settings",
      scenarioCount: 20,
      skillCard: expect.objectContaining({ practiced: "20 synthetic cases" }),
    }));
    expect(draft.dojo.license.blockedActions).toContain("run_workflow");

    bridge = startBrowserWorkflowBridge({ port: 0 });
    await bridge.ready;
    const publish = await fetch(`${baseUrl(bridge)}/browser-workflows/tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tool: "synthi_workflow_publish_tool",
        arguments: {
          workspace_id: "workspace-a",
          reason: "unit_test_publish",
          actor_id: "bridge-publisher",
          actor_type: "human",
          evidence_refs: ["evidence:bridge-publish"],
        },
      }),
    });

    expect(publish.status).toBe(200);
    const body = await publish.json() as {
      ok: boolean;
      requested_tool: string;
      tool: string;
      result: { skill: { skill_id: string }; private_tool: { tool_name?: string } };
      state: {
        dojo: {
          status: string;
          published: boolean;
          skillId: string;
          publishedToolName: string | null;
          skillPassport: { proof_required?: boolean };
        };
        history: Array<{ label: string; statusLabel: string }>;
        governanceService: {
          schema_version?: string;
          skill_registry?: Array<{ skill_id?: string }>;
        };
      };
    };
    expect(body.ok).toBe(true);
    expect(body.requested_tool).toBe("synthi_workflow_publish_tool");
    expect(body.tool).toBe("synthi_dojo_publish_skill");
    expect(body.result.skill.skill_id).toBe("dojo_save_settings");
    expect(body.result.private_tool.tool_name).toBe("synthi_app_save_settings");
    expect(body.result).toEqual(expect.objectContaining({
      publication: expect.objectContaining({
        reason: "unit_test_publish",
        evidence_refs: ["evidence:bridge-publish"],
        audit_event: expect.objectContaining({
          actor: { actor_id: "bridge-publisher", actor_type: "human" },
        }),
      }),
    }));
    expect(body.state.dojo).toEqual(expect.objectContaining({
      status: "licensed",
      published: true,
      skillId: "dojo_save_settings",
      publishedToolName: "synthi_app_save_settings",
    }));
    expect(body.state.history).toEqual([
      expect.objectContaining({
        label: "Dojo skill licensed",
        statusLabel: "Licensed",
      }),
    ]);
    expect(body.state.governanceService).toEqual(expect.objectContaining({
      schema_version: "synthi.dojo.governanceService.v1",
      skill_registry: expect.arrayContaining([expect.objectContaining({ skill_id: "dojo_save_settings" })]),
    }));

    const replay = vi.spyOn(browserPlaywrightAdapter, "replayActionEvent").mockResolvedValue({
      ok: true,
      action: "fill",
      tab_id: "tab-a",
      url: "https://app.example.test/settings",
    });
    const rawToolCall = await fetch(`${baseUrl(bridge)}/browser-workflows/tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tool: body.result.private_tool.tool_name,
        arguments: { run_mode: "prefixOnly", email: "agent@example.test" },
      }),
    });
    expect(rawToolCall.status).toBe(200);
    const rawToolBody = await rawToolCall.json() as {
      ok: boolean;
      result?: { error?: string; required_tool?: string; tool_name?: string };
    };
    expect(rawToolBody.ok).toBe(false);
    expect(rawToolBody.result).toEqual(expect.objectContaining({
      error: "dojo_proof_capsule_required",
      required_tool: "synthi_dojo_run_with_proof_capsule",
      tool_name: body.result.private_tool.tool_name,
    }));
    expect(replay).not.toHaveBeenCalled();
  });

  it("lets the workflow bridge fetch a published private tool manifest", async () => {
    seedSaveWorkflow();
    bridge = startBrowserWorkflowBridge({ port: 0 });
    await bridge.ready;
    const publishedEvents: string[] = [];
    const unsubscribe = privateWorkflowToolRegistry.onListChanged((event) => {
      publishedEvents.push(event.registration.tool_name);
    });

    let toolName: string | undefined;
    try {
      const publish = await fetch(`${baseUrl(bridge)}/browser-workflows/tool`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: "synthi_browser_publish_private_tool", arguments: {} }),
      });
      expect(publish.status).toBe(200);
      const publishBody = await publish.json() as {
        result?: { tool_name?: string };
      };
      toolName = publishBody.result?.tool_name;
      expect(toolName).toMatch(/^synthi_app_/);
      expect(publishedEvents).toContain(toolName);
    } finally {
      unsubscribe();
    }

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

    const replay = vi.spyOn(browserPlaywrightAdapter, "replayActionEvent").mockResolvedValue({
      ok: true,
      action: "fill",
      tab_id: "tab-a",
      url: "https://app.example.test/settings",
    });
    const call = await fetch(`${baseUrl(bridge)}/browser-workflows/tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tool: toolName,
        arguments: { run_mode: "prefixOnly", email: "agent@example.test" },
      }),
    });

    expect(call.status).toBe(200);
    const callBody = await call.json() as {
      ok: boolean;
      result?: { error?: string; required_tool?: string; tool_name?: string };
    };
    expect(callBody.ok).toBe(false);
    expect(callBody.result).toEqual(expect.objectContaining({
      error: "dojo_proof_capsule_required",
      required_tool: "synthi_dojo_run_with_proof_capsule",
      tool_name: toolName,
    }));
    expect(replay).not.toHaveBeenCalled();
  });

  it("updates panel proof state when a proof capsule is revoked through the bridge", async () => {
    seedSaveWorkflow();
    bridge = startBrowserWorkflowBridge({ port: 0 });
    await bridge.ready;

    const publish = await fetch(`${baseUrl(bridge)}/browser-workflows/tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tool: "synthi_workflow_publish_tool",
        arguments: {
          workspace_id: "workspace-a",
          reason: "unit_test_publish_for_revocation",
          actor_id: "bridge-publisher",
          actor_type: "human",
          evidence_refs: ["evidence:bridge-revocation-publish"],
        },
      }),
    });
    expect(publish.status).toBe(200);
    const publishBody = await publish.json() as { result: { skill: { skill_id: string } } };
    const skillId = publishBody.result.skill.skill_id;

    const issue = await fetch(`${baseUrl(bridge)}/browser-workflows/tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tool: "synthi_dojo_issue_proof_capsule",
        arguments: {
          skill_id: skillId,
          requested_action: "run_workflow",
          context_claims: { workspace_verified: true },
        },
      }),
    });
    expect(issue.status).toBe(200);
    const issueBody = await issue.json() as {
      result: { proof_capsule: { capsule_id: string } };
    };
    const capsuleId = issueBody.result.proof_capsule.capsule_id;
    expect(capsuleId).toMatch(/^capsule_/);

    const revoke = await fetch(`${baseUrl(bridge)}/browser-workflows/tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tool: "synthi_dojo_revoke_proof_capsule",
        arguments: {
          capsule_id: capsuleId,
          reason: "operator requested key rotation",
          actor_id: "proof-operator-a",
          actor_type: "human",
          now: "2026-06-11T00:01:30.000Z",
        },
      }),
    });
    expect(revoke.status).toBe(200);
    const revokeBody = await revoke.json() as {
      ok: boolean;
      result: {
        proof_record: {
          capsule_id: string;
          status: string;
          revoked_reason: string;
          revoked_by: { actor_id: string; actor_type: string };
        };
      };
      state: {
        dojo: {
          proof: {
            capsuleId: string;
            status: string;
            replayState: string;
            revocationReason: string;
            revokedBy: { actor_id: string; actor_type: string };
            errorCodes: string[];
          };
        };
        history: Array<{ label: string; statusLabel: string }>;
      };
    };

    expect(revokeBody.ok).toBe(true);
    expect(revokeBody.result.proof_record).toEqual(expect.objectContaining({
      capsule_id: capsuleId,
      status: "revoked",
      revoked_reason: "operator requested key rotation",
      revoked_by: { actor_id: "proof-operator-a", actor_type: "human" },
    }));
    expect(revokeBody.state.dojo.proof).toEqual(expect.objectContaining({
      capsuleId,
      status: "revoked",
      replayState: "revoked",
      revocationReason: "operator requested key rotation",
      revokedBy: { actor_id: "proof-operator-a", actor_type: "human" },
      errorCodes: ["proof_capsule_revoked"],
    }));
    expect(revokeBody.state.history[0]).toEqual(expect.objectContaining({
      label: "Proof capsule revoked",
      statusLabel: "Revoked",
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

  it("surfaces preview discovery config errors instead of assuming a local collab server", async () => {
    const envKeys = ["SYNTHI_COLLAB_SERVER_URL", "COLLAB_SERVER_URL", "NEXT_PUBLIC_COLLAB_SERVER_URL", "COLLAB_URL"];
    const previous = new Map(envKeys.map((key) => [key, process.env[key]]));
    for (const key of envKeys) delete process.env[key];
    bridge = startBrowserWorkflowBridge({ port: 0 });
    await bridge.ready;

    try {
      const res = await fetch(`${baseUrl(bridge)}/browser-workflows/tool`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tool: "synthi_browser_observe_preview",
          arguments: { workspace_url: "https://ide.example.test/workspace/workspace-a" },
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { ok: boolean; error: string; env?: string[]; requested_tool?: string; state?: unknown };
      expect(body).toEqual(expect.objectContaining({
        ok: false,
        error: "collab_server_url_required",
        requested_tool: "synthi_browser_observe_preview",
      }));
      expect(body.env).toContain("COLLAB_URL");
      expect(body.state).toBeTruthy();
    } finally {
      for (const [key, value] of previous.entries()) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
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

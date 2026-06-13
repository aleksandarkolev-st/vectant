import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserBroker } from "../../src/browser/broker.js";
import { buildDojoSkill, dojoSkillRegistry } from "../../src/browser/dojo.js";
import { InMemoryDojoSkillStore } from "../../src/browser/dojo_store.js";
import { browserPlaywrightAdapter } from "../../src/browser/playwright_adapter.js";
import { InMemoryPrivateWorkflowToolStore, privateWorkflowToolRegistry } from "../../src/browser/private_tool_registry.js";
import { sourceIdentityRegistry } from "../../src/browser/source_identity.js";
import { dispatchBrowserPrivateWorkflowToolAfterDojoProof, dispatchBrowserTool } from "../../src/tools/browser.js";

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...originalEnv };
  browserBroker.resetForTests();
  privateWorkflowToolRegistry.useStoreForTests(new InMemoryPrivateWorkflowToolStore());
  privateWorkflowToolRegistry.resetForTests();
  sourceIdentityRegistry.resetForTests();
  dojoSkillRegistry.useStoreForTests(new InMemoryDojoSkillStore());
  dojoSkillRegistry.resetForTests();
  vi.restoreAllMocks();
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("Dojo raw browser workflow replay gate", () => {
  it("blocks raw replay for Dojo-published workflows in production", async () => {
    process.env.SYNTHI_DOJO_PRODUCTION_ENFORCEMENT = "1";
    const workflowId = teachWorkflow();
    const skill = buildDojoSkill(browserBroker.compiledWorkflow().contract, {
      workspace_id: "workspace-a",
      published_tool_name: "synthi_app_open_details",
    });
    dojoSkillRegistry.publish(skill);
    const action = vi.spyOn(browserPlaywrightAdapter, "action").mockResolvedValue({
      ok: true,
      action: "click",
      tab_id: "app",
      url: "https://app.example.test/settings",
    });
    const lease = browserBroker.acquireLease("agent", 5000, "dojo-raw-workflow-gate");

    const response = await dispatchBrowserTool("synthi_browser_run_workflow", {
      lease_id: lease.lease_id,
      tab_id: "app",
      workflow_id: workflowId,
      mode: "sameSession",
    });

    expect(response?.isError).toBe(true);
    expect(response?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_proof_capsule_required",
      workflow_id: workflowId,
      required_tool: "synthi_dojo_run_with_proof_capsule",
      blocked_by: ["direct_entrypoint_for_published_skill", "dojo_proof_capsule_required"],
      dojo_execution_policy: expect.objectContaining({
        ok: false,
        enforcement_mode: "production",
        entrypoint: "browser_workflow",
        skill_id: skill.skill_id,
      }),
    }));
    expect(action).not.toHaveBeenCalled();
  });

  it("marks generated scripts for Dojo-published workflows as practice-only in production", async () => {
    process.env.SYNTHI_DOJO_PRODUCTION_ENFORCEMENT = "1";
    const workflowId = teachWorkflow();
    const skill = buildDojoSkill(browserBroker.compiledWorkflow().contract, {
      workspace_id: "workspace-a",
      published_tool_name: "synthi_app_open_details",
    });
    dojoSkillRegistry.publish(skill);

    const response = await dispatchBrowserTool("synthi_browser_generate_script", {
      workflow_id: workflowId,
    });

    expect(response?.isError).toBeUndefined();
    expect(response?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      workflow_id: workflowId,
      artifact_execution_policy: expect.objectContaining({
        status: "practice_only",
        enforcement_mode: "production",
        workflow_id: workflowId,
        skill_id: skill.skill_id,
        required_tool: "synthi_dojo_run_with_proof_capsule",
        execution_mode_env: "SYNTHI_DOJO_ARTIFACT_EXECUTION_MODE",
        allowed_execution_modes: ["practice", "test", "ci"],
        blocked_by: ["dojo_published_workflow_artifact_not_for_production"],
      }),
    }));
    const body = response?.structuredContent as { code: string; warnings: string[] };
    expect(body.warnings).toContain(
      "Dojo-published workflow artifacts are practice/test-only under production enforcement; use synthi_dojo_run_with_proof_capsule for production execution."
    );
    expect(body.code).toContain("SYNTHI_DOJO_ARTIFACT_EXECUTION_MODE");
    expect(body.code).toContain("test.skip(");
    expect(body.code).toContain("synthi_dojo_run_with_proof_capsule");
  });

  it("does not block unpublished raw workflow replay in production", async () => {
    process.env.SYNTHI_DOJO_PRODUCTION_ENFORCEMENT = "1";
    const workflowId = teachWorkflow();
    const action = vi.spyOn(browserPlaywrightAdapter, "action").mockResolvedValue({
      ok: true,
      action: "click",
      tab_id: "app",
      url: "https://app.example.test/settings",
    });
    const lease = browserBroker.acquireLease("agent", 5000, "dojo-raw-workflow-gate");

    const response = await dispatchBrowserTool("synthi_browser_run_workflow", {
      lease_id: lease.lease_id,
      tab_id: "app",
      workflow_id: workflowId,
      mode: "sameSession",
    });

    expect(response?.isError).toBeUndefined();
    expect(response?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      workflow_id: workflowId,
      replay: expect.objectContaining({ steps_run: 1 }),
    }));
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("allows only internal Dojo proof context to replay a published workflow", async () => {
    const workflowId = teachWorkflow();
    const privateTool = await dispatchBrowserTool("synthi_browser_publish_private_tool", {});
    expect(privateTool?.isError).toBeUndefined();
    const publishedPrivateTool = privateTool?.structuredContent as {
      tool_name: string;
      dojo_skill: { skill_id: string };
    };
    const toolName = publishedPrivateTool.tool_name;
    process.env.SYNTHI_DOJO_PRODUCTION_ENFORCEMENT = "1";
    browserBroker.setRuntimeAttachment({
      kind: "hosted",
      tenant_id: "tenant-a",
      workspace_id: "workspace-a",
      actor_id: "agent-a",
      runtime_id: "runtime-a",
      session_id: "session-a",
      workspace_url: "https://app.example.test/settings",
      adapter: "unit-hosted-runtime",
      expires_at: Date.now() + 60_000,
      origin_allowlist: ["https://app.example.test"],
      egress_policy: { local_network_allowed: false },
      redaction_policy: { screenshots: true },
    });
    const replay = vi.spyOn(browserPlaywrightAdapter, "replayActionEvent").mockResolvedValue({
      ok: true,
      action: "click",
      tab_id: "app",
      url: "https://app.example.test/settings",
    });

    const lease = browserBroker.acquireLease("agent", 5000, "dojo-raw-workflow-gate");
    const rawReplay = await dispatchBrowserTool("synthi_browser_run_workflow", {
      lease_id: lease.lease_id,
      tab_id: "app",
      workflow_id: workflowId,
      mode: "sameSession",
    });
    browserBroker.releaseLease(lease.lease_id, "dojo-raw-workflow-gate:done");

    expect(rawReplay?.isError).toBe(true);
    expect(rawReplay?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_proof_capsule_required",
      workflow_id: workflowId,
    }));
    expect(replay).not.toHaveBeenCalled();

    const mismatchedDojoReplay = await dispatchBrowserPrivateWorkflowToolAfterDojoProof(
      toolName,
      {
        tab_id: "app",
        run_mode: "sameSession",
        tenant_id: "tenant-a",
        workspace_id: "workspace-a",
        actor_id: "agent-a",
        actor_type: "agent",
        roles: ["agent"],
        request_id: "req-dojo-proof-replay-mismatch",
        correlation_id: "corr-dojo-proof-replay-mismatch",
      },
      {
        proof_capsule_id: "proof_123",
        skill_id: publishedPrivateTool.dojo_skill.skill_id,
        requested_action: "run_workflow",
        run_id: "dojo_run_123",
        tenant_id: "tenant-a",
        workspace_id: "workspace-a",
        runtime_session_id: "session-b",
        runtime_action_url: "https://app.example.test/settings",
      }
    );

    expect(mismatchedDojoReplay?.isError).toBe(true);
    expect(mismatchedDojoReplay?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_hosted_runtime_binding_failed",
      proof_not_consumed: true,
      blocked_by: ["runtime_session_attachment_mismatch"],
      browser_runtime_binding: expect.objectContaining({
        status: "blocked",
        expected_runtime_session_id: "session-b",
        attached_runtime_session_id: "session-a",
      }),
    }));
    expect(replay).not.toHaveBeenCalled();

    const dojoReplay = await dispatchBrowserPrivateWorkflowToolAfterDojoProof(
      toolName,
      {
        tab_id: "app",
        run_mode: "sameSession",
        tenant_id: "tenant-a",
        workspace_id: "workspace-a",
        actor_id: "agent-a",
        actor_type: "agent",
        roles: ["agent"],
        request_id: "req-dojo-proof-replay",
        correlation_id: "corr-dojo-proof-replay",
      },
      {
        proof_capsule_id: "proof_123",
        skill_id: publishedPrivateTool.dojo_skill.skill_id,
        requested_action: "run_workflow",
        run_id: "dojo_run_123",
        tenant_id: "tenant-a",
        workspace_id: "workspace-a",
        runtime_session_id: "session-a",
        runtime_action_url: "https://app.example.test/settings",
      }
    );

    expect(dojoReplay?.isError).toBeUndefined();
    expect(dojoReplay?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      workflow_id: workflowId,
      replay: expect.objectContaining({
        steps_run: 1,
        browser_runtime_binding: expect.objectContaining({
          status: "bound",
          expected_runtime_session_id: "session-a",
          attached_runtime_session_id: "session-a",
        }),
      }),
      private_tool: expect.objectContaining({
        tool_name: toolName,
        workflow_id: workflowId,
        run_mode: "sameSession",
      }),
    }));
    expect(replay).toHaveBeenCalledTimes(1);
  });
});

function teachWorkflow(): string {
  const url = "https://app.example.test/settings";
  browserBroker.requestConsent(url);
  browserBroker.registerTabs([{ tab_id: "app", url, active: true }]);
  browserBroker.selectTab("app");
  expect(browserBroker.startTeachMode("app").ok).toBe(true);
  registerSourceToken("details.open");
  expect(browserBroker.recordHumanAction({
    tab_id: "app",
    url,
    origin: "https://app.example.test",
    action: "click",
    element: { role: "button", name: "Open details", source_id: "details.open" },
    locator_candidates: [
      { kind: "role", locator: "page.getByRole(\"button\", { name: \"Open details\" })", confidence: 0.98, reason: "role" },
    ],
  }).ok).toBe(true);
  return browserBroker.compiledWorkflow().contract.workflowId;
}

function registerSourceToken(token: string): void {
  const filePath = `src/${token}.tsx`;
  sourceIdentityRegistry.register({
    workspaceId: "workspace-a",
    filePath,
    adapter: "unit-test",
    transformVersion: "unit_source_identity_v1",
    tokens: [{ token, file: filePath, tag: "button", line: 1, column: 1 }],
  });
}

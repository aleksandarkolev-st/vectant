import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserBroker } from "../../src/browser/broker.js";
import { buildDojoSkill, dojoSkillRegistry } from "../../src/browser/dojo.js";
import { InMemoryDojoSkillStore } from "../../src/browser/dojo_store.js";
import { browserPlaywrightAdapter } from "../../src/browser/playwright_adapter.js";
import type { BrowserTraceEvent } from "../../src/browser/types.js";
import { dispatchBrowserTool } from "../../src/tools/browser.js";

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...originalEnv };
  browserBroker.resetForTests();
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
});

function teachWorkflow(): string {
  const url = "https://app.example.test/settings";
  browserBroker.requestConsent(url);
  browserBroker.registerTabs([{ tab_id: "app", url, active: true }]);
  browserBroker.selectTab("app");
  expect(browserBroker.startTeachMode("app").ok).toBe(true);
  expect(browserBroker.recordHumanAction(event({
    event_id: "open",
    action: "click",
    detail: { element: { role: "button", name: "Open details", source_id: "details.open" } },
    locator_candidates: [
      { kind: "role", locator: "page.getByRole(\"button\", { name: \"Open details\" })", confidence: 0.98, reason: "role" },
    ],
  })).ok).toBe(true);
  return browserBroker.compiledWorkflow().contract.workflowId;
}

function event(overrides: Partial<BrowserTraceEvent>): BrowserTraceEvent {
  return {
    event_id: "evt",
    trace_id: "trace",
    trace_version: 1,
    event_seq: 1,
    ts: 1,
    tab_id: "app",
    origin: "https://app.example.test",
    url: "https://app.example.test/settings",
    kind: "human_action",
    ...overrides,
  };
}

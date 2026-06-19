import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserBroker } from "../../src/browser/broker.js";
import { buildDojoSkill, dojoSkillRegistry } from "../../src/browser/dojo.js";
import { InMemoryDojoSkillStore } from "../../src/browser/dojo_store.js";
import { generatePrivateWorkflowToolManifest } from "../../src/browser/private_tool_manifest.js";
import { InMemoryPrivateWorkflowToolStore, privateWorkflowToolRegistry } from "../../src/browser/private_tool_registry.js";
import { compileWorkflowContract } from "../../src/browser/workflow.js";
import type { BrowserTraceEvent } from "../../src/browser/types.js";
import { dispatchBrowserTool } from "../../src/tools/browser.js";

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...originalEnv };
  browserBroker.resetForTests();
  privateWorkflowToolRegistry.useStoreForTests(new InMemoryPrivateWorkflowToolStore());
  privateWorkflowToolRegistry.resetForTests();
  dojoSkillRegistry.useStoreForTests(new InMemoryDojoSkillStore());
  dojoSkillRegistry.resetForTests();
  vi.restoreAllMocks();
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("Dojo private tool entrypoint gate", () => {
  it("blocks a Dojo-published backing private tool direct call in production", async () => {
    process.env.SYNTHI_DOJO_PRODUCTION_ENFORCEMENT = "1";
    const contract = workflowContract();
    const manifest = generatePrivateWorkflowToolManifest(contract);
    const skill = buildDojoSkill(contract, {
      workspace_id: "workspace-a",
      published_tool_name: manifest.tool_name,
    });
    dojoSkillRegistry.publish(skill);
    expect(privateWorkflowToolRegistry.publish(manifest).ok).toBe(true);

    const response = await dispatchBrowserTool(manifest.tool_name, {});

    expect(response?.isError).toBe(true);
    expect(response?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_proof_capsule_required",
      tool_name: manifest.tool_name,
      workflow_id: manifest.workflow_id,
      required_tool: "synthi_dojo_run_with_proof_capsule",
      blocked_by: ["direct_entrypoint_for_published_skill", "dojo_proof_capsule_required"],
      dojo_execution_policy: expect.objectContaining({
        ok: false,
        enforcement_mode: "production",
        entrypoint: "private_tool",
        skill_id: skill.skill_id,
      }),
    }));
  });

  it("keeps Dojo-published backing private tools blocked in development compatibility mode", async () => {
    const contract = workflowContract();
    const manifest = generatePrivateWorkflowToolManifest(contract);
    const skill = buildDojoSkill(contract, {
      workspace_id: "workspace-a",
      published_tool_name: manifest.tool_name,
    });
    dojoSkillRegistry.publish(skill);
    expect(privateWorkflowToolRegistry.publish(manifest).ok).toBe(true);

    const response = await dispatchBrowserTool(manifest.tool_name, {});

    expect(response?.isError).toBe(true);
    expect(response?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_proof_capsule_required",
      dojo_execution_policy: expect.objectContaining({
        enforcement_mode: "development",
        ok: true,
      }),
    }));
  });

  it("does not apply the Dojo proof gate to private tools that are not Dojo-published", async () => {
    process.env.SYNTHI_DOJO_PRODUCTION_ENFORCEMENT = "1";
    const manifest = generatePrivateWorkflowToolManifest(workflowContract());
    expect(privateWorkflowToolRegistry.publish(manifest).ok).toBe(true);

    const response = await dispatchBrowserTool(manifest.tool_name, {});

    expect(response?.isError).toBe(true);
    expect(response?.structuredContent).toEqual(expect.not.objectContaining({
      error: "dojo_proof_capsule_required",
    }));
    expect(response?.structuredContent).toEqual(expect.objectContaining({
      tool_name: manifest.tool_name,
      workflow_id: manifest.workflow_id,
    }));
  });
});

function workflowContract() {
  return compileWorkflowContract([
    event({
      event_id: "open",
      action: "click",
      detail: { element: { role: "button", name: "Open details", source_id: "details.open" } },
      locator_candidates: [
        { kind: "role", locator: "page.getByRole(\"button\", { name: \"Open details\" })", confidence: 0.98, reason: "role" },
      ],
    }),
  ]).contract;
}

function event(overrides: Partial<BrowserTraceEvent>): BrowserTraceEvent {
  return {
    event_id: "evt",
    trace_id: "trace",
    trace_version: 1,
    event_seq: 1,
    ts: 1,
    tab_id: "tab",
    origin: "https://app.example.test",
    url: "https://app.example.test/settings",
    kind: "human_action",
    ...overrides,
  };
}

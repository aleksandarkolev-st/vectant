import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildDojoSkill } from "../../src/browser/dojo.js";
import { EncryptedFileDojoSkillStore, InMemoryDojoSkillStore } from "../../src/browser/dojo_store.js";
import { compileWorkflowContract } from "../../src/browser/workflow.js";
import { publishedToolNamesForSkill, publishedWorkflowBindingForSkill } from "../../src/dojo/store/published_workflow_index.js";
import type { BrowserTraceEvent } from "../../src/browser/types.js";

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("Dojo published workflow index", () => {
  it("creates stable workflow and backing tool bindings from a published skill", () => {
    const skill = skillWithTool("synthi_app_save_invoice");

    expect(publishedToolNamesForSkill(skill)).toEqual(["synthi_app_save_invoice"]);
    expect(publishedWorkflowBindingForSkill(skill)).toEqual({
      skill_id: skill.skill_id,
      workflow_id: skill.workflow_id,
      tool_names: ["synthi_app_save_invoice"],
    });
  });

  it("indexes workflow IDs and published tool names in memory", () => {
    const store = new InMemoryDojoSkillStore();
    const skill = skillWithTool("synthi_app_save_invoice");

    store.saveSkill(skill);

    expect(store.getSkillByWorkflowId(skill.workflow_id)).toEqual(expect.objectContaining({ skill_id: skill.skill_id }));
    expect(store.getSkillByPublishedToolName("synthi_app_save_invoice")).toEqual(expect.objectContaining({ skill_id: skill.skill_id }));
    expect(store.getPublishedWorkflowBindingByWorkflowId(skill.workflow_id)).toEqual(expect.objectContaining({
      skill_id: skill.skill_id,
      workflow_id: skill.workflow_id,
      tool_names: ["synthi_app_save_invoice"],
    }));
    expect(store.getPublishedWorkflowBindingByToolName("synthi_app_save_invoice")).toEqual(expect.objectContaining({
      skill_id: skill.skill_id,
      workflow_id: skill.workflow_id,
    }));
  });

  it("removes stale published tool indexes when a skill is republished with a new tool", () => {
    const store = new InMemoryDojoSkillStore();
    const first = skillWithTool("synthi_app_save_invoice");
    const second = { ...first, published_tool_name: "synthi_app_submit_invoice", published_tools: ["synthi_app_submit_invoice"] };

    store.saveSkill(first);
    store.saveSkill(second);

    expect(store.getSkillByPublishedToolName("synthi_app_save_invoice")).toBeNull();
    expect(store.getSkillByPublishedToolName("synthi_app_submit_invoice")).toEqual(expect.objectContaining({ skill_id: first.skill_id }));
  });

  it("persists published tool indexes in the encrypted file store", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "dojo-published-index-"));
    tempDirs.push(dir);
    const filePath = path.join(dir, "dojo-store.enc.json");
    const skill = skillWithTool("synthi_app_save_invoice");

    const store = new EncryptedFileDojoSkillStore({
      file_path: filePath,
      key: "unit-test-dojo-store-key",
      scope_id: "workspace-a",
    });
    store.saveSkill(skill);

    const reopened = new EncryptedFileDojoSkillStore({
      file_path: filePath,
      key: "unit-test-dojo-store-key",
      scope_id: "workspace-a",
    });

    expect(reopened.getPublishedWorkflowBindingByToolName("synthi_app_save_invoice")).toEqual(expect.objectContaining({
      skill_id: skill.skill_id,
      workflow_id: skill.workflow_id,
      tool_names: ["synthi_app_save_invoice"],
    }));
  });
});

function skillWithTool(toolName: string) {
  return buildDojoSkill(compileWorkflowContract([
    event({
      event_id: "save",
      action: "click",
      detail: { element: { role: "button", name: "Save invoice" } },
    }),
  ]).contract, {
    workspace_id: "workspace-a",
    now: "2026-06-11T00:00:00.000Z",
    published_tool_name: toolName,
  });
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

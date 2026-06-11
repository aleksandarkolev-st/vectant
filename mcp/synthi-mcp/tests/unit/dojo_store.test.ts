import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildDojoSkill, issueDojoProofCapsule } from "../../src/browser/dojo.js";
import { EncryptedFileDojoSkillStore } from "../../src/browser/dojo_store.js";
import { compileWorkflowContract } from "../../src/browser/workflow.js";
import type { BrowserTraceEvent } from "../../src/browser/types.js";

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("EncryptedFileDojoSkillStore", () => {
  it("persists skills and proof records encrypted by scope", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "dojo-store-"));
    tempDirs.push(dir);
    const filePath = path.join(dir, "dojo-store.enc.json");
    const store = new EncryptedFileDojoSkillStore({
      file_path: filePath,
      key: "unit-test-dojo-store-key",
      scope_id: "workspace-a",
    });
    const skill = buildDojoSkill(compileWorkflowContract([
      event({
        event_id: "save",
        action: "click",
        detail: { element: { role: "button", name: "Save draft" } },
      }),
    ]).contract, {
      workspace_id: "workspace-a",
      now: "2026-06-11T00:00:00.000Z",
    });
    const capsule = issueDojoProofCapsule(skill, "run_prefix_validation", {
      context_claims: { workspace_verified: true },
      now: "2026-06-11T00:00:00.000Z",
      expires_at: "2026-06-11T00:15:00.000Z",
    });

    store.saveSkill(skill);
    store.saveProofRecord({
      capsule_id: capsule.capsule_id,
      skill_id: capsule.skill_id,
      requested_action: capsule.requested_action,
      nonce: capsule.nonce,
      issued_at: capsule.issued_at,
      expires_at: capsule.expires_at,
      status: "issued",
    });

    const rawStore = readFileSync(filePath, "utf8");
    expect(rawStore).toContain("synthi_dojo_store_envelope_v1");
    expect(rawStore).not.toContain(skill.name);
    expect(rawStore).not.toContain(skill.skill_seed.inferred_intent);

    const reopened = new EncryptedFileDojoSkillStore({
      file_path: filePath,
      key: "unit-test-dojo-store-key",
      scope_id: "workspace-a",
    });
    expect(reopened.getSkill(skill.skill_id)).toEqual(expect.objectContaining({
      skill_id: skill.skill_id,
      workspace_id: "workspace-a",
    }));
    expect(reopened.getSkillByWorkflowId(skill.workflow_id)).toEqual(expect.objectContaining({
      skill_id: skill.skill_id,
    }));
    expect(reopened.listProofRecords()).toEqual([
      expect.objectContaining({ capsule_id: capsule.capsule_id, status: "issued" }),
    ]);

    const revoked = reopened.revokeProofCapsule(capsule.capsule_id, "unit_test_revoked", "2026-06-11T00:01:00.000Z");
    expect(revoked).toEqual(expect.objectContaining({
      capsule_id: capsule.capsule_id,
      status: "revoked",
      revoked_reason: "unit_test_revoked",
    }));

    const otherScope = new EncryptedFileDojoSkillStore({
      file_path: filePath,
      key: "unit-test-dojo-store-key",
      scope_id: "workspace-b",
    });
    expect(otherScope.listSkills()).toEqual([]);
    expect(otherScope.listProofRecords()).toEqual([]);
  });
});

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

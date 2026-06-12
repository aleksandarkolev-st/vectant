import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildDojoSkill, issueDojoProofCapsule } from "../../src/browser/dojo.js";
import { EncryptedFileDojoSkillStore, InMemoryDojoSkillStore } from "../../src/browser/dojo_store.js";
import { createDojoCaseLawFromFailure } from "../../src/dojo/case_law/registry.js";
import type {
  DojoApprovalStore,
  DojoCaseLawStore,
  DojoControlPlaneStore,
  DojoPermissionUpgradeRequestRecord,
  DojoProofCapsuleRecord,
  DojoProofStore,
  DojoSkillStore,
} from "../../src/dojo/store/interfaces.js";
import { compileWorkflowContract } from "../../src/browser/workflow.js";
import type { BrowserTraceEvent } from "../../src/browser/types.js";

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("Dojo store interface split", () => {
  it("keeps the in-memory store compatible with skill and proof contracts", () => {
    assertControlPlaneStore(new InMemoryDojoSkillStore());
  });

  it("keeps the encrypted file store compatible with skill and proof contracts", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "dojo-store-interfaces-"));
    tempDirs.push(dir);

    assertControlPlaneStore(new EncryptedFileDojoSkillStore({
      file_path: path.join(dir, "dojo-store.enc.json"),
      key: "unit-test-dojo-store-interface-key",
      scope_id: "workspace-a",
    }));
  });

  it("persists case-law records across encrypted file store reloads", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "dojo-store-case-law-"));
    tempDirs.push(dir);
    const filePath = path.join(dir, "dojo-store.enc.json");
    const key = "unit-test-dojo-case-law-store-key";
    const initial = new EncryptedFileDojoSkillStore({
      file_path: filePath,
      key,
      scope_id: "workspace-a",
    });
    const caseLaw = createDojoCaseLawFromFailure({
      source_skill_id: "skill-case-law",
      source_run_id: "run-case-law",
      scenario_id: "scenario-case-law",
      mutation_kind: "fake_success",
      finding: "Success UI appeared while persisted state did not change.",
      impact: "The agent could falsely report completion.",
      rule_created: "Require backend state assertion after success UI.",
      applies_to: ["submit_invoice"],
      binding_scope: { kind: "workspace", id: "workspace-a" },
      evidence_refs: ["evidence:fake-success-oracle"],
      now: "2026-06-11T00:04:00.000Z",
    });

    initial.saveCaseLawRecord(caseLaw);
    const reloaded = new EncryptedFileDojoSkillStore({
      file_path: filePath,
      key,
      scope_id: "workspace-a",
    });

    expect(reloaded.getCaseLawRecord(caseLaw.case_id)).toEqual(expect.objectContaining({
      case_id: caseLaw.case_id,
      status: "proposed",
      evidence_refs: ["evidence:fake-success-oracle"],
    }));
    expect(reloaded.listCaseLawRecords({ applies_to: "submit_invoice" })).toEqual([
      expect.objectContaining({ case_id: caseLaw.case_id }),
    ]);
  });
});

function assertControlPlaneStore(store: DojoControlPlaneStore): void {
  const skillStore: DojoSkillStore = store;
  const proofStore: DojoProofStore = store;
  const approvalStore: DojoApprovalStore = store;
  const caseLawStore: DojoCaseLawStore = store;
  const skill = buildDojoSkill(compileWorkflowContract([
    event({
      event_id: "open",
      action: "click",
      detail: { element: { role: "button", name: "Open details", source_id: "details.open" } },
      locator_candidates: [
        { kind: "role", locator: "page.getByRole(\"button\", { name: \"Open details\" })", confidence: 0.98, reason: "role" },
      ],
    }),
  ]).contract, {
    workspace_id: "workspace-a",
    now: "2026-06-11T00:00:00.000Z",
  });
  const capsule = issueDojoProofCapsule(skill, "run_workflow", {
    context_claims: { workspace_verified: true },
    now: "2026-06-11T00:00:00.000Z",
    expires_at: "2026-06-11T00:15:00.000Z",
  });
  const proofRecord: DojoProofCapsuleRecord = {
    capsule_id: capsule.capsule_id,
    skill_id: capsule.skill_id,
    requested_action: capsule.requested_action,
    nonce: capsule.nonce,
    issued_at: capsule.issued_at,
    expires_at: capsule.expires_at,
    status: "issued",
  };
  const upgradeRequest: DojoPermissionUpgradeRequestRecord = {
    schema_version: "synthi.dojo.permissionUpgradeRequest.v1",
    request_id: "upgrade-unit-test",
    skill_id: skill.skill_id,
    workflow_id: skill.workflow_id,
    workspace_id: skill.workspace_id,
    license_id: skill.permission_license.license_id,
    license_version: skill.permission_license.license_version,
    requested_action: "commit_mutation",
    current_entrustment_level: skill.entrustment_level,
    required_steps: ["rerun_checkride_for_requested_action"],
    status: "pending",
    evidence_refs: [`skill:${skill.skill_id}`],
    requested_at: "2026-06-11T00:01:00.000Z",
    requested_by: { actor_id: "unit-test", actor_type: "agent" },
    request_context: {
      request_id: "upgrade-unit-test",
      correlation_id: "upgrade-unit-test-correlation",
    },
  };
  const caseLaw = createDojoCaseLawFromFailure({
    source_skill_id: skill.skill_id,
    source_run_id: skill.checkride.checkride_id,
    scenario_id: "scenario-duplicate-client",
    mutation_kind: "duplicate_entity",
    finding: "Duplicate client display name can select the wrong account.",
    impact: "A mutation may be applied to the wrong account when labels collide.",
    rule_created: "Require stable client ID verification before account mutation.",
    applies_to: ["commit_mutation", "run_workflow"],
    binding_scope: { kind: "workspace", id: skill.workspace_id },
    evidence_refs: [`skill:${skill.skill_id}`, `checkride:${skill.checkride.checkride_id}`],
    now: "2026-06-11T00:02:00.000Z",
  });
  const approvedCaseLaw = {
    ...caseLaw,
    status: "approved" as const,
    reviewer: "case-law-reviewer",
    updated_at: "2026-06-11T00:03:00.000Z",
  };

  skillStore.saveSkill(skill);
  proofStore.saveProofRecord(proofRecord);
  approvalStore.savePermissionUpgradeRequest(upgradeRequest);
  caseLawStore.saveCaseLawRecord(caseLaw);
  caseLawStore.saveCaseLawRecord(approvedCaseLaw);

  expect(skillStore.getSkill(skill.skill_id)).toEqual(expect.objectContaining({ skill_id: skill.skill_id }));
  expect(skillStore.getSkillByWorkflowId(skill.workflow_id)).toEqual(expect.objectContaining({ skill_id: skill.skill_id }));
  expect(proofStore.getProofRecord(capsule.capsule_id)).toEqual(expect.objectContaining({ status: "issued" }));
  expect(proofStore.listProofRecords()).toHaveLength(1);
  expect(approvalStore.listPermissionUpgradeRequests({ skill_id: skill.skill_id })).toEqual([
    expect.objectContaining({
      request_id: "upgrade-unit-test",
      requested_action: "commit_mutation",
      status: "pending",
    }),
  ]);
  expect(approvalStore.listPermissionUpgradeRequests({ request_id: "upgrade-unit-test" })).toEqual([
    expect.objectContaining({
      skill_id: skill.skill_id,
      requested_action: "commit_mutation",
    }),
  ]);
  expect(approvalStore.listPermissionUpgradeRequests({ request_id: "missing-upgrade" })).toEqual([]);
  expect(approvalStore.listPermissionUpgradeRequests({ status: "approved" })).toEqual([]);
  expect(caseLawStore.getCaseLawRecord(caseLaw.case_id)).toEqual(expect.objectContaining({
    case_id: caseLaw.case_id,
    status: "approved",
    reviewer: "case-law-reviewer",
  }));
  expect(caseLawStore.listCaseLawRecords({ status: "approved" })).toEqual([
    expect.objectContaining({ case_id: caseLaw.case_id, status: "approved" }),
  ]);
  expect(caseLawStore.listCaseLawRecords({
    binding_scope: { kind: "workspace", id: skill.workspace_id },
    applies_to: "commit_mutation",
  })).toEqual([
    expect.objectContaining({ case_id: caseLaw.case_id }),
  ]);
  expect(caseLawStore.listCaseLawRecords({
    binding_scope: { kind: "workspace", id: "other-workspace" },
  })).toEqual([]);
  expect(store.clear).toEqual(expect.any(Function));
  expect(store.withTransaction).toBeUndefined();
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
    action: "click",
    target: "button",
    selectors: [],
    locator_candidates: [],
    confidence: 0.99,
    ...overrides,
  };
}

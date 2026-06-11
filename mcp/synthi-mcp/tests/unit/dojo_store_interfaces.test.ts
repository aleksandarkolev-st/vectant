import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildDojoSkill, issueDojoProofCapsule } from "../../src/browser/dojo.js";
import { EncryptedFileDojoSkillStore, InMemoryDojoSkillStore } from "../../src/browser/dojo_store.js";
import type {
  DojoControlPlaneStore,
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
});

function assertControlPlaneStore(store: DojoControlPlaneStore): void {
  const skillStore: DojoSkillStore = store;
  const proofStore: DojoProofStore = store;
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

  skillStore.saveSkill(skill);
  proofStore.saveProofRecord(proofRecord);

  expect(skillStore.getSkill(skill.skill_id)).toEqual(expect.objectContaining({ skill_id: skill.skill_id }));
  expect(skillStore.getSkillByWorkflowId(skill.workflow_id)).toEqual(expect.objectContaining({ skill_id: skill.skill_id }));
  expect(proofStore.getProofRecord(capsule.capsule_id)).toEqual(expect.objectContaining({ status: "issued" }));
  expect(proofStore.listProofRecords()).toHaveLength(1);
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

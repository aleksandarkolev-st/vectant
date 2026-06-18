import { describe, expect, it } from "vitest";
import { buildDojoSkill } from "../../src/browser/dojo.js";
import { InMemoryDojoSkillStore } from "../../src/browser/dojo_store.js";
import { compileWorkflowContract } from "../../src/browser/workflow.js";
import type { BrowserTraceEvent } from "../../src/browser/types.js";
import {
  createDojoProofCapsuleService,
  type DojoProofRecordStore,
} from "../../src/dojo/proof/capsule_service.js";
import type { DojoTenantContext } from "../../src/dojo/mcp/execution_policy_gate.js";
import { dojoEvidenceRecordForProof, verifiedProofEvidenceInput } from "./dojo_test_fixtures.js";

describe("Dojo proof capsule service", () => {
  it("issues verified capsules, validates without consuming on dry run, and consumes exactly once", async () => {
    const skill = skillFixture();
    const tenant = tenantFixture(skill.workspace_id);
    const store = new InMemoryDojoSkillStore();
    const service = createDojoProofCapsuleService({ proof_store: store });

    const issued = await service.issue({
      tenant,
      skill,
      requested_action: "run_workflow",
      context_claims: { workspace_verified: true },
      ...verifiedProofEvidenceInput(skill, { tenant_id: tenant.tenant_id }),
      now: "2026-06-11T00:00:00.000Z",
      expires_at: "2026-06-11T00:15:00.000Z",
    });

    expect(issued).toEqual(expect.objectContaining({
      ok: true,
      blocked_by: [],
      validation: expect.objectContaining({ ok: true, status: "allowed" }),
      proof_record: expect.objectContaining({
        tenant_id: tenant.tenant_id,
        workspace_id: tenant.workspace_id,
        status: "issued",
      }),
    }));
    expect(issued.proof_capsule?.evidence_record_ids).toHaveLength(1);
    expect(issued.evidence_claim_results.every((result) => result.ok)).toBe(true);

    const capsuleId = issued.proof_capsule!.capsule_id;
    const dryValidation = await service.validate({
      tenant,
      skill,
      proof_capsule: issued.proof_capsule!,
      requested_action: "run_workflow",
      dry_run: true,
      validation_options: { now: "2026-06-11T00:01:00.000Z" },
    });

    expect(dryValidation).toEqual(expect.objectContaining({
      ok: true,
      dry_run: true,
      validation: expect.objectContaining({ ok: true, status: "allowed" }),
    }));
    expect(store.getProofRecord(capsuleId)?.last_validated_at).toBeUndefined();

    const realValidation = await service.validate({
      tenant,
      skill,
      proof_capsule: issued.proof_capsule!,
      requested_action: "run_workflow",
      validation_options: { now: "2026-06-11T00:02:00.000Z" },
    });
    expect(realValidation.proof_record).toEqual(expect.objectContaining({
      capsule_id: capsuleId,
      last_validated_at: "2026-06-11T00:02:00.000Z",
    }));

    const firstConsume = await service.consume({
      tenant,
      capsule_id: capsuleId,
      run_id: "run-a",
      now: "2026-06-11T00:03:00.000Z",
    });
    expect(firstConsume).toEqual(expect.objectContaining({
      ok: true,
      status: "used",
      blocked_by: [],
    }));

    const replay = await service.consume({
      tenant,
      capsule_id: capsuleId,
      run_id: "run-b",
      now: "2026-06-11T00:04:00.000Z",
    });
    expect(replay).toEqual(expect.objectContaining({
      ok: false,
      status: "already_used",
      blocked_by: ["proof_capsule_replay_detected"],
    }));

    const replayValidation = await service.validate({
      tenant,
      skill,
      proof_capsule: issued.proof_capsule!,
      requested_action: "run_workflow",
      dry_run: true,
      validation_options: { now: "2026-06-11T00:05:00.000Z" },
    });
    expect(replayValidation).toEqual(expect.objectContaining({
      ok: false,
      blocked_by: ["proof_capsule_replay_detected"],
      validation: expect.objectContaining({
        error_codes: ["proof_capsule_replay_detected"],
      }),
    }));
  });

  it("returns a failed issue result and does not persist proof records when evidence is incomplete", async () => {
    const skill = skillFixture();
    const tenant = tenantFixture(skill.workspace_id);
    const store = new InMemoryDojoSkillStore();
    const service = createDojoProofCapsuleService({ proof_store: store });
    const firstClaim = skill.permission_license.proof_requirements.required_evidence_claims[0]!;

    const result = await service.issue({
      tenant,
      skill,
      requested_action: "run_workflow",
      context_claims: { workspace_verified: true },
      evidence_ledger_records: [
        dojoEvidenceRecordForProof(skill, {
          record_id: "evidence-incomplete",
          tenant_id: tenant.tenant_id,
          claim_ids: [firstClaim],
        }),
      ],
      require_verified_evidence: true,
      now: "2026-06-11T00:00:00.000Z",
      expires_at: "2026-06-11T00:15:00.000Z",
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      blocked_by: expect.arrayContaining([expect.stringMatching(/^evidence_claim_missing:/)]),
      validation: expect.objectContaining({
        ok: false,
        error_codes: ["proof_evidence_claim_unverified"],
      }),
    }));
    expect(result.proof_capsule).toBeUndefined();
    expect(result.evidence_claim_results.some((claim) => !claim.ok)).toBe(true);
    expect(store.listProofRecords()).toEqual([]);
  });

  it("fails closed before proof issue, validation, or consume when tenant context is incomplete", async () => {
    const skill = skillFixture();
    const tenant = invalidTenantFixture(skill.workspace_id);
    const service = createDojoProofCapsuleService({
      proof_store: throwingProofStore({ save: true, get: true, consume: true }),
    });

    const issue = await service.issue({
      tenant,
      skill,
      requested_action: "run_workflow",
      context_claims: { workspace_verified: true },
      ...verifiedProofEvidenceInput(skill, { tenant_id: "tenant-a" }),
      now: "2026-06-11T00:00:00.000Z",
      expires_at: "2026-06-11T00:15:00.000Z",
    });
    const validation = await service.validate({
      tenant,
      skill,
      proof_capsule: {
        capsule_id: "capsule-invalid-tenant",
        skill_id: skill.skill_id,
        issued_at: "2026-06-11T00:00:00.000Z",
        expires_at: "2026-06-11T00:15:00.000Z",
        requested_action: "run_workflow",
        nonce: "nonce-invalid-tenant",
        license_version: skill.permission_license.license_version,
        key_id: "dojo-local-dev",
        signature_algorithm: "hmac-sha256",
        signature: "invalid",
        context_claims: { workspace_verified: true },
        evidence_claims: [],
        evidence_record_ids: [],
      },
      requested_action: "run_workflow",
    });
    const consume = await service.consume({
      tenant,
      capsule_id: "capsule-invalid-tenant",
      run_id: "run-invalid-tenant",
      now: "2026-06-11T00:01:00.000Z",
    });

    expect(issue).toEqual(expect.objectContaining({
      ok: false,
      blocked_by: [
        "proof_tenant_required",
        "proof_organization_required",
        "proof_actor_required",
        "proof_actor_type_required",
        "proof_roles_invalid",
        "proof_request_required",
        "proof_correlation_required",
      ],
      validation: expect.objectContaining({
        error_codes: ["proof_tenant_context_invalid"],
      }),
      evidence_claim_results: [],
    }));
    expect(issue).not.toHaveProperty("proof_capsule");
    expect(issue).not.toHaveProperty("proof_record");
    expect(validation).toEqual(expect.objectContaining({
      ok: false,
      proof_record: null,
      blocked_by: issue.blocked_by,
      validation: expect.objectContaining({
        error_codes: ["proof_tenant_context_invalid"],
      }),
    }));
    expect(consume).toEqual({
      ok: false,
      record: null,
      status: "missing",
      blocked_by: issue.blocked_by,
    });
  });

  it("fails closed when a persisted proof record is not scoped to the validation tenant", async () => {
    const skill = skillFixture();
    const tenant = tenantFixture(skill.workspace_id);
    const store = new InMemoryDojoSkillStore();
    const service = createDojoProofCapsuleService({ proof_store: store });

    const issued = await service.issue({
      tenant,
      skill,
      requested_action: "run_workflow",
      context_claims: { workspace_verified: true },
      ...verifiedProofEvidenceInput(skill, { tenant_id: tenant.tenant_id }),
      now: "2026-06-11T00:00:00.000Z",
      expires_at: "2026-06-11T00:15:00.000Z",
    });
    expect(issued.ok).toBe(true);
    const proofRecord = store.getProofRecord(issued.proof_capsule!.capsule_id);
    expect(proofRecord).toBeTruthy();
    store.saveProofRecord({
      ...proofRecord!,
      tenant_id: "tenant-b",
      workspace_id: "workspace-b",
    });

    const validation = await service.validate({
      tenant,
      skill,
      proof_capsule: issued.proof_capsule!,
      requested_action: "run_workflow",
      dry_run: true,
      validation_options: { now: "2026-06-11T00:01:00.000Z" },
    });

    expect(validation).toEqual(expect.objectContaining({
      ok: false,
      blocked_by: expect.arrayContaining([
        "proof_record_tenant_mismatch",
        "proof_record_workspace_mismatch",
      ]),
      validation: expect.objectContaining({
        error_codes: ["proof_capsule_registry_mismatch"],
      }),
    }));
  });

  it("fails closed when a persisted proof record is missing tenant scope", async () => {
    const skill = skillFixture();
    const tenant = tenantFixture(skill.workspace_id);
    const store = new InMemoryDojoSkillStore();
    const service = createDojoProofCapsuleService({ proof_store: store });

    const issued = await service.issue({
      tenant,
      skill,
      requested_action: "run_workflow",
      context_claims: { workspace_verified: true },
      ...verifiedProofEvidenceInput(skill, { tenant_id: tenant.tenant_id }),
      now: "2026-06-11T00:00:00.000Z",
      expires_at: "2026-06-11T00:15:00.000Z",
    });
    expect(issued.ok).toBe(true);
    const proofRecord = store.getProofRecord(issued.proof_capsule!.capsule_id);
    expect(proofRecord).toBeTruthy();
    const { tenant_id, workspace_id, ...unscopedProofRecord } = proofRecord!;
    expect(tenant_id).toBe(tenant.tenant_id);
    expect(workspace_id).toBe(tenant.workspace_id);
    store.saveProofRecord(unscopedProofRecord);

    const validation = await service.validate({
      tenant,
      skill,
      proof_capsule: issued.proof_capsule!,
      requested_action: "run_workflow",
      dry_run: true,
      validation_options: { now: "2026-06-11T00:01:00.000Z" },
    });
    const consume = await service.consume({
      tenant,
      capsule_id: issued.proof_capsule!.capsule_id,
      run_id: "run-unscoped",
      now: "2026-06-11T00:02:00.000Z",
    });

    expect(validation).toEqual(expect.objectContaining({
      ok: false,
      blocked_by: expect.arrayContaining([
        "proof_record_tenant_missing",
        "proof_record_workspace_missing",
      ]),
      validation: expect.objectContaining({
        error_codes: ["proof_capsule_registry_mismatch"],
      }),
    }));
    expect(consume).toEqual(expect.objectContaining({
      ok: false,
      status: "missing",
      blocked_by: [
        "proof_record_tenant_missing",
        "proof_record_workspace_missing",
      ],
      record: expect.objectContaining({
        capsule_id: issued.proof_capsule!.capsule_id,
        status: "issued",
      }),
    }));
    expect(store.getProofRecord(issued.proof_capsule!.capsule_id)).toEqual(expect.objectContaining({
      status: "issued",
    }));
  });

  it("fails closed when consumption is requested without a proof store", async () => {
    const service = createDojoProofCapsuleService();

    await expect(service.consume({
      tenant: tenantFixture("workspace-a"),
      capsule_id: "capsule-a",
      run_id: "run-a",
      now: "2026-06-11T00:00:00.000Z",
    })).resolves.toEqual({
      ok: false,
      record: null,
      status: "missing",
      blocked_by: ["proof_capsule_store_missing"],
    });
  });

  it("fails closed when the proof store cannot persist issued capsules", async () => {
    const skill = skillFixture();
    const tenant = tenantFixture(skill.workspace_id);
    const service = createDojoProofCapsuleService({
      proof_store: throwingProofStore({ save: true }),
    });

    const result = await service.issue({
      tenant,
      skill,
      requested_action: "run_workflow",
      context_claims: { workspace_verified: true },
      ...verifiedProofEvidenceInput(skill, { tenant_id: tenant.tenant_id }),
      now: "2026-06-11T00:00:00.000Z",
      expires_at: "2026-06-11T00:15:00.000Z",
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      proof_record: null,
      blocked_by: ["proof_record_persist_failed"],
      validation: expect.objectContaining({
        ok: false,
        error_codes: ["proof_capsule_registry_mismatch"],
      }),
    }));
    expect(result.proof_capsule).toBeUndefined();
  });

  it("fails closed when the proof store cannot be read during validation", async () => {
    const skill = skillFixture();
    const tenant = tenantFixture(skill.workspace_id);
    const backing = new InMemoryDojoSkillStore();
    const issued = await createDojoProofCapsuleService({ proof_store: backing }).issue({
      tenant,
      skill,
      requested_action: "run_workflow",
      context_claims: { workspace_verified: true },
      ...verifiedProofEvidenceInput(skill, { tenant_id: tenant.tenant_id }),
      now: "2026-06-11T00:00:00.000Z",
      expires_at: "2026-06-11T00:15:00.000Z",
    });
    expect(issued.ok).toBe(true);

    const service = createDojoProofCapsuleService({
      proof_store: throwingProofStore({ get: true }),
    });
    const validation = await service.validate({
      tenant,
      skill,
      proof_capsule: issued.proof_capsule!,
      requested_action: "run_workflow",
      validation_options: { now: "2026-06-11T00:01:00.000Z" },
    });

    expect(validation).toEqual(expect.objectContaining({
      ok: false,
      proof_record: null,
      blocked_by: ["proof_record_lookup_failed"],
      validation: expect.objectContaining({
        error_codes: ["proof_capsule_registry_mismatch"],
      }),
    }));
  });

  it("fails closed when the proof store cannot mark validation", async () => {
    const skill = skillFixture();
    const tenant = tenantFixture(skill.workspace_id);
    const backing = new InMemoryDojoSkillStore();
    const service = createDojoProofCapsuleService({
      proof_store: {
        saveProofRecord(record) {
          return backing.saveProofRecord(record);
        },
        getProofRecord(capsuleId) {
          return backing.getProofRecord(capsuleId);
        },
        markProofCapsuleValidated() {
          throw new Error("store_unavailable");
        },
        markProofCapsuleUsed(capsuleId, runId, now) {
          return backing.markProofCapsuleUsed(capsuleId, runId, now);
        },
      },
    });

    const issued = await service.issue({
      tenant,
      skill,
      requested_action: "run_workflow",
      context_claims: { workspace_verified: true },
      ...verifiedProofEvidenceInput(skill, { tenant_id: tenant.tenant_id }),
      now: "2026-06-11T00:00:00.000Z",
      expires_at: "2026-06-11T00:15:00.000Z",
    });
    expect(issued.ok).toBe(true);

    const validation = await service.validate({
      tenant,
      skill,
      proof_capsule: issued.proof_capsule!,
      requested_action: "run_workflow",
      validation_options: { now: "2026-06-11T00:01:00.000Z" },
    });

    expect(validation).toEqual(expect.objectContaining({
      ok: false,
      proof_record: expect.objectContaining({ capsule_id: issued.proof_capsule!.capsule_id }),
      blocked_by: ["proof_record_validate_failed"],
      validation: expect.objectContaining({
        error_codes: ["proof_capsule_registry_mismatch"],
      }),
    }));
  });

  it("fails closed when the proof store cannot atomically consume a capsule", async () => {
    const skill = skillFixture();
    const tenant = tenantFixture(skill.workspace_id);
    const backing = new InMemoryDojoSkillStore();
    const service = createDojoProofCapsuleService({
      proof_store: {
        saveProofRecord(record) {
          return backing.saveProofRecord(record);
        },
        getProofRecord(capsuleId) {
          return backing.getProofRecord(capsuleId);
        },
        markProofCapsuleValidated(capsuleId, now) {
          return backing.markProofCapsuleValidated(capsuleId, now);
        },
        markProofCapsuleUsed() {
          throw new Error("store_unavailable");
        },
      },
    });
    const issued = await service.issue({
      tenant,
      skill,
      requested_action: "run_workflow",
      context_claims: { workspace_verified: true },
      ...verifiedProofEvidenceInput(skill, { tenant_id: tenant.tenant_id }),
      now: "2026-06-11T00:00:00.000Z",
      expires_at: "2026-06-11T00:15:00.000Z",
    });
    expect(issued.ok).toBe(true);

    const result = await service.consume({
      tenant,
      capsule_id: issued.proof_capsule!.capsule_id,
      run_id: "run-a",
      now: "2026-06-11T00:01:00.000Z",
    });

    expect(result).toEqual({
      ok: false,
      record: null,
      status: "missing",
      blocked_by: ["proof_record_consume_failed"],
    });
  });

  it("supports maybe-promise proof stores for durable Postgres-compatible implementations", async () => {
    const skill = skillFixture();
    const tenant = tenantFixture(skill.workspace_id);
    const backing = new InMemoryDojoSkillStore();
    const asyncStore: DojoProofRecordStore = {
      async saveProofRecord(record) {
        backing.saveProofRecord(record);
        return backing.getProofRecord(record.capsule_id);
      },
      async getProofRecord(capsuleId) {
        return backing.getProofRecord(capsuleId);
      },
      async markProofCapsuleValidated(capsuleId, now) {
        return backing.markProofCapsuleValidated(capsuleId, now);
      },
      async markProofCapsuleUsed(capsuleId, runId, now) {
        return backing.markProofCapsuleUsed(capsuleId, runId, now);
      },
    };
    const service = createDojoProofCapsuleService({ proof_store: asyncStore });

    const issued = await service.issue({
      tenant,
      skill,
      requested_action: "run_workflow",
      context_claims: { workspace_verified: true },
      ...verifiedProofEvidenceInput(skill, { tenant_id: tenant.tenant_id }),
      now: "2026-06-11T00:00:00.000Z",
      expires_at: "2026-06-11T00:15:00.000Z",
    });

    expect(issued.ok).toBe(true);
    expect(issued.proof_record).toEqual(expect.objectContaining({
      capsule_id: issued.proof_capsule?.capsule_id,
      status: "issued",
    }));
  });
});

function skillFixture() {
  return buildDojoSkill(compileWorkflowContract([
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
}

function tenantFixture(workspaceId: string): DojoTenantContext {
  return {
    tenant_id: "tenant-a",
    organization_id: "org-a",
    workspace_id: workspaceId,
    actor_id: "agent-a",
    actor_type: "agent",
    roles: ["dojo.operator"],
    request_id: "request-a",
    correlation_id: "correlation-a",
  };
}

function invalidTenantFixture(workspaceId: string): DojoTenantContext {
  return {
    ...tenantFixture(workspaceId),
    tenant_id: "",
    organization_id: "",
    actor_id: "",
    actor_type: "robot" as never,
    roles: ["dojo:proof", ""],
    request_id: "",
    correlation_id: "",
  };
}

function throwingProofStore(failures: {
  save?: boolean;
  get?: boolean;
  validate?: boolean;
  consume?: boolean;
}): DojoProofRecordStore {
  const backing = new InMemoryDojoSkillStore();
  return {
    saveProofRecord(record) {
      if (failures.save) throw new Error("store_unavailable");
      return backing.saveProofRecord(record);
    },
    getProofRecord(capsuleId) {
      if (failures.get) throw new Error("store_unavailable");
      return backing.getProofRecord(capsuleId);
    },
    markProofCapsuleValidated(capsuleId, now) {
      if (failures.validate) throw new Error("store_unavailable");
      return backing.markProofCapsuleValidated(capsuleId, now);
    },
    markProofCapsuleUsed(capsuleId, runId, now) {
      if (failures.consume) throw new Error("store_unavailable");
      return backing.markProofCapsuleUsed(capsuleId, runId, now);
    },
  };
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

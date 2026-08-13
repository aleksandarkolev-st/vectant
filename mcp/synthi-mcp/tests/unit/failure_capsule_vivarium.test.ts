import { describe, expect, it } from "vitest";
import { adaptFailureCapsuleToVivarium } from "../../src/dojo/vivarium/failure_capsule.js";

function manifest() {
  return {
    schema_version: "synthi.dojo.failureCapsuleScenario.v1",
    scenario_id: "distiller_capsule_123",
    capsule: { capsule_id: "capsule_123", source_revision: "abc", world_hash: "world", run_command: ["python", "runner.py"] },
    synthetic_fixture_requirements: [{ fixture_id: "fixture", kind: "fake_database_state", synthetic_data_only: true, required: true }],
    boundary_mocks: [],
    reset_profile: { reset_profile_id: "reset_capsule_123", strategy: "deterministic_seed", seed: "seed" },
    oracle: { predicate: { type: "exit_nonzero" }, failure_signature: { required: ["signature"] }, baseline: { matches: 3 } },
    evidence: { capsule_id: "capsule_123", scenario_id: "distiller_capsule_123", source_revision: "abc", fixture_manifest_sha256: "fixturehash", redaction: "policy" },
    limits: ["original-world validation remains required for every candidate patch"],
  };
}

describe("Failure Distiller Vivarium adapter", () => {
  it("maps a sanitized capsule handoff to a deterministic Vivarium scenario", () => {
    const result = adaptFailureCapsuleToVivarium(manifest());
    expect(result).toEqual(expect.objectContaining({ ok: true, status: "ready_for_materialization", blocked_by: [] }));
    expect(result.scenario?.reset_profile.seed).toBe("seed");
    expect(result.scenario?.fixture_requirements[0]?.synthetic_data_only).toBe(true);
    expect(result.oracle_contract?.contract_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("refuses unvalidated boundary mocks and retains only metadata evidence", () => {
    const unsafe = manifest();
    unsafe.boundary_mocks = [{ kind: "live_provider", validated: false }];
    const result = adaptFailureCapsuleToVivarium(unsafe);
    expect(result).toEqual(expect.objectContaining({ ok: false, status: "boundary_not_isolatable" }));
    expect(result.blocked_by).toContain("failure_capsule_unvalidated_boundary_mock");
    expect(result.evidence).toEqual(expect.objectContaining({ capsule_id: "capsule_123", world_hash: "world" }));
  });
});

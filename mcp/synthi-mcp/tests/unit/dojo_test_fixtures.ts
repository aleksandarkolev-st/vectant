import { createHash } from "node:crypto";
import type { DojoSkill } from "../../src/browser/dojo.js";
import { buildDojoEvidenceLedgerRecord } from "../../src/dojo/evidence/ledger_record.js";
import type { DojoEvidenceLedgerRecord } from "../../src/dojo/evidence/types.js";

export function dojoEvidenceRecordForProof(
  skill: DojoSkill,
  options: {
    record_id?: string;
    run_id?: string;
    created_at?: string;
    artifact_sha256?: string;
    claim_ids?: string[];
    tenant_id?: string;
    workspace_id?: string;
  } = {}
): DojoEvidenceLedgerRecord {
  const createdAt = options.created_at ?? "2026-06-11T00:00:00.000Z";
  const recordId = options.record_id ?? `evidence-${skill.skill_id}`;
  const claimIds = options.claim_ids ?? skill.permission_license.proof_requirements.required_evidence_claims;
  const artifactUri = `memory://dojo/tests/${skill.skill_id}/checkride`;
  const artifactPayload = JSON.stringify({
    claim_ids: claimIds,
    created_at: createdAt,
    record_id: recordId,
    skill_id: skill.skill_id,
  });
  return buildDojoEvidenceLedgerRecord({
    record_id: recordId,
    tenant_id: options.tenant_id ?? "legacy-local-tenant",
    workspace_id: options.workspace_id ?? skill.workspace_id,
    skill_id: skill.skill_id,
    run_id: options.run_id ?? `checkride-${skill.skill_id}`,
    kind: "checkride",
    artifact_uri: artifactUri,
    artifact_sha256: options.artifact_sha256 ?? sha256Hex(artifactPayload),
    claim_ids: claimIds,
    created_at: createdAt,
    created_by: "dojo-test-fixture",
    retention_class: "ephemeral",
  });
}

export function verifiedProofEvidenceInput(
  skill: DojoSkill,
  options: Parameters<typeof dojoEvidenceRecordForProof>[1] = {}
): {
  evidence_ledger_records: DojoEvidenceLedgerRecord[];
  require_verified_evidence: true;
} {
  return {
    evidence_ledger_records: [dojoEvidenceRecordForProof(skill, options)],
    require_verified_evidence: true,
  };
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

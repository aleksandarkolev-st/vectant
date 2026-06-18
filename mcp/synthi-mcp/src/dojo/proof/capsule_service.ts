import type {
  DojoEvidenceClaim,
  DojoExecutionSubstrate,
  DojoProofCarryingSkillCapsule,
  DojoProofValidation,
  DojoSkill,
} from "../../browser/dojo.js";
import {
  DojoProofEvidenceClaimError,
  issueDojoProofCapsule,
  validateDojoProofCapsule,
} from "../../browser/dojo.js";
import type { DojoEvidenceClaimResult } from "../evidence/claims.js";
import type { DojoEvidenceLedgerRecord } from "../evidence/types.js";
import type { DojoTenantContext } from "../mcp/execution_policy_gate.js";
import {
  normalizeDojoProofErrorCodes,
  type DojoProofErrorCode,
} from "./errors.js";
import type { DojoProofVerifier } from "./signing.js";
import type {
  DojoAuditActor,
  DojoProofCapsuleRecord,
  DojoProofConsumeResult,
  MaybePromise,
} from "../store/interfaces.js";

export interface DojoProofRecordStore {
  saveProofRecord(record: DojoProofCapsuleRecord): MaybePromise<DojoProofCapsuleRecord | void>;
  getProofRecord(capsuleId: string): MaybePromise<DojoProofCapsuleRecord | null>;
  markProofCapsuleValidated(capsuleId: string, now?: string): MaybePromise<DojoProofCapsuleRecord | null>;
  markProofCapsuleUsed(capsuleId: string, runId: string, now?: string): MaybePromise<DojoProofConsumeResult>;
}

export interface DojoProofValidationOptions {
  now?: string;
  issuer?: string;
  expected_key_id?: string;
  verifier?: DojoProofVerifier | null;
}

export interface DojoProofCapsuleServiceIssueInput {
  tenant: DojoTenantContext;
  skill: DojoSkill;
  requested_action: string;
  context_claims?: Record<string, unknown>;
  evidence_claims?: DojoEvidenceClaim[];
  evidence_ledger_records?: DojoEvidenceLedgerRecord[];
  evidence_max_age_ms?: number;
  ledger_checkpoint_hash?: string;
  require_verified_evidence?: boolean;
  substrate_claim?: DojoExecutionSubstrate;
  expires_at?: string;
  now?: string;
  issued_by?: DojoAuditActor;
  validation_options?: Omit<DojoProofValidationOptions, "now">;
}

export interface DojoProofCapsuleServiceValidateInput {
  tenant: DojoTenantContext;
  skill: DojoSkill;
  proof_capsule: DojoProofCarryingSkillCapsule;
  requested_action: string;
  dry_run?: boolean;
  validation_options?: DojoProofValidationOptions;
}

export interface DojoProofCapsuleServiceConsumeInput {
  tenant: DojoTenantContext;
  capsule_id: string;
  run_id: string;
  now?: string;
}

export interface DojoProofIssueResult {
  ok: boolean;
  proof_capsule?: DojoProofCarryingSkillCapsule;
  proof_record?: DojoProofCapsuleRecord | null;
  validation: DojoProofValidation;
  evidence_claim_results: DojoEvidenceClaimResult[];
  blocked_by: string[];
}

export interface DojoProofValidateResult {
  ok: boolean;
  validation: DojoProofValidation;
  proof_record: DojoProofCapsuleRecord | null;
  dry_run: boolean;
  blocked_by: string[];
}

export interface DojoProofCapsuleService {
  issue(input: DojoProofCapsuleServiceIssueInput): Promise<DojoProofIssueResult>;
  validate(input: DojoProofCapsuleServiceValidateInput): Promise<DojoProofValidateResult>;
  consume(input: DojoProofCapsuleServiceConsumeInput): Promise<DojoProofConsumeResult>;
}

export interface DojoProofCapsuleServiceOptions {
  proof_store?: DojoProofRecordStore;
}

export function createDojoProofCapsuleService(
  options: DojoProofCapsuleServiceOptions = {}
): DojoProofCapsuleService {
  return new DefaultDojoProofCapsuleService(options);
}

export function buildDojoProofRecordFromCapsule(input: {
  tenant: DojoTenantContext;
  skill: DojoSkill;
  capsule: DojoProofCarryingSkillCapsule;
  issued_by?: DojoAuditActor;
}): DojoProofCapsuleRecord {
  return {
    tenant_id: input.tenant.tenant_id,
    workspace_id: input.tenant.workspace_id,
    capsule_id: input.capsule.capsule_id,
    skill_id: input.capsule.skill_id,
    license_id: input.skill.permission_license.license_id,
    license_version: input.capsule.license_version,
    requested_action: input.capsule.requested_action,
    nonce: input.capsule.nonce,
    key_id: input.capsule.key_id,
    signature_algorithm: input.capsule.signature_algorithm,
    substrate_claim: input.capsule.substrate_claim,
    evidence_record_ids: [...input.capsule.evidence_record_ids],
    ...(input.capsule.ledger_checkpoint_hash ? { ledger_checkpoint_hash: input.capsule.ledger_checkpoint_hash } : {}),
    issued_at: input.capsule.issued_at,
    expires_at: input.capsule.expires_at,
    status: "issued",
    issued_by: input.issued_by ?? {
      actor_id: input.tenant.actor_id,
      actor_type: input.tenant.actor_type,
    },
  };
}

class DefaultDojoProofCapsuleService implements DojoProofCapsuleService {
  private readonly proofStore?: DojoProofRecordStore;

  constructor(options: DojoProofCapsuleServiceOptions) {
    this.proofStore = options.proof_store;
  }

  async issue(input: DojoProofCapsuleServiceIssueInput): Promise<DojoProofIssueResult> {
    const now = input.now ?? new Date().toISOString();
    const tenantBlockedBy = proofTenantContextBlockedBy(input.tenant);
    if (tenantBlockedBy.length > 0) {
      return {
        ok: false,
        validation: blockedProofValidation(input.skill, tenantBlockedBy),
        evidence_claim_results: [],
        blocked_by: tenantBlockedBy,
      };
    }

    let capsule: DojoProofCarryingSkillCapsule;
    try {
      capsule = issueDojoProofCapsule(input.skill, input.requested_action, {
        context_claims: input.context_claims,
        evidence_claims: input.evidence_claims,
        evidence_ledger_records: input.evidence_ledger_records,
        evidence_max_age_ms: input.evidence_max_age_ms,
        ledger_checkpoint_hash: input.ledger_checkpoint_hash,
        require_verified_evidence: input.require_verified_evidence,
        tenant_id: input.tenant.tenant_id,
        substrate_claim: input.substrate_claim,
        expires_at: input.expires_at,
        now,
      });
    } catch (error) {
      const failedResults = proofEvidenceFailureResults(error);
      const blockedBy = failedResults.length > 0
        ? uniqueStrings(failedResults.flatMap((result) => result.blocked_by))
        : [error instanceof Error ? error.message : "dojo_proof_capsule_issue_failed"];
      return {
        ok: false,
        validation: blockedProofValidation(input.skill, blockedBy),
        evidence_claim_results: failedResults,
        blocked_by: blockedBy,
      };
    }

    const validation = validateDojoProofCapsule(input.skill, capsule, input.requested_action, {
      now,
      ...input.validation_options,
    });
    if (!validation.ok) {
      return {
        ok: false,
        proof_capsule: capsule,
        proof_record: null,
        validation,
        evidence_claim_results: evidenceResultsFromCapsule(capsule, now),
        blocked_by: validation.blocked_by,
      };
    }

    const record = buildDojoProofRecordFromCapsule({
      tenant: input.tenant,
      skill: input.skill,
      capsule,
      issued_by: input.issued_by,
    });
    let savedRecord: DojoProofCapsuleRecord | void;
    try {
      savedRecord = this.proofStore
        ? await this.proofStore.saveProofRecord(record)
        : record;
    } catch {
      const blockedBy = ["proof_record_persist_failed"];
      return {
        ok: false,
        proof_record: null,
        validation: mergeProofValidationBlocks(validation, blockedBy),
        evidence_claim_results: evidenceResultsFromCapsule(capsule, now),
        blocked_by: blockedBy,
      };
    }
    return {
      ok: true,
      proof_capsule: capsule,
      proof_record: savedRecord ?? record,
      validation,
      evidence_claim_results: evidenceResultsFromCapsule(capsule, now),
      blocked_by: [],
    };
  }

  async validate(input: DojoProofCapsuleServiceValidateInput): Promise<DojoProofValidateResult> {
    const now = input.validation_options?.now ?? new Date().toISOString();
    const tenantBlockedBy = proofTenantContextBlockedBy(input.tenant);
    if (tenantBlockedBy.length > 0) {
      const validation = blockedProofValidation(input.skill, tenantBlockedBy);
      return {
        ok: false,
        validation,
        proof_record: null,
        dry_run: input.dry_run === true,
        blocked_by: validation.blocked_by,
      };
    }

    const structuralValidation = validateDojoProofCapsule(
      input.skill,
      input.proof_capsule,
      input.requested_action,
      {
        ...input.validation_options,
        now,
      }
    );
    let record: DojoProofCapsuleRecord | null = null;
    if (this.proofStore) {
      try {
        record = await this.proofStore.getProofRecord(input.proof_capsule.capsule_id);
      } catch {
        const validation = mergeProofValidationBlocks(structuralValidation, ["proof_record_lookup_failed"]);
        return {
          ok: false,
          validation,
          proof_record: null,
          dry_run: input.dry_run === true,
          blocked_by: validation.blocked_by,
        };
      }
    }
    const registryBlockedBy = this.proofStore
      ? proofRegistryBlockedBy(input.proof_capsule, record, {
        tenant: input.tenant,
        skill: input.skill,
      })
      : [];
    const validation = registryBlockedBy.length > 0
      ? mergeProofValidationBlocks(structuralValidation, registryBlockedBy)
      : structuralValidation;
    let markedRecord = record;
    if (validation.ok && !input.dry_run && this.proofStore) {
      try {
        markedRecord = await this.proofStore.markProofCapsuleValidated(input.proof_capsule.capsule_id, now);
      } catch {
        const failedValidation = mergeProofValidationBlocks(validation, ["proof_record_validate_failed"]);
        return {
          ok: false,
          validation: failedValidation,
          proof_record: record,
          dry_run: false,
          blocked_by: failedValidation.blocked_by,
        };
      }
      if (!markedRecord) {
        const failedValidation = mergeProofValidationBlocks(validation, ["proof_capsule_not_issued"]);
        return {
          ok: false,
          validation: failedValidation,
          proof_record: null,
          dry_run: false,
          blocked_by: failedValidation.blocked_by,
        };
      }
    }
    return {
      ok: validation.ok,
      validation,
      proof_record: markedRecord,
      dry_run: input.dry_run === true,
      blocked_by: validation.blocked_by,
    };
  }

  async consume(input: DojoProofCapsuleServiceConsumeInput): Promise<DojoProofConsumeResult> {
    const tenantBlockedBy = proofTenantContextBlockedBy(input.tenant);
    if (tenantBlockedBy.length > 0) {
      return {
        ok: false,
        record: null,
        status: "missing",
        blocked_by: tenantBlockedBy,
      };
    }

    if (!this.proofStore) {
      return {
        ok: false,
        record: null,
        status: "missing",
        blocked_by: ["proof_capsule_store_missing"],
      };
    }
    try {
      return await this.proofStore.markProofCapsuleUsed(input.capsule_id, input.run_id, input.now);
    } catch {
      return {
        ok: false,
        record: null,
        status: "missing",
        blocked_by: ["proof_record_consume_failed"],
      };
    }
  }
}

function proofTenantContextBlockedBy(tenant: DojoTenantContext): string[] {
  const blockedBy: string[] = [];
  if (!tenant?.tenant_id?.trim()) blockedBy.push("proof_tenant_required");
  if (!tenant?.organization_id?.trim()) blockedBy.push("proof_organization_required");
  if (!tenant?.workspace_id?.trim()) blockedBy.push("proof_workspace_required");
  if (!tenant?.actor_id?.trim()) blockedBy.push("proof_actor_required");
  if (!["human", "agent", "service"].includes(tenant?.actor_type)) blockedBy.push("proof_actor_type_required");
  if (!Array.isArray(tenant?.roles) || tenant.roles.some((role) => typeof role !== "string" || !role.trim())) {
    blockedBy.push("proof_roles_invalid");
  }
  if (!tenant?.request_id?.trim()) blockedBy.push("proof_request_required");
  if (!tenant?.correlation_id?.trim()) blockedBy.push("proof_correlation_required");
  return blockedBy;
}

function proofRegistryBlockedBy(
  capsule: DojoProofCarryingSkillCapsule,
  record: DojoProofCapsuleRecord | null,
  expected: {
    tenant: DojoTenantContext;
    skill: DojoSkill;
  }
): string[] {
  if (!record) return ["proof_capsule_not_issued"];
  const blockedBy: string[] = [];
  if (record.status === "revoked") blockedBy.push("proof_capsule_revoked");
  if (record.status === "used") blockedBy.push("proof_capsule_replay_detected");
  if (record.tenant_id && record.tenant_id !== expected.tenant.tenant_id) blockedBy.push("proof_record_tenant_mismatch");
  if (record.workspace_id && record.workspace_id !== expected.tenant.workspace_id) blockedBy.push("proof_record_workspace_mismatch");
  if (record.skill_id !== capsule.skill_id) blockedBy.push("proof_record_skill_mismatch");
  if (record.license_id && record.license_id !== expected.skill.permission_license.license_id) {
    blockedBy.push("proof_record_license_mismatch");
  }
  if (record.requested_action !== capsule.requested_action) blockedBy.push("proof_record_action_mismatch");
  if (record.license_version && record.license_version !== capsule.license_version) {
    blockedBy.push("proof_record_license_version_mismatch");
  }
  if (record.nonce && record.nonce !== capsule.nonce) blockedBy.push("proof_record_nonce_mismatch");
  if (record.key_id && record.key_id !== capsule.key_id) blockedBy.push("proof_record_key_mismatch");
  if (record.signature_algorithm && record.signature_algorithm !== capsule.signature_algorithm) {
    blockedBy.push("proof_record_signature_algorithm_mismatch");
  }
  if (record.substrate_claim && record.substrate_claim !== capsule.substrate_claim) {
    blockedBy.push("proof_record_substrate_mismatch");
  }
  if (record.ledger_checkpoint_hash && record.ledger_checkpoint_hash !== capsule.ledger_checkpoint_hash) {
    blockedBy.push("proof_record_ledger_checkpoint_mismatch");
  }
  if (record.evidence_record_ids && !sameStringSet(record.evidence_record_ids, capsule.evidence_record_ids)) {
    blockedBy.push("proof_record_evidence_mismatch");
  }
  return blockedBy;
}

function mergeProofValidationBlocks(
  validation: DojoProofValidation,
  blockedBy: string[]
): DojoProofValidation {
  const mergedBlockedBy = uniqueStrings([...validation.blocked_by, ...blockedBy]);
  return {
    ...validation,
    ok: false,
    status: "blocked",
    error: validation.error ?? "dojo_proof_capsule_invalid",
    blocked_by: mergedBlockedBy,
    error_codes: normalizeDojoProofErrorCodes(mergedBlockedBy),
  };
}

function blockedProofValidation(skill: DojoSkill, blockedBy: string[]): DojoProofValidation {
  return {
    ok: false,
    status: "blocked",
    error: "dojo_proof_capsule_invalid",
    blocked_by: blockedBy,
    error_codes: normalizeDojoProofErrorCodes(blockedBy) as DojoProofErrorCode[],
    license: {
      skill_id: skill.skill_id,
      license_version: skill.permission_license.license_version,
      entrustment_level: skill.permission_license.entrustment_level,
    },
  };
}

function proofEvidenceFailureResults(error: unknown): DojoEvidenceClaimResult[] {
  if (error instanceof DojoProofEvidenceClaimError) return error.failed_results;
  return [];
}

function evidenceResultsFromCapsule(
  capsule: DojoProofCarryingSkillCapsule,
  checkedAt: string
): DojoEvidenceClaimResult[] {
  return capsule.evidence_claims.map((claim) => ({
    claim_id: claim.claim,
    ok: claim.satisfied,
    status: claim.satisfied ? "verified" : "failed",
    evidence_record_ids: evidenceRecordIdsFromRefs(claim.evidence_refs),
    checked_at: checkedAt,
    blocked_by: claim.satisfied ? [] : [`evidence_claim_not_satisfied:${claim.claim}`],
  }));
}

function evidenceRecordIdsFromRefs(refs: string[] | undefined): string[] {
  return uniqueStrings((refs ?? [])
    .filter((ref) => ref.startsWith("evidence:"))
    .map((ref) => ref.slice("evidence:".length).trim())
    .filter(Boolean));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function sameStringSet(left: string[], right: string[]): boolean {
  const normalizedLeft = uniqueStrings(left).sort();
  const normalizedRight = uniqueStrings(right).sort();
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

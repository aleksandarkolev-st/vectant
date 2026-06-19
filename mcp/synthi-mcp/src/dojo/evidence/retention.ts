import type { DojoEvidenceLedgerRecord, DojoEvidenceRetentionClass } from "./types.js";

export type DojoEvidenceRetentionDisposition =
  | "retain"
  | "redact_artifact"
  | "purge_artifact"
  | "blocked_legal_hold";

export interface DojoEvidenceRetentionPolicy {
  class_ttl_ms?: Partial<Record<DojoEvidenceRetentionClass, number | null>>;
  redaction_grace_ms?: number;
  purge_grace_ms?: number;
}

export interface DojoEvidenceNormalizedRetentionPolicy {
  class_ttl_ms: Record<DojoEvidenceRetentionClass, number | null>;
  redaction_grace_ms: number;
  purge_grace_ms: number;
}

export interface DojoEvidenceRetentionDecision {
  record_id: string;
  tenant_id: string;
  workspace_id: string;
  retention_class: DojoEvidenceRetentionClass;
  legal_hold: boolean;
  created_at: string;
  evaluated_at: string;
  age_ms: number | null;
  expires_at: string | null;
  redaction_eligible_at: string | null;
  purge_eligible_at: string | null;
  disposition: DojoEvidenceRetentionDisposition;
  ledger_record_action: "preserve_append_only_record";
  artifact_action: "retain" | "redact" | "purge";
  blocked_by: string[];
}

export interface DojoEvidenceRetentionPlan {
  schema_version: "synthi.dojo.evidenceRetentionPlan.v1";
  generated_at: string;
  tenant_id: string;
  workspace_id: string;
  record_count: number;
  disposition_counts: Record<DojoEvidenceRetentionDisposition, number>;
  decisions: DojoEvidenceRetentionDecision[];
  blocked_by: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_DOJO_EVIDENCE_RETENTION_POLICY: DojoEvidenceNormalizedRetentionPolicy = Object.freeze({
  class_ttl_ms: Object.freeze({
    ephemeral: 7 * DAY_MS,
    standard: 90 * DAY_MS,
    regulated: 7 * 365 * DAY_MS,
    legal_hold: null,
  }),
  redaction_grace_ms: 0,
  purge_grace_ms: 30 * DAY_MS,
});

export function evaluateDojoEvidenceRetention(
  record: DojoEvidenceLedgerRecord,
  input: {
    policy?: DojoEvidenceRetentionPolicy;
    now?: string;
  } = {}
): DojoEvidenceRetentionDecision {
  const evaluatedAt = input.now ?? new Date().toISOString();
  const evaluatedMs = Date.parse(evaluatedAt);
  const createdMs = Date.parse(record.created_at);
  const policy = normalizeRetentionPolicy(input.policy);
  const ttlMs = policy.class_ttl_ms[record.retention_class];
  const legalHold = record.legal_hold === true || record.retention_class === "legal_hold";

  if (!Number.isFinite(evaluatedMs)) {
    return decisionFor(record, {
      evaluated_at: evaluatedAt,
      age_ms: null,
      expires_at: null,
      redaction_eligible_at: null,
      purge_eligible_at: null,
      disposition: "retain",
      artifact_action: "retain",
      blocked_by: ["evidence_retention_evaluated_at_invalid"],
    });
  }
  if (!Number.isFinite(createdMs)) {
    return decisionFor(record, {
      evaluated_at: evaluatedAt,
      age_ms: null,
      expires_at: null,
      redaction_eligible_at: null,
      purge_eligible_at: null,
      disposition: "retain",
      artifact_action: "retain",
      blocked_by: ["evidence_retention_created_at_invalid"],
    });
  }

  const ageMs = evaluatedMs - createdMs;
  if (ageMs < 0) {
    return decisionFor(record, {
      evaluated_at: evaluatedAt,
      age_ms: ageMs,
      expires_at: ttlMs === null ? null : iso(createdMs + ttlMs),
      redaction_eligible_at: ttlMs === null ? null : iso(createdMs + ttlMs + policy.redaction_grace_ms),
      purge_eligible_at: ttlMs === null ? null : iso(createdMs + ttlMs + policy.purge_grace_ms),
      disposition: "retain",
      artifact_action: "retain",
      blocked_by: ["evidence_retention_record_created_in_future"],
    });
  }

  if (legalHold || ttlMs === null) {
    return decisionFor(record, {
      evaluated_at: evaluatedAt,
      age_ms: ageMs,
      expires_at: null,
      redaction_eligible_at: null,
      purge_eligible_at: null,
      disposition: legalHold ? "blocked_legal_hold" : "retain",
      artifact_action: "retain",
      blocked_by: legalHold ? ["evidence_legal_hold_active"] : [],
    });
  }

  const redactionEligibleMs = createdMs + ttlMs + policy.redaction_grace_ms;
  const purgeEligibleMs = createdMs + ttlMs + policy.purge_grace_ms;
  const disposition: DojoEvidenceRetentionDisposition = evaluatedMs >= purgeEligibleMs
    ? "purge_artifact"
    : evaluatedMs >= redactionEligibleMs
    ? "redact_artifact"
    : "retain";
  return decisionFor(record, {
    evaluated_at: evaluatedAt,
    age_ms: ageMs,
    expires_at: iso(createdMs + ttlMs),
    redaction_eligible_at: iso(redactionEligibleMs),
    purge_eligible_at: iso(purgeEligibleMs),
    disposition,
    artifact_action: disposition === "purge_artifact" ? "purge" : disposition === "redact_artifact" ? "redact" : "retain",
    blocked_by: [],
  });
}

export function buildDojoEvidenceRetentionPlan(input: {
  tenant_id: string;
  workspace_id: string;
  records: DojoEvidenceLedgerRecord[];
  policy?: DojoEvidenceRetentionPolicy;
  now?: string;
}): DojoEvidenceRetentionPlan {
  const tenantId = requiredId(input.tenant_id, "tenant_id");
  const workspaceId = requiredId(input.workspace_id, "workspace_id");
  const generatedAt = input.now ?? new Date().toISOString();
  const scopedRecords = input.records.filter((record) => record.tenant_id === tenantId && record.workspace_id === workspaceId);
  const outOfScopeCount = input.records.length - scopedRecords.length;
  const decisions = scopedRecords.map((record) => evaluateDojoEvidenceRetention(record, {
    policy: input.policy,
    now: generatedAt,
  }));
  return {
    schema_version: "synthi.dojo.evidenceRetentionPlan.v1",
    generated_at: generatedAt,
    tenant_id: tenantId,
    workspace_id: workspaceId,
    record_count: decisions.length,
    disposition_counts: dispositionCounts(decisions),
    decisions,
    blocked_by: outOfScopeCount > 0 ? [`evidence_retention_scope_excluded:${outOfScopeCount}`] : [],
  };
}

function normalizeRetentionPolicy(policy: DojoEvidenceRetentionPolicy = {}): DojoEvidenceNormalizedRetentionPolicy {
  return {
    class_ttl_ms: {
      ...DEFAULT_DOJO_EVIDENCE_RETENTION_POLICY.class_ttl_ms,
      ...(policy.class_ttl_ms ?? {}),
    },
    redaction_grace_ms: nonNegative(policy.redaction_grace_ms, DEFAULT_DOJO_EVIDENCE_RETENTION_POLICY.redaction_grace_ms),
    purge_grace_ms: nonNegative(policy.purge_grace_ms, DEFAULT_DOJO_EVIDENCE_RETENTION_POLICY.purge_grace_ms),
  };
}

function decisionFor(
  record: DojoEvidenceLedgerRecord,
  decision: Omit<DojoEvidenceRetentionDecision, "record_id" | "tenant_id" | "workspace_id" | "retention_class" | "legal_hold" | "created_at" | "ledger_record_action">
): DojoEvidenceRetentionDecision {
  return {
    record_id: record.record_id,
    tenant_id: record.tenant_id,
    workspace_id: record.workspace_id,
    retention_class: record.retention_class,
    legal_hold: record.legal_hold,
    created_at: record.created_at,
    ledger_record_action: "preserve_append_only_record",
    ...decision,
  };
}

function dispositionCounts(decisions: DojoEvidenceRetentionDecision[]): Record<DojoEvidenceRetentionDisposition, number> {
  return {
    retain: decisions.filter((decision) => decision.disposition === "retain").length,
    redact_artifact: decisions.filter((decision) => decision.disposition === "redact_artifact").length,
    purge_artifact: decisions.filter((decision) => decision.disposition === "purge_artifact").length,
    blocked_legal_hold: decisions.filter((decision) => decision.disposition === "blocked_legal_hold").length,
  };
}

function nonNegative(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) throw new Error("dojo_evidence_retention_policy_duration_invalid");
  return value;
}

function requiredId(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`dojo_evidence_retention_${field}_required`);
  return trimmed;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

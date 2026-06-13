import { createHash } from "node:crypto";

export type DojoCaseLawStatus = "proposed" | "approved" | "deprecated";
export type DojoCaseLawAppealStatus = "none" | "requested" | "upheld" | "overturned";
export type DojoCaseLawBindingScopeKind = "tenant" | "organization" | "workspace" | "skill";

export interface DojoCaseLawBindingScope {
  kind: DojoCaseLawBindingScopeKind;
  id: string;
}

export interface DojoCaseLawRecord {
  schema_version: "synthi.dojo.caseLaw.v1";
  case_id: string;
  title: string;
  finding: string;
  impact: string;
  rule_created: string;
  applies_to: string[];
  binding_scope: DojoCaseLawBindingScope;
  status: DojoCaseLawStatus;
  reviewer?: string;
  evidence_refs: string[];
  superseded_by?: string;
  appeal_status: DojoCaseLawAppealStatus;
  created_at: string;
  updated_at: string;
}

export interface DojoCaseLawRegistry {
  propose(record: DojoCaseLawRecord): DojoCaseLawRecord;
  approve(case_id: string, input: { reviewer: string; now: string }): DojoCaseLawRecord;
  deprecate(case_id: string, input: { superseded_by?: string; reviewer: string; now: string }): DojoCaseLawRecord;
  get(case_id: string): DojoCaseLawRecord | null;
  listBindingCases(scope: DojoCaseLawBindingScope): DojoCaseLawRecord[];
}

export function createDojoCaseLawFromFailure(input: {
  source_skill_id: string;
  source_run_id: string;
  scenario_id: string;
  mutation_kind: string;
  finding: string;
  impact: string;
  rule_created: string;
  applies_to: string[];
  binding_scope: DojoCaseLawBindingScope;
  evidence_refs: string[];
  now: string;
}): DojoCaseLawRecord {
  const evidenceRefs = uniqueStrings(input.evidence_refs);
  if (evidenceRefs.length === 0) throw new Error("dojo_case_law_evidence_required");
  const caseId = `case_${shortHash(`${input.source_skill_id}:${input.source_run_id}:${input.scenario_id}:${input.finding}`)}`;
  const record: DojoCaseLawRecord = {
    schema_version: "synthi.dojo.caseLaw.v1",
    case_id: caseId,
    title: titleFor(input.mutation_kind),
    finding: input.finding,
    impact: input.impact,
    rule_created: input.rule_created,
    applies_to: uniqueStrings(input.applies_to),
    binding_scope: {
      kind: input.binding_scope.kind,
      id: input.binding_scope.id,
    },
    status: "proposed",
    evidence_refs: evidenceRefs,
    appeal_status: "none",
    created_at: input.now,
    updated_at: input.now,
  };
  validateCaseLawRecord(record);
  return record;
}

export class InMemoryDojoCaseLawRegistry implements DojoCaseLawRegistry {
  private readonly cases = new Map<string, DojoCaseLawRecord>();

  propose(record: DojoCaseLawRecord): DojoCaseLawRecord {
    validateCaseLawRecord(record);
    if (record.status !== "proposed") throw new Error("dojo_case_law_proposal_status_invalid");
    const clone = cloneCase(record);
    this.cases.set(clone.case_id, clone);
    return cloneCase(clone);
  }

  approve(caseId: string, input: { reviewer: string; now: string }): DojoCaseLawRecord {
    const record = this.requiredCase(caseId);
    validateReviewerAndTimestamp(input);
    if (record.status !== "proposed") throw new Error("dojo_case_law_approval_not_pending");
    if (record.appeal_status === "overturned") throw new Error("dojo_case_law_appeal_overturned");
    const approved = {
      ...record,
      status: "approved" as const,
      reviewer: input.reviewer.trim(),
      updated_at: input.now,
    };
    validateCaseLawRecord(approved);
    this.cases.set(caseId, approved);
    return cloneCase(approved);
  }

  deprecate(caseId: string, input: { superseded_by?: string; reviewer: string; now: string }): DojoCaseLawRecord {
    const record = this.requiredCase(caseId);
    validateReviewerAndTimestamp(input);
    if (record.status === "deprecated") throw new Error("dojo_case_law_already_deprecated");
    const supersededBy = input.superseded_by?.trim();
    const deprecated = {
      ...record,
      status: "deprecated" as const,
      reviewer: input.reviewer.trim(),
      ...(supersededBy ? { superseded_by: supersededBy } : {}),
      updated_at: input.now,
    };
    validateCaseLawRecord(deprecated);
    this.cases.set(caseId, deprecated);
    return cloneCase(deprecated);
  }

  get(caseId: string): DojoCaseLawRecord | null {
    const record = this.cases.get(caseId);
    return record ? cloneCase(record) : null;
  }

  listBindingCases(scope: DojoCaseLawBindingScope): DojoCaseLawRecord[] {
    return [...this.cases.values()]
      .filter(isDojoCaseLawBindingActive)
      .filter((record) => record.binding_scope.kind === scope.kind && record.binding_scope.id === scope.id)
      .map(cloneCase)
      .sort((left, right) => left.case_id.localeCompare(right.case_id));
  }

  private requiredCase(caseId: string): DojoCaseLawRecord {
    const record = this.cases.get(caseId);
    if (!record) throw new Error("dojo_case_law_not_found");
    return record;
  }
}

export function validateCaseLawRecord(record: DojoCaseLawRecord): void {
  if (record.schema_version !== "synthi.dojo.caseLaw.v1") throw new Error("dojo_case_law_schema_version_invalid");
  if (!record.case_id.trim()) throw new Error("dojo_case_law_case_id_required");
  if (!record.title.trim()) throw new Error("dojo_case_law_title_required");
  if (!record.finding.trim()) throw new Error("dojo_case_law_finding_required");
  if (!record.impact.trim()) throw new Error("dojo_case_law_impact_required");
  if (!record.rule_created.trim()) throw new Error("dojo_case_law_rule_required");
  if (!CASE_LAW_STATUSES.has(record.status)) throw new Error("dojo_case_law_status_invalid");
  if (!CASE_LAW_APPEAL_STATUSES.has(record.appeal_status)) throw new Error("dojo_case_law_appeal_status_invalid");
  if (!CASE_LAW_BINDING_SCOPE_KINDS.has(record.binding_scope.kind)) throw new Error("dojo_case_law_binding_scope_kind_invalid");
  if (!record.binding_scope.id.trim()) throw new Error("dojo_case_law_binding_scope_required");
  if (uniqueStrings(record.evidence_refs).length === 0) throw new Error("dojo_case_law_evidence_required");
  if (record.applies_to.some((action) => !action.trim())) throw new Error("dojo_case_law_applies_to_invalid");
  if (!isValidTimestamp(record.created_at) || !isValidTimestamp(record.updated_at)) {
    throw new Error("dojo_case_law_timestamp_invalid");
  }
  if ((record.status === "approved" || record.status === "deprecated") && !record.reviewer?.trim()) {
    throw new Error("dojo_case_law_reviewer_required");
  }
  if (record.superseded_by !== undefined && !record.superseded_by.trim()) {
    throw new Error("dojo_case_law_superseded_by_invalid");
  }
}

export function isDojoCaseLawBindingActive(record: DojoCaseLawRecord): boolean {
  return record.status === "approved"
    && ACTIVE_APPEAL_STATUSES.has(record.appeal_status)
    && !record.superseded_by?.trim();
}

function titleFor(mutationKind: string): string {
  return mutationKind
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function validateReviewerAndTimestamp(input: { reviewer: string; now: string }): void {
  if (!input.reviewer.trim()) throw new Error("dojo_case_law_reviewer_required");
  if (!isValidTimestamp(input.now)) throw new Error("dojo_case_law_timestamp_invalid");
}

function isValidTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))].sort();
}

function cloneCase(record: DojoCaseLawRecord): DojoCaseLawRecord {
  return JSON.parse(JSON.stringify(record)) as DojoCaseLawRecord;
}

const CASE_LAW_STATUSES = new Set<DojoCaseLawStatus>(["proposed", "approved", "deprecated"]);
const CASE_LAW_APPEAL_STATUSES = new Set<DojoCaseLawAppealStatus>(["none", "requested", "upheld", "overturned"]);
const ACTIVE_APPEAL_STATUSES = new Set<DojoCaseLawAppealStatus>(["none", "requested", "upheld"]);
const CASE_LAW_BINDING_SCOPE_KINDS = new Set<DojoCaseLawBindingScopeKind>([
  "tenant",
  "organization",
  "workspace",
  "skill",
]);

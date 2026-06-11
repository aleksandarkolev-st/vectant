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
  if (input.evidence_refs.length === 0) throw new Error("dojo_case_law_evidence_required");
  const caseId = `case_${shortHash(`${input.source_skill_id}:${input.source_run_id}:${input.scenario_id}:${input.finding}`)}`;
  return {
    schema_version: "synthi.dojo.caseLaw.v1",
    case_id: caseId,
    title: titleFor(input.mutation_kind),
    finding: input.finding,
    impact: input.impact,
    rule_created: input.rule_created,
    applies_to: [...new Set(input.applies_to)].sort(),
    binding_scope: input.binding_scope,
    status: "proposed",
    evidence_refs: [...new Set(input.evidence_refs)].sort(),
    appeal_status: "none",
    created_at: input.now,
    updated_at: input.now,
  };
}

export class InMemoryDojoCaseLawRegistry implements DojoCaseLawRegistry {
  private readonly cases = new Map<string, DojoCaseLawRecord>();

  propose(record: DojoCaseLawRecord): DojoCaseLawRecord {
    validateCaseLawRecord(record);
    const clone = cloneCase(record);
    this.cases.set(clone.case_id, clone);
    return cloneCase(clone);
  }

  approve(caseId: string, input: { reviewer: string; now: string }): DojoCaseLawRecord {
    const record = this.requiredCase(caseId);
    if (!input.reviewer.trim()) throw new Error("dojo_case_law_reviewer_required");
    const approved = {
      ...record,
      status: "approved" as const,
      reviewer: input.reviewer,
      updated_at: input.now,
    };
    this.cases.set(caseId, approved);
    return cloneCase(approved);
  }

  deprecate(caseId: string, input: { superseded_by?: string; reviewer: string; now: string }): DojoCaseLawRecord {
    const record = this.requiredCase(caseId);
    if (!input.reviewer.trim()) throw new Error("dojo_case_law_reviewer_required");
    const deprecated = {
      ...record,
      status: "deprecated" as const,
      reviewer: input.reviewer,
      ...(input.superseded_by ? { superseded_by: input.superseded_by } : {}),
      updated_at: input.now,
    };
    this.cases.set(caseId, deprecated);
    return cloneCase(deprecated);
  }

  get(caseId: string): DojoCaseLawRecord | null {
    const record = this.cases.get(caseId);
    return record ? cloneCase(record) : null;
  }

  listBindingCases(scope: DojoCaseLawBindingScope): DojoCaseLawRecord[] {
    return [...this.cases.values()]
      .filter((record) => record.status === "approved")
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
  if (!record.finding.trim()) throw new Error("dojo_case_law_finding_required");
  if (!record.rule_created.trim()) throw new Error("dojo_case_law_rule_required");
  if (!record.binding_scope.id.trim()) throw new Error("dojo_case_law_binding_scope_required");
  if (record.evidence_refs.length === 0) throw new Error("dojo_case_law_evidence_required");
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

function cloneCase(record: DojoCaseLawRecord): DojoCaseLawRecord {
  return JSON.parse(JSON.stringify(record)) as DojoCaseLawRecord;
}

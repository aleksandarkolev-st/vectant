import type { QueryResultRow } from "pg";
import { validateCaseLawRecord, type DojoCaseLawRecord } from "../case_law/registry.js";
import type { DojoTenantContext } from "../mcp/execution_policy_gate.js";
import {
  authorizeDojoGovernanceAction,
  type DojoGovernanceRbacAction,
  type DojoGovernanceRbacPolicy,
} from "../governance/service.js";
import type {
  DojoAuditActor,
  DojoAuditStore,
  DojoCaseLawRecordFilter,
  DojoPermissionUpgradeRequestFilter,
  DojoPermissionUpgradeRequestRecord,
} from "./interfaces.js";
import type { DojoPostgresQueryable } from "./postgres_proof_store.js";

export interface PostgresDojoGovernanceStoreOptions {
  tenant_id: string;
  workspace_id: string;
  queryable: DojoPostgresQueryable;
  audit_store?: DojoAuditStore;
  audit_actor?: DojoAuditActor;
  request_id?: string;
  correlation_id?: string;
  tenant_context?: DojoTenantContext;
  rbac_policy?: DojoGovernanceRbacPolicy;
  require_rbac?: boolean;
}

interface ApprovalRow extends QueryResultRow {
  approval_json: unknown;
}

interface CaseLawRow extends QueryResultRow {
  case_json: unknown;
}

export class PostgresDojoGovernanceStore {
  private readonly tenantId: string;
  private readonly workspaceId: string;
  private readonly queryable: DojoPostgresQueryable;
  private readonly auditStore?: DojoAuditStore;
  private readonly auditActor: DojoAuditActor;
  private readonly requestId: string;
  private readonly correlationId: string;
  private readonly tenantContext?: DojoTenantContext;
  private readonly rbacPolicy?: DojoGovernanceRbacPolicy;
  private readonly requireRbac: boolean;

  constructor(options: PostgresDojoGovernanceStoreOptions) {
    this.tenantId = requiredId(options.tenant_id, "tenant_id");
    this.workspaceId = requiredId(options.workspace_id, "workspace_id");
    this.queryable = options.queryable;
    this.auditStore = options.audit_store;
    this.auditActor = options.audit_actor ?? { actor_id: "dojo-postgres-governance-store", actor_type: "service" };
    this.requestId = options.request_id ?? "dojo-postgres-governance-store";
    this.correlationId = options.correlation_id ?? this.requestId;
    this.tenantContext = options.tenant_context;
    this.rbacPolicy = options.rbac_policy;
    this.requireRbac = options.require_rbac === true;
    this.assertTenantContextScope();
  }

  async savePermissionUpgradeRequest(record: DojoPermissionUpgradeRequestRecord): Promise<void> {
    this.assertPermissionUpgradeScope(record);
    this.assertPermissionUpgradeReviewAuthorization(record);
    await this.queryable.query(
      `INSERT INTO dojo_approvals (
        tenant_id,
        workspace_id,
        approval_id,
        skill_id,
        license_id,
        workflow_id,
        license_version,
        current_entrustment_level,
        requested_action,
        status,
        requested_by,
        requested_at,
        reviewed_by,
        reviewed_at,
        decision_reason,
        evidence_refs,
        approval_json
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz, $13, $14::timestamptz, $15, $16::text[], $17::jsonb)
      ON CONFLICT (tenant_id, workspace_id, approval_id) DO UPDATE SET
        skill_id = EXCLUDED.skill_id,
        license_id = EXCLUDED.license_id,
        workflow_id = EXCLUDED.workflow_id,
        license_version = EXCLUDED.license_version,
        current_entrustment_level = EXCLUDED.current_entrustment_level,
        requested_action = EXCLUDED.requested_action,
        status = EXCLUDED.status,
        requested_by = EXCLUDED.requested_by,
        requested_at = EXCLUDED.requested_at,
        reviewed_by = EXCLUDED.reviewed_by,
        reviewed_at = EXCLUDED.reviewed_at,
        decision_reason = EXCLUDED.decision_reason,
        evidence_refs = EXCLUDED.evidence_refs,
        approval_json = EXCLUDED.approval_json`,
      [
        this.tenantId,
        this.workspaceId,
        record.request_id,
        record.skill_id,
        record.license_id,
        record.workflow_id,
        record.license_version,
        record.current_entrustment_level,
        record.requested_action,
        record.status,
        record.requested_by.actor_id,
        record.requested_at,
        record.reviewed_by?.actor_id ?? null,
        record.reviewed_at ?? null,
        record.review_reason ?? null,
        uniqueStrings([...record.evidence_refs, ...(record.decision_evidence_refs ?? [])]),
        JSON.stringify(record),
      ]
    );
    await this.appendPermissionUpgradeAudit(record);
  }

  async listPermissionUpgradeRequests(
    filter: DojoPermissionUpgradeRequestFilter = {}
  ): Promise<DojoPermissionUpgradeRequestRecord[]> {
    const values: unknown[] = [this.tenantId, this.workspaceId];
    const predicates = ["tenant_id = $1", "workspace_id = $2"];
    addOptionalPredicate(predicates, values, "approval_id", filter.request_id);
    addOptionalPredicate(predicates, values, "skill_id", filter.skill_id);
    addOptionalPredicate(predicates, values, "workflow_id", filter.workflow_id);
    addOptionalPredicate(predicates, values, "requested_action", filter.requested_action);
    addOptionalPredicate(predicates, values, "status", filter.status);
    const limit = normalizedLimit(filter.limit);
    values.push(limit);
    const result = await this.queryable.query<ApprovalRow>(
      `SELECT approval_json
      FROM dojo_approvals
      WHERE ${predicates.join(" AND ")}
      ORDER BY requested_at DESC, approval_id ASC
      LIMIT $${values.length}`,
      values
    );
    return result.rows.map((row) => normalizeJsonObject<DojoPermissionUpgradeRequestRecord>(row.approval_json));
  }

  async saveCaseLawRecord(record: DojoCaseLawRecord): Promise<void> {
    validateCaseLawRecord(record);
    this.assertCaseLawReviewAuthorization(record);
    const skillId = record.binding_scope.kind === "skill" ? record.binding_scope.id : null;
    await this.queryable.query(
      `INSERT INTO dojo_case_law (
        tenant_id,
        workspace_id,
        case_id,
        skill_id,
        title,
        finding,
        impact,
        rule_created,
        applies_to,
        binding_scope_kind,
        binding_scope_id,
        status,
        appeal_status,
        reviewer,
        evidence_refs,
        superseded_by,
        case_json,
        created_at,
        updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10, $11, $12, $13, $14, $15::text[], $16, $17::jsonb, $18::timestamptz, $19::timestamptz)
      ON CONFLICT (tenant_id, workspace_id, case_id) DO UPDATE SET
        skill_id = EXCLUDED.skill_id,
        title = EXCLUDED.title,
        finding = EXCLUDED.finding,
        impact = EXCLUDED.impact,
        rule_created = EXCLUDED.rule_created,
        applies_to = EXCLUDED.applies_to,
        binding_scope_kind = EXCLUDED.binding_scope_kind,
        binding_scope_id = EXCLUDED.binding_scope_id,
        status = EXCLUDED.status,
        appeal_status = EXCLUDED.appeal_status,
        reviewer = EXCLUDED.reviewer,
        evidence_refs = EXCLUDED.evidence_refs,
        superseded_by = EXCLUDED.superseded_by,
        case_json = EXCLUDED.case_json,
        updated_at = EXCLUDED.updated_at`,
      [
        this.tenantId,
        this.workspaceId,
        record.case_id,
        skillId,
        record.title,
        record.finding,
        record.impact,
        record.rule_created,
        uniqueStrings(record.applies_to),
        record.binding_scope.kind,
        record.binding_scope.id,
        record.status,
        record.appeal_status,
        record.reviewer ?? null,
        uniqueStrings(record.evidence_refs),
        record.superseded_by ?? null,
        JSON.stringify(record),
        record.created_at,
        record.updated_at,
      ]
    );
    await this.appendCaseLawAudit(record);
  }

  async getCaseLawRecord(caseId: string): Promise<DojoCaseLawRecord | null> {
    const result = await this.queryable.query<CaseLawRow>(
      `SELECT case_json
      FROM dojo_case_law
      WHERE tenant_id = $1 AND workspace_id = $2 AND case_id = $3`,
      [this.tenantId, this.workspaceId, caseId]
    );
    return result.rows[0] ? normalizeJsonObject<DojoCaseLawRecord>(result.rows[0].case_json) : null;
  }

  async listCaseLawRecords(filter: DojoCaseLawRecordFilter = {}): Promise<DojoCaseLawRecord[]> {
    const values: unknown[] = [this.tenantId, this.workspaceId];
    const predicates = ["tenant_id = $1", "workspace_id = $2"];
    addOptionalPredicate(predicates, values, "case_id", filter.case_id);
    addOptionalPredicate(predicates, values, "status", filter.status);
    if (filter.binding_scope) {
      addOptionalPredicate(predicates, values, "binding_scope_kind", filter.binding_scope.kind);
      addOptionalPredicate(predicates, values, "binding_scope_id", filter.binding_scope.id);
    }
    if (filter.applies_to) {
      values.push(filter.applies_to);
      predicates.push(`applies_to @> ARRAY[$${values.length}]::text[]`);
    }
    const limit = normalizedLimit(filter.limit);
    values.push(limit);
    const result = await this.queryable.query<CaseLawRow>(
      `SELECT case_json
      FROM dojo_case_law
      WHERE ${predicates.join(" AND ")}
      ORDER BY binding_scope_kind ASC, binding_scope_id ASC, case_id ASC
      LIMIT $${values.length}`,
      values
    );
    return result.rows.map((row) => normalizeJsonObject<DojoCaseLawRecord>(row.case_json));
  }

  private assertPermissionUpgradeScope(record: DojoPermissionUpgradeRequestRecord): void {
    if (record.workspace_id !== this.workspaceId) throw new Error("dojo_postgres_governance_workspace_mismatch");
  }

  private assertTenantContextScope(): void {
    if (!this.tenantContext) return;
    if (this.tenantContext.tenant_id !== this.tenantId) {
      throw new Error("dojo_postgres_governance_tenant_context_tenant_mismatch");
    }
    if (this.tenantContext.workspace_id !== this.workspaceId) {
      throw new Error("dojo_postgres_governance_tenant_context_workspace_mismatch");
    }
  }

  private assertPermissionUpgradeReviewAuthorization(record: DojoPermissionUpgradeRequestRecord): void {
    if (record.status !== "approved" && record.status !== "denied") return;
    if (!record.reviewed_by?.actor_id?.trim()) {
      throw new Error("dojo_postgres_governance_permission_upgrade_reviewer_required");
    }
    this.assertReviewActorMatchesTenantContext(record.reviewed_by, "permission_upgrade");
    this.assertGovernanceActionAuthorized("permission_upgrade_review", "permission_upgrade");
  }

  private assertCaseLawReviewAuthorization(record: DojoCaseLawRecord): void {
    if (record.status !== "approved" && record.status !== "deprecated") return;
    if (!record.reviewer?.trim()) {
      throw new Error("dojo_postgres_governance_case_law_reviewer_required");
    }
    this.assertReviewActorMatchesTenantContext({ actor_id: record.reviewer, actor_type: "human" }, "case_law");
    this.assertGovernanceActionAuthorized("case_law_review", "case_law");
  }

  private assertReviewActorMatchesTenantContext(actor: DojoAuditActor, actionName: string): void {
    if (!this.tenantContext) return;
    if (this.tenantContext.actor_id !== actor.actor_id) {
      throw new Error(`dojo_postgres_governance_${actionName}_review_actor_mismatch`);
    }
  }

  private assertGovernanceActionAuthorized(action: DojoGovernanceRbacAction, actionName: string): void {
    if (!this.requireRbac && !this.tenantContext) return;
    const decision = authorizeDojoGovernanceAction({
      tenant_context: this.tenantContext,
      action,
      policy: this.rbacPolicy,
    });
    if (!decision.ok) {
      throw new Error(`dojo_postgres_governance_${actionName}_reviewer_role_required:${decision.blocked_by.join(",")}`);
    }
  }

  private async appendPermissionUpgradeAudit(record: DojoPermissionUpgradeRequestRecord): Promise<void> {
    if (!this.auditStore) return;
    const eventType = record.status === "approved"
      ? "approval_granted"
      : record.status === "denied"
        ? "approval_denied"
        : "permission_upgrade_requested";
    await this.auditStore.appendAuditEvent({
      tenant_id: this.tenantId,
      workspace_id: this.workspaceId,
      actor: record.reviewed_by ?? record.requested_by ?? this.auditActor,
      event_type: eventType,
      request_id: record.request_context.request_id || this.requestId,
      correlation_id: record.request_context.correlation_id || this.correlationId,
      entity_kind: "permission_upgrade_request",
      entity_id: record.request_id,
      details: {
        skill_id: record.skill_id,
        workflow_id: record.workflow_id,
        requested_action: record.requested_action,
        status: record.status,
      },
    });
  }

  private async appendCaseLawAudit(record: DojoCaseLawRecord): Promise<void> {
    if (!this.auditStore) return;
    const eventType = record.status === "approved"
      ? "case_law_approved"
      : record.status === "deprecated"
        ? "case_law_deprecated"
        : "case_law_proposed";
    await this.auditStore.appendAuditEvent({
      tenant_id: this.tenantId,
      workspace_id: this.workspaceId,
      actor: record.reviewer
        ? { actor_id: record.reviewer, actor_type: "human" }
        : this.auditActor,
      event_type: eventType,
      request_id: this.requestId,
      correlation_id: this.correlationId,
      entity_kind: "case_law",
      entity_id: record.case_id,
      details: {
        status: record.status,
        binding_scope: record.binding_scope,
        applies_to: record.applies_to,
      },
    });
  }
}

function addOptionalPredicate(
  predicates: string[],
  values: unknown[],
  column: string,
  value: string | undefined
): void {
  if (!value) return;
  values.push(value);
  predicates.push(`${column} = $${values.length}`);
}

function normalizeJsonObject<T>(value: unknown): T {
  if (typeof value === "string") return JSON.parse(value) as T;
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizedLimit(value: number | undefined): number {
  return Number.isFinite(value) && typeof value === "number" && value > 0
    ? Math.max(1, Math.min(Math.floor(value), 500))
    : 100;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function requiredId(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`dojo_postgres_governance_${field}_required`);
  return trimmed;
}

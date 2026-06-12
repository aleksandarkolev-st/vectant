import { createHash } from "node:crypto";
import type {
  DojoEntrustmentLevel,
  DojoPermissionLicense,
  DojoSkill,
  DojoSkillCase,
  DojoSkillReadinessLevel,
} from "../../browser/dojo.js";
import type { DojoAuditActor, DojoAuditEventType, DojoPermissionUpgradeRequestRecord } from "../store/interfaces.js";
import type { DojoCaseLawRecord } from "../case_law/registry.js";

export type DojoGovernanceLicenseStatus = "active" | "expiring" | "expired" | "revoked";
export type DojoGovernanceApprovalStatus = "pending" | "approved" | "denied";
export type DojoGovernanceActionStatus = "applied" | "rejected";
export type DojoPermissionUpgradeDecision = "approved" | "denied";
export type DojoCaseLawReviewDecision = "approved" | "deprecated";

export interface DojoGovernanceActionAuditSummary {
  event_type: DojoAuditEventType;
  actor: DojoAuditActor;
  occurred_at: string;
  workspace_id: string;
  skill_id: string;
  license_id?: string;
  request_id?: string;
  reason?: string;
  evidence_refs: string[];
}

export interface DojoPermissionUpgradeDecisionResult {
  ok: boolean;
  status: DojoGovernanceActionStatus;
  request: DojoPermissionUpgradeRequestRecord;
  audit_event?: DojoGovernanceActionAuditSummary;
  error?: "permission_upgrade_request_not_pending";
  blocked_by: string[];
}

export interface DojoSkillLicenseRevocationResult {
  ok: true;
  status: "applied";
  skill: DojoSkill;
  previous_license_version: string;
  revoked_license_version: string;
  blocked_actions: string[];
  audit_event?: DojoGovernanceActionAuditSummary;
}

export interface DojoCaseLawReviewDecisionResult {
  ok: boolean;
  status: DojoGovernanceActionStatus;
  case_law: DojoCaseLawRecord;
  audit_event?: DojoGovernanceActionAuditSummary;
  error?: "case_law_review_not_pending" | "case_law_already_deprecated";
  blocked_by: string[];
}

export interface DojoGovernanceLicenseHealth {
  skill_id: string;
  skill_name: string;
  workspace_id: string;
  license_id: string;
  license_version: string;
  status: DojoGovernanceLicenseStatus;
  entrustment_level: DojoEntrustmentLevel;
  readiness_level: DojoSkillReadinessLevel;
  autonomy_level: DojoPermissionLicense["autonomy_level"];
  expires_at: string;
  days_until_expiry: number | null;
  proof_required: boolean;
  allowed_action_count: number;
  gated_action_count: number;
  blocked_action_count: number;
  recertification_triggers: string[];
}

export interface DojoGovernanceApprovalQueueItem {
  queue_id: string;
  request_id?: string;
  skill_id: string;
  workspace_id: string;
  license_id: string;
  action: string;
  constraints: string[];
  reason: string;
  status: DojoGovernanceApprovalStatus;
  source: "license_gated_action" | "license_approval_requirement" | "permission_upgrade_request";
  requested_at?: string;
  evidence_refs?: string[];
}

export interface DojoGovernanceCaseLawReviewItem {
  case_id: string;
  title: string;
  skill_id: string;
  workspace_id: string;
  finding: string;
  impact: string;
  rule_created: string;
  status: "proposed";
  evidence_refs: string[];
  binding_scope: string;
  created_at?: string;
}

export interface DojoGovernanceSkillRegistryItem {
  skill_id: string;
  title: string;
  workspace_id: string;
  status: string;
  license_status: DojoGovernanceLicenseStatus;
  entrustment_level: DojoEntrustmentLevel;
  readiness_level: DojoSkillReadinessLevel;
  owner: string;
  published_tool_name: string;
  updated_at: string;
}

export interface DojoGovernancePolicyGateItem {
  gate_id: string;
  name: string;
  status: "active" | "warning" | "blocked";
  severity: "low" | "medium" | "high" | "critical";
  owner: string;
  scope: string;
  blocks: string[];
  evidence_refs: string[];
  next_step: string;
}

export interface DojoGovernanceRecertificationQueueItem {
  queue_id: string;
  skill_id: string;
  skill_name: string;
  reason: string;
  due_at: string;
  status: "queued" | "due" | "overdue";
  priority: "low" | "medium" | "high";
  evidence_refs: string[];
}

export interface DojoGovernanceAuditExportItem {
  export_id: string;
  title: string;
  status: "available" | "missing";
  generated_at: string;
  format: "json" | "zip";
  record_count: number;
  digest: string;
}

export interface DojoGovernanceComplianceArtifact {
  artifact_id: string;
  title: string;
  status: "available" | "missing";
  digest: string;
  evidence_refs: string[];
}

export interface DojoGovernanceComplianceEvidencePack {
  pack_id: string;
  generated_at: string;
  artifacts: DojoGovernanceComplianceArtifact[];
  missing_artifacts: string[];
  retention_class: "standard" | "regulated" | "legal_hold";
}

export interface DojoGovernanceServiceView {
  schema_version: "synthi.dojo.governanceService.v1";
  generated_at: string;
  license_health: DojoGovernanceLicenseHealth[];
  approval_queue: DojoGovernanceApprovalQueueItem[];
  case_law_review_queue: DojoGovernanceCaseLawReviewItem[];
  skill_registry: DojoGovernanceSkillRegistryItem[];
  policy_gates: DojoGovernancePolicyGateItem[];
  recertification_queue: DojoGovernanceRecertificationQueueItem[];
  audit_exports: DojoGovernanceAuditExportItem[];
  compliance_evidence_pack: DojoGovernanceComplianceEvidencePack;
  metrics: {
    skill_count: number;
    active_license_count: number;
    expired_license_count: number;
    pending_approval_count: number;
    case_law_review_count: number;
    policy_gate_count: number;
    recertification_count: number;
    compliance_artifact_count: number;
  };
}

export function decideDojoPermissionUpgradeRequest(input: {
  request: DojoPermissionUpgradeRequestRecord;
  decision: DojoPermissionUpgradeDecision;
  decided_by: DojoAuditActor;
  decided_at?: string;
  reason?: string;
  evidence_refs?: string[];
}): DojoPermissionUpgradeDecisionResult {
  const request = cloneJson(input.request);
  const decidedAt = input.decided_at ?? new Date().toISOString();
  const decisionEvidenceRefs = uniqueStrings(input.evidence_refs ?? []);
  if (request.status !== "pending") {
    return {
      ok: false,
      status: "rejected",
      request,
      error: "permission_upgrade_request_not_pending",
      blocked_by: [`request_status:${request.status}`],
    };
  }

  request.status = input.decision;
  request.reviewed_at = decidedAt;
  request.reviewed_by = cloneJson(input.decided_by);
  const reason = normalizedReason(input.reason, "");
  if (reason) request.review_reason = reason;
  if (decisionEvidenceRefs.length > 0) {
    request.decision_evidence_refs = decisionEvidenceRefs;
    request.evidence_refs = uniqueStrings([...request.evidence_refs, ...decisionEvidenceRefs]);
  }

  return {
    ok: true,
    status: "applied",
    request,
    audit_event: {
      event_type: input.decision === "approved" ? "approval_granted" : "approval_denied",
      actor: cloneJson(input.decided_by),
      occurred_at: decidedAt,
      workspace_id: request.workspace_id,
      skill_id: request.skill_id,
      license_id: request.license_id,
      request_id: request.request_id,
      reason,
      evidence_refs: decisionEvidenceRefs,
    },
    blocked_by: [],
  };
}

export function revokeDojoSkillLicense(input: {
  skill: DojoSkill;
  reason?: string;
  revoked_at?: string;
  revoked_by?: DojoAuditActor;
  evidence_refs?: string[];
}): DojoSkillLicenseRevocationResult {
  const revokedAt = input.revoked_at ?? new Date().toISOString();
  const reason = normalizedReason(input.reason, "operator_revoked");
  const evidenceRefs = uniqueStrings(input.evidence_refs ?? []);
  const skill = cloneJson(input.skill);
  const previousLicenseVersion = skill.permission_license.license_version;
  const blockedByAction = new Map<string, string[]>();

  for (const action of [
    ...skill.permission_license.blocked_actions,
    ...skill.permission_license.allowed_actions,
    ...skill.permission_license.gated_actions,
  ]) {
    blockedByAction.set(action.action, uniqueStrings([
      ...(blockedByAction.get(action.action) ?? []),
      ...action.constraints,
      `revoked:${reason}`,
    ]));
  }

  skill.entrustment_level = "EX";
  skill.skill_readiness_level = Math.min(skill.skill_readiness_level, 5) as DojoSkill["skill_readiness_level"];
  skill.permission_license = {
    ...skill.permission_license,
    license_version: bumpVersion(skill.permission_license.license_version),
    entrustment_level: "EX",
    autonomy_level: "blocked",
    allowed_actions: [],
    gated_actions: [],
    blocked_actions: [...blockedByAction.entries()]
      .map(([action, constraints]) => ({ action, constraints }))
      .sort((left, right) => left.action.localeCompare(right.action)),
    approval_requirements: [],
    issued_at: revokedAt,
  };
  skill.skill_card = {
    ...skill.skill_card,
    status: "Blocked pending recertification",
    can_do_alone: [],
    will_ask_before: [],
    will_not_do: skill.permission_license.blocked_actions.map((action) => action.action),
    proof_badge: "License revoked; proof capsules rejected",
  };
  skill.skill_passport = {
    ...skill.skill_passport,
    entrustment_level: "EX",
    readiness_level: skill.skill_readiness_level,
    license_id: skill.permission_license.license_id,
    proof_required: true,
    license_expires_at: revokedAt,
    issued_at: revokedAt,
  };
  skill.training_report = {
    ...skill.training_report,
    summary: {
      ...skill.training_report.summary,
      readiness_level: skill.skill_readiness_level,
      entrustment_level: "EX",
    },
    readiness_decision: `License revoked: ${reason}. Recertification required before production execution.`,
    limitations: uniqueStrings([...skill.training_report.limitations, `revoked:${reason}`]),
    evidence_refs: uniqueStrings([...skill.training_report.evidence_refs, ...evidenceRefs]),
  };
  skill.retrain_triggers = [
    ...skill.retrain_triggers,
    {
      trigger_id: `retrain_${hashStableId(`${skill.skill_id}:revoked:${previousLicenseVersion}:${revokedAt}:${reason}`)}`,
      source: "incident",
      condition: `license_revoked:${reason}`,
    },
  ];
  skill.license_expires_at = revokedAt;
  skill.last_trained_at = revokedAt;

  return {
    ok: true,
    status: "applied",
    skill,
    previous_license_version: previousLicenseVersion,
    revoked_license_version: skill.permission_license.license_version,
    blocked_actions: skill.permission_license.blocked_actions.map((action) => action.action),
    audit_event: input.revoked_by ? {
      event_type: "license_revoked",
      actor: cloneJson(input.revoked_by),
      occurred_at: revokedAt,
      workspace_id: skill.workspace_id,
      skill_id: skill.skill_id,
      license_id: skill.permission_license.license_id,
      reason,
      evidence_refs: evidenceRefs,
    } : undefined,
  };
}

export function decideDojoCaseLawReview(input: {
  case_law: DojoCaseLawRecord;
  decision: DojoCaseLawReviewDecision;
  decided_by: DojoAuditActor;
  decided_at?: string;
  reason?: string;
  evidence_refs?: string[];
  superseded_by?: string;
}): DojoCaseLawReviewDecisionResult {
  const record = cloneJson(input.case_law);
  const decidedAt = input.decided_at ?? new Date().toISOString();
  const decisionEvidenceRefs = uniqueStrings(input.evidence_refs ?? []);
  const reason = normalizedReason(input.reason, "");

  if (input.decision === "approved" && record.status !== "proposed") {
    return {
      ok: false,
      status: "rejected",
      case_law: record,
      error: "case_law_review_not_pending",
      blocked_by: [`case_law_status:${record.status}`],
    };
  }
  if (input.decision === "deprecated" && record.status === "deprecated") {
    return {
      ok: false,
      status: "rejected",
      case_law: record,
      error: "case_law_already_deprecated",
      blocked_by: ["case_law_status:deprecated"],
    };
  }

  record.status = input.decision;
  record.reviewer = input.decided_by.actor_id;
  record.updated_at = decidedAt;
  if (input.superseded_by?.trim()) record.superseded_by = input.superseded_by.trim();
  if (decisionEvidenceRefs.length > 0) {
    record.evidence_refs = uniqueStrings([...record.evidence_refs, ...decisionEvidenceRefs]);
  }

  return {
    ok: true,
    status: "applied",
    case_law: record,
    audit_event: {
      event_type: input.decision === "approved" ? "case_law_approved" : "case_law_deprecated",
      actor: cloneJson(input.decided_by),
      occurred_at: decidedAt,
      workspace_id: record.binding_scope.kind === "workspace" ? record.binding_scope.id : "",
      skill_id: record.binding_scope.kind === "skill" ? record.binding_scope.id : "",
      reason,
      evidence_refs: decisionEvidenceRefs,
    },
    blocked_by: [],
  };
}

export function buildDojoGovernanceServiceView(input: {
  skills: DojoSkill[];
  case_law_records?: DojoCaseLawRecord[];
  permission_upgrade_requests?: DojoPermissionUpgradeRequestRecord[];
  now?: string;
  expiry_warning_days?: number;
}): DojoGovernanceServiceView {
  const now = input.now ?? new Date().toISOString();
  const expiryWarningDays = input.expiry_warning_days ?? 14;
  const licenseHealth = queryDojoLicenseHealth({
    skills: input.skills,
    now,
    expiry_warning_days: expiryWarningDays,
  });
  const approvalQueue = queryDojoApprovalQueue({
    skills: input.skills,
    permission_upgrade_requests: input.permission_upgrade_requests ?? [],
  });
  const caseLawReviewQueue = queryDojoCaseLawReviewQueue({
    skills: input.skills,
    case_law_records: input.case_law_records ?? [],
  });
  const skillRegistry = queryDojoSkillRegistry({
    skills: input.skills,
    health: licenseHealth,
    now,
  });
  const policyGates = queryDojoPolicyGates({ skills: input.skills });
  const recertificationQueue = queryDojoRecertificationQueue({
    skills: input.skills,
    health: licenseHealth,
    now,
  });
  const auditExports = queryDojoAuditExports({
    skills: input.skills,
    case_law_review_queue: caseLawReviewQueue,
    generated_at: now,
  });
  const complianceEvidencePack = buildDojoComplianceEvidencePack({
    skills: input.skills,
    case_law_review_queue: caseLawReviewQueue,
    audit_exports: auditExports,
    generated_at: now,
  });

  return {
    schema_version: "synthi.dojo.governanceService.v1",
    generated_at: now,
    license_health: licenseHealth,
    approval_queue: approvalQueue,
    case_law_review_queue: caseLawReviewQueue,
    skill_registry: skillRegistry,
    policy_gates: policyGates,
    recertification_queue: recertificationQueue,
    audit_exports: auditExports,
    compliance_evidence_pack: complianceEvidencePack,
    metrics: {
      skill_count: input.skills.length,
      active_license_count: licenseHealth.filter((item) => item.status === "active" || item.status === "expiring").length,
      expired_license_count: licenseHealth.filter((item) => item.status === "expired" || item.status === "revoked").length,
      pending_approval_count: approvalQueue.filter((item) => item.status === "pending").length,
      case_law_review_count: caseLawReviewQueue.length,
      policy_gate_count: policyGates.length,
      recertification_count: recertificationQueue.length,
      compliance_artifact_count: complianceEvidencePack.artifacts.length,
    },
  };
}

export function queryDojoLicenseHealth(input: {
  skills: DojoSkill[];
  now?: string;
  expiry_warning_days?: number;
}): DojoGovernanceLicenseHealth[] {
  const nowMs = Date.parse(input.now ?? new Date().toISOString());
  const warningDays = input.expiry_warning_days ?? 14;
  return input.skills
    .map((skill) => {
      const license = skill.permission_license;
      const expiresAt = skill.license_expires_at || skill.skill_passport.license_expires_at || "";
      const daysUntilExpiry = daysUntil(expiresAt, nowMs);
      return {
        skill_id: skill.skill_id,
        skill_name: skill.name,
        workspace_id: skill.workspace_id,
        license_id: license.license_id,
        license_version: license.license_version,
        status: licenseStatusFor(skill, daysUntilExpiry, warningDays),
        entrustment_level: skill.entrustment_level,
        readiness_level: skill.skill_readiness_level,
        autonomy_level: license.autonomy_level,
        expires_at: expiresAt,
        days_until_expiry: daysUntilExpiry,
        proof_required: skill.skill_passport.proof_required,
        allowed_action_count: license.allowed_actions.length,
        gated_action_count: license.gated_actions.length,
        blocked_action_count: license.blocked_actions.length,
        recertification_triggers: [
          ...license.expiry_policy.expires_on,
          ...skill.retrain_triggers.map((trigger) => trigger.condition),
        ],
      };
    })
    .sort((left, right) => sortStatus(left.status) - sortStatus(right.status) || left.skill_id.localeCompare(right.skill_id));
}

export function queryDojoApprovalQueue(input: {
  skills: DojoSkill[];
  permission_upgrade_requests?: DojoPermissionUpgradeRequestRecord[];
}): DojoGovernanceApprovalQueueItem[] {
  const licenseDerived: DojoGovernanceApprovalQueueItem[] = input.skills
    .flatMap((skill) => {
      const gated = skill.permission_license.gated_actions.map((action) => ({
        queue_id: `approval_${skill.skill_id}_${action.action}`,
        skill_id: skill.skill_id,
        workspace_id: skill.workspace_id,
        license_id: skill.permission_license.license_id,
        action: action.action,
        constraints: [...action.constraints],
        reason: "Action is licensed only with explicit approval or extra evidence.",
        status: "pending" as const,
        source: "license_gated_action" as const,
      }));
      const explicit = skill.permission_license.approval_requirements.map((requirement) => ({
        queue_id: `approval_${skill.skill_id}_${requirement}`,
        skill_id: skill.skill_id,
        workspace_id: skill.workspace_id,
        license_id: skill.permission_license.license_id,
        action: requirement,
        constraints: [requirement],
        reason: "License policy requires a named approval before this scope can expand.",
        status: "pending" as const,
        source: "license_approval_requirement" as const,
      }));
      return [...gated, ...explicit];
    })

  const upgradeRequests: DojoGovernanceApprovalQueueItem[] = (input.permission_upgrade_requests ?? [])
    .filter((request) => request.status === "pending")
    .map((request) => ({
      queue_id: `permission_upgrade_${request.request_id}`,
      request_id: request.request_id,
      skill_id: request.skill_id,
      workspace_id: request.workspace_id,
      license_id: request.license_id,
      action: request.requested_action,
      constraints: [...request.required_steps],
      reason: "Permission upgrade request is waiting for review, evidence, or recertification.",
      status: "pending" as const,
      source: "permission_upgrade_request" as const,
      requested_at: request.requested_at,
      evidence_refs: [...request.evidence_refs],
    }));

  return [...licenseDerived, ...upgradeRequests]
    .sort((left, right) =>
      left.skill_id.localeCompare(right.skill_id)
        || left.action.localeCompare(right.action)
        || (left.requested_at ?? "").localeCompare(right.requested_at ?? "")
    );
}

export function queryDojoCaseLawReviewQueue(input: {
  skills: DojoSkill[];
  case_law_records?: DojoCaseLawRecord[];
}): DojoGovernanceCaseLawReviewItem[] {
  const skillItems = input.skills.flatMap((skill) =>
    skill.case_law
      .filter((record) => record.status === "proposed")
      .map((record) => caseLawItemFromSkillCase(skill, record))
  );
  const externalItems = (input.case_law_records ?? [])
    .filter((record) => record.status === "proposed")
    .map(caseLawItemFromRecord);
  return [...skillItems, ...externalItems]
    .sort((left, right) => left.workspace_id.localeCompare(right.workspace_id) || left.case_id.localeCompare(right.case_id));
}

export function queryDojoSkillRegistry(input: {
  skills: DojoSkill[];
  health: DojoGovernanceLicenseHealth[];
  now?: string;
}): DojoGovernanceSkillRegistryItem[] {
  const healthBySkill = new Map(input.health.map((item) => [item.skill_id, item]));
  return input.skills
    .map((skill) => {
      const health = healthBySkill.get(skill.skill_id);
      return {
        skill_id: skill.skill_id,
        title: skill.name,
        workspace_id: skill.workspace_id,
        status: skill.entrustment_level === "EX" ? "revoked" : "published",
        license_status: health?.status ?? "active",
        entrustment_level: skill.entrustment_level,
        readiness_level: skill.skill_readiness_level,
        owner: stringField(skill, "owner_id") || stringField(skill, "created_by") || "",
        published_tool_name: stringField(skill, "published_tool_name") || stringField(skill, "publishedToolName") || "",
        updated_at: stringField(skill, "updated_at") || stringField(skill, "created_at") || input.now || "",
      };
    })
    .sort((left, right) => left.workspace_id.localeCompare(right.workspace_id) || left.skill_id.localeCompare(right.skill_id));
}

export function queryDojoPolicyGates(input: { skills: DojoSkill[] }): DojoGovernancePolicyGateItem[] {
  return input.skills
    .flatMap((skill) => {
      const gates: DojoGovernancePolicyGateItem[] = [];
      if (skill.skill_passport.proof_required) {
        gates.push({
          gate_id: `proof_${skill.skill_id}`,
          name: "Proof capsule required",
          status: "active",
          severity: "high",
          owner: "proof_license",
          scope: `skill:${skill.skill_id}`,
          blocks: [...skill.permission_license.gated_actions.map((action) => action.action)],
          evidence_refs: stringArrayField(skill.skill_passport, "evidence_refs"),
          next_step: "Issue and validate an unused proof capsule through the Dojo skill bus.",
        });
      }
      for (const action of skill.permission_license.gated_actions) {
        gates.push({
          gate_id: `approval_${skill.skill_id}_${action.action}`,
          name: `Approval required for ${action.action}`,
          status: "active",
          severity: "medium",
          owner: "governance",
          scope: `license:${skill.permission_license.license_id}`,
          blocks: [action.action],
          evidence_refs: [],
          next_step: "Collect required approval evidence before production execution.",
        });
      }
      for (const action of skill.permission_license.blocked_actions) {
        gates.push({
          gate_id: `blocked_${skill.skill_id}_${action.action}`,
          name: `Blocked action ${action.action}`,
          status: "blocked",
          severity: "critical",
          owner: "license_kernel",
          scope: `license:${skill.permission_license.license_id}`,
          blocks: [action.action],
          evidence_refs: [],
          next_step: "Create a reviewed license draft and rerun checkride before enabling this action.",
        });
      }
      for (const record of skill.case_law.filter((item) => item.status === "binding")) {
        gates.push({
          gate_id: `case_${record.case_id}`,
          name: record.title,
          status: "active",
          severity: "high",
          owner: "case_law",
          scope: `${record.binding_scope}:${skill.workspace_id}`,
          blocks: [...record.applies_to],
          evidence_refs: [...record.evidence_refs],
          next_step: record.rule_created,
        });
      }
      return gates;
    })
    .sort((left, right) => left.scope.localeCompare(right.scope) || left.gate_id.localeCompare(right.gate_id));
}

export function queryDojoRecertificationQueue(input: {
  skills: DojoSkill[];
  health: DojoGovernanceLicenseHealth[];
  now?: string;
}): DojoGovernanceRecertificationQueueItem[] {
  const healthBySkill = new Map(input.health.map((item) => [item.skill_id, item]));
  return input.skills
    .flatMap((skill) => {
      const health = healthBySkill.get(skill.skill_id);
      const triggers = new Set([
        ...(health?.status === "expired" ? ["license_expired"] : []),
        ...(health?.status === "expiring" ? ["license_expiring"] : []),
        ...skill.retrain_triggers.map((trigger) => trigger.condition),
      ]);
      return [...triggers].map((reason) => {
        const overdue = health?.status === "expired";
        const due = health?.status === "expiring" || reason === "license_expiring";
        const status: DojoGovernanceRecertificationQueueItem["status"] = overdue ? "overdue" : due ? "due" : "queued";
        const priority: DojoGovernanceRecertificationQueueItem["priority"] = overdue ? "high" : due ? "medium" : "low";
        return {
          queue_id: `recert_${skill.skill_id}_${slugFor(reason)}`,
          skill_id: skill.skill_id,
          skill_name: skill.name,
          reason,
          due_at: health?.expires_at ?? skill.license_expires_at ?? "",
          status,
          priority,
          evidence_refs: stringArrayField(skill.skill_passport, "evidence_refs"),
        };
      });
    })
    .sort((left, right) => prioritySort(left.priority) - prioritySort(right.priority) || left.skill_id.localeCompare(right.skill_id));
}

export function queryDojoAuditExports(input: {
  skills: DojoSkill[];
  case_law_review_queue: DojoGovernanceCaseLawReviewItem[];
  generated_at: string;
}): DojoGovernanceAuditExportItem[] {
  const skillCount = input.skills.length;
  const caseLawRecordCount = input.skills.reduce((count, skill) => count + skill.case_law.length, 0)
    + input.case_law_review_queue.length;
  return [
    {
      export_id: "skill_assurance_case",
      title: "Skill Assurance Case",
      status: skillCount > 0 ? "available" : "missing",
      generated_at: input.generated_at,
      format: "json",
      record_count: skillCount,
      digest: digestFor(["skill_assurance_case", skillCount, input.generated_at]),
    },
    {
      export_id: "license_history",
      title: "License History",
      status: skillCount > 0 ? "available" : "missing",
      generated_at: input.generated_at,
      format: "json",
      record_count: skillCount,
      digest: digestFor(["license_history", ...input.skills.map((skill) => skill.permission_license.license_id)]),
    },
    {
      export_id: "case_law_registry",
      title: "Case Law Registry",
      status: caseLawRecordCount > 0 ? "available" : "missing",
      generated_at: input.generated_at,
      format: "json",
      record_count: caseLawRecordCount,
      digest: digestFor([
        "case_law_registry",
        ...input.skills.flatMap((skill) => skill.case_law.map((item) => item.case_id)),
        ...input.case_law_review_queue.map((item) => item.case_id),
      ]),
    },
  ];
}

export function buildDojoComplianceEvidencePack(input: {
  skills: DojoSkill[];
  case_law_review_queue: DojoGovernanceCaseLawReviewItem[];
  audit_exports: DojoGovernanceAuditExportItem[];
  generated_at: string;
}): DojoGovernanceComplianceEvidencePack {
  const skillCaseLaw = input.skills.flatMap((skill) => skill.case_law);
  const caseLawEvidenceRefs = [
    ...skillCaseLaw.flatMap((item) => item.evidence_refs),
    ...input.case_law_review_queue.flatMap((item) => item.evidence_refs),
  ];
  const artifacts: DojoGovernanceComplianceArtifact[] = [
    {
      artifact_id: "skill_assurance_case",
      title: "Skill Assurance Case",
      status: input.skills.length > 0 ? "available" : "missing",
      digest: digestFor(["compliance", "skill_assurance_case", input.skills.length]),
      evidence_refs: input.skills.flatMap((skill) => stringArrayField(skill.skill_passport, "evidence_refs")),
    },
    {
      artifact_id: "license_and_proof_audit",
      title: "License and Proof Audit",
      status: input.audit_exports.some((item) => item.export_id === "license_history" && item.status === "available")
        ? "available"
        : "missing",
      digest: digestFor(["compliance", "license_and_proof_audit", ...input.skills.map((skill) => skill.permission_license.license_id)]),
      evidence_refs: [],
    },
    {
      artifact_id: "case_law_registry",
      title: "Case Law Registry",
      status: skillCaseLaw.length > 0 || input.case_law_review_queue.length > 0 ? "available" : "missing",
      digest: digestFor([
        "compliance",
        "case_law_registry",
        ...skillCaseLaw.map((item) => item.case_id),
        ...input.case_law_review_queue.map((item) => item.case_id),
      ]),
      evidence_refs: caseLawEvidenceRefs,
    },
  ];
  return {
    pack_id: `governance_pack_${digestFor([input.generated_at, artifacts.map((item) => item.artifact_id).join(":")]).slice(0, 12)}`,
    generated_at: input.generated_at,
    artifacts,
    missing_artifacts: artifacts.filter((item) => item.status === "missing").map((item) => item.artifact_id),
    retention_class: artifacts.some((item) => item.status === "available") ? "standard" : "regulated",
  };
}

function licenseStatusFor(skill: DojoSkill, daysUntilExpiry: number | null, warningDays: number): DojoGovernanceLicenseStatus {
  if (skill.entrustment_level === "EX" || skill.permission_license.autonomy_level === "blocked") return "revoked";
  if (daysUntilExpiry !== null && daysUntilExpiry < 0) return "expired";
  if (daysUntilExpiry !== null && daysUntilExpiry <= warningDays) return "expiring";
  return "active";
}

function daysUntil(expiresAt: string, nowMs: number): number | null {
  const expiresMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresMs) || !Number.isFinite(nowMs)) return null;
  return Math.ceil((expiresMs - nowMs) / 86_400_000);
}

function sortStatus(status: DojoGovernanceLicenseStatus): number {
  switch (status) {
    case "revoked":
      return 0;
    case "expired":
      return 1;
    case "expiring":
      return 2;
    case "active":
      return 3;
  }
}

function prioritySort(priority: DojoGovernanceRecertificationQueueItem["priority"]): number {
  switch (priority) {
    case "high":
      return 0;
    case "medium":
      return 1;
    case "low":
      return 2;
  }
}

function slugFor(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "trigger";
}

function stringField(source: unknown, key: string): string {
  if (!source || typeof source !== "object") return "";
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

function stringArrayField(source: unknown, key: string): string[] {
  if (!source || typeof source !== "object") return [];
  const value = (source as Record<string, unknown>)[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function normalizedReason(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

function bumpVersion(version: string): string {
  const parts = version.split(".").map((part) => Number.parseInt(part, 10));
  const majorCandidate = parts[0] ?? Number.NaN;
  const minorCandidate = parts[1] ?? Number.NaN;
  const patchCandidate = parts[2] ?? Number.NaN;
  const major = Number.isFinite(majorCandidate) ? majorCandidate : 1;
  const minor = Number.isFinite(minorCandidate) ? minorCandidate : 0;
  const patch = Number.isFinite(patchCandidate) ? patchCandidate : 0;
  return `${major}.${minor}.${patch + 1}`;
}

function hashStableId(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);
}

function digestFor(parts: unknown[]): string {
  let hash = 0x811c9dc5;
  const input = JSON.stringify(parts);
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function caseLawItemFromSkillCase(skill: DojoSkill, record: DojoSkillCase): DojoGovernanceCaseLawReviewItem {
  return {
    case_id: record.case_id,
    title: record.title,
    skill_id: skill.skill_id,
    workspace_id: skill.workspace_id,
    finding: record.finding,
    impact: record.impact,
    rule_created: record.rule_created,
    status: "proposed",
    evidence_refs: [...record.evidence_refs],
    binding_scope: record.binding_scope,
    created_at: record.date,
  };
}

function caseLawItemFromRecord(record: DojoCaseLawRecord): DojoGovernanceCaseLawReviewItem {
  return {
    case_id: record.case_id,
    title: record.title,
    skill_id: record.binding_scope.kind === "skill" ? record.binding_scope.id : "",
    workspace_id: record.binding_scope.kind === "workspace" ? record.binding_scope.id : "",
    finding: record.finding,
    impact: record.impact,
    rule_created: record.rule_created,
    status: "proposed",
    evidence_refs: [...record.evidence_refs],
    binding_scope: `${record.binding_scope.kind}:${record.binding_scope.id}`,
    created_at: record.created_at,
  };
}

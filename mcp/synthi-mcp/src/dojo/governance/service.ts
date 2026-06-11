import type {
  DojoEntrustmentLevel,
  DojoPermissionLicense,
  DojoSkill,
  DojoSkillCase,
  DojoSkillReadinessLevel,
} from "../../browser/dojo.js";
import type { DojoCaseLawRecord } from "../case_law/registry.js";

export type DojoGovernanceLicenseStatus = "active" | "expiring" | "expired" | "revoked";
export type DojoGovernanceApprovalStatus = "pending" | "approved" | "denied";

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
  skill_id: string;
  workspace_id: string;
  license_id: string;
  action: string;
  constraints: string[];
  reason: string;
  status: DojoGovernanceApprovalStatus;
  source: "license_gated_action" | "license_approval_requirement";
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

export interface DojoGovernanceServiceView {
  schema_version: "synthi.dojo.governanceService.v1";
  generated_at: string;
  license_health: DojoGovernanceLicenseHealth[];
  approval_queue: DojoGovernanceApprovalQueueItem[];
  case_law_review_queue: DojoGovernanceCaseLawReviewItem[];
  metrics: {
    skill_count: number;
    active_license_count: number;
    expired_license_count: number;
    pending_approval_count: number;
    case_law_review_count: number;
  };
}

export function buildDojoGovernanceServiceView(input: {
  skills: DojoSkill[];
  case_law_records?: DojoCaseLawRecord[];
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
  const approvalQueue = queryDojoApprovalQueue({ skills: input.skills });
  const caseLawReviewQueue = queryDojoCaseLawReviewQueue({
    skills: input.skills,
    case_law_records: input.case_law_records ?? [],
  });

  return {
    schema_version: "synthi.dojo.governanceService.v1",
    generated_at: now,
    license_health: licenseHealth,
    approval_queue: approvalQueue,
    case_law_review_queue: caseLawReviewQueue,
    metrics: {
      skill_count: input.skills.length,
      active_license_count: licenseHealth.filter((item) => item.status === "active" || item.status === "expiring").length,
      expired_license_count: licenseHealth.filter((item) => item.status === "expired" || item.status === "revoked").length,
      pending_approval_count: approvalQueue.filter((item) => item.status === "pending").length,
      case_law_review_count: caseLawReviewQueue.length,
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

export function queryDojoApprovalQueue(input: { skills: DojoSkill[] }): DojoGovernanceApprovalQueueItem[] {
  return input.skills
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
    .sort((left, right) => left.skill_id.localeCompare(right.skill_id) || left.action.localeCompare(right.action));
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

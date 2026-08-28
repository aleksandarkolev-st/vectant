import {
  authorizeDojoGovernanceAction,
  type DojoGovernanceRbacDecision,
  type DojoGovernanceRbacPolicy,
} from "../governance/service.js";
import type { DojoTenantContext } from "../mcp/execution_policy_gate.js";
import { promotePolicyDelta } from "./policy_delta.js";
import type { RegretMemoryStore } from "./store.js";
import type { PolicyDelta } from "./types.js";

export interface RegretPolicyControlResult {
  ok: boolean;
  status: "applied" | "rejected";
  policy_delta?: PolicyDelta;
  deleted_count?: number;
  blocked_by: string[];
  rbac_authorization?: DojoGovernanceRbacDecision;
}

export async function inspectRegretPolicyDeltas(input: {
  store: RegretMemoryStore;
  workspace_id: string;
  skill_id?: string;
  task_class?: string;
  status?: PolicyDelta["status"];
  tenant_context?: DojoTenantContext;
  rbac_policy?: DojoGovernanceRbacPolicy;
  require_rbac?: boolean;
}): Promise<{ policy_deltas: PolicyDelta[]; rbac_authorization?: DojoGovernanceRbacDecision }> {
  const rbac = regretRbac({
    action: "regret_policy_view",
    tenant_context: input.tenant_context,
    policy: input.rbac_policy,
    required: input.require_rbac,
  });
  if (rbac && !rbac.ok) {
    return { policy_deltas: [], rbac_authorization: rbac };
  }
  return {
    policy_deltas: await input.store.listPolicyDeltas({
      workspace_id: input.workspace_id,
      skill_id: input.skill_id,
      task_class: input.task_class,
      status: input.status,
    }),
    ...(rbac ? { rbac_authorization: rbac } : {}),
  };
}

export async function promoteRegretPolicyDelta(input: {
  store: RegretMemoryStore;
  policy_delta_id: string;
  promoted_at: string;
  promoted_by: string;
  evidence_ids: string[];
  tenant_context?: DojoTenantContext;
  rbac_policy?: DojoGovernanceRbacPolicy;
  require_rbac?: boolean;
}): Promise<RegretPolicyControlResult> {
  const rbac = regretRbac({
    action: "regret_policy_review",
    tenant_context: input.tenant_context,
    policy: input.rbac_policy,
    required: input.require_rbac,
  });
  if (rbac && !rbac.ok) return rejected(rbac.blocked_by, rbac);
  const deltas = await input.store.listPolicyDeltas({
    workspace_id: input.tenant_context?.workspace_id ?? "",
  });
  const delta = deltas.find((item) => item.policy_delta_id === input.policy_delta_id);
  if (!delta) return rejected(["regret_policy_delta_not_found"], rbac);
  try {
    const promoted = promotePolicyDelta({
      delta,
      promoted_at: input.promoted_at,
      promoted_by: input.promoted_by,
      evidence_ids: input.evidence_ids,
    });
    await input.store.putPolicyDelta(promoted);
    return { ok: true, status: "applied", policy_delta: promoted, blocked_by: [], ...(rbac ? { rbac_authorization: rbac } : {}) };
  } catch (error) {
    return rejected([error instanceof Error ? error.message : "regret_policy_delta_promotion_failed"], rbac);
  }
}

export async function disableRegretPolicyDelta(input: {
  store: RegretMemoryStore;
  policy_delta_id: string;
  disabled_at: string;
  disabled_by: string;
  tenant_context?: DojoTenantContext;
  rbac_policy?: DojoGovernanceRbacPolicy;
  require_rbac?: boolean;
}): Promise<RegretPolicyControlResult> {
  const rbac = regretRbac({
    action: "regret_policy_review",
    tenant_context: input.tenant_context,
    policy: input.rbac_policy,
    required: input.require_rbac,
  });
  if (rbac && !rbac.ok) return rejected(rbac.blocked_by, rbac);
  try {
    const disabled = await input.store.disablePolicyDelta(input.policy_delta_id, {
      disabled_at: input.disabled_at,
      disabled_by: input.disabled_by,
    });
    return { ok: true, status: "applied", policy_delta: disabled, blocked_by: [], ...(rbac ? { rbac_authorization: rbac } : {}) };
  } catch (error) {
    return rejected([error instanceof Error ? error.message : "regret_policy_delta_disable_failed"], rbac);
  }
}

export async function deleteWorkspaceRegretMemory(input: {
  store: RegretMemoryStore;
  workspace_id: string;
  deleted_at: string;
  deleted_by: string;
  tenant_context?: DojoTenantContext;
  rbac_policy?: DojoGovernanceRbacPolicy;
  require_rbac?: boolean;
}): Promise<RegretPolicyControlResult> {
  const rbac = regretRbac({
    action: "regret_policy_delete",
    tenant_context: input.tenant_context,
    policy: input.rbac_policy,
    required: input.require_rbac,
  });
  if (rbac && !rbac.ok) return rejected(rbac.blocked_by, rbac);
  if (!input.deleted_by.trim()) return rejected(["regret_memory_delete_actor_required"], rbac);
  const result = await input.store.deleteWorkspaceMemory({
    workspace_id: input.workspace_id,
    deleted_at: input.deleted_at,
    deleted_by: input.deleted_by,
  });
  return { ok: true, status: "applied", deleted_count: result.deleted_count, blocked_by: [], ...(rbac ? { rbac_authorization: rbac } : {}) };
}

function regretRbac(input: {
  action: "regret_policy_view" | "regret_policy_review" | "regret_policy_delete";
  tenant_context?: DojoTenantContext;
  policy?: DojoGovernanceRbacPolicy;
  required?: boolean;
}): DojoGovernanceRbacDecision | null {
  if (!input.required && !input.tenant_context) return null;
  return authorizeDojoGovernanceAction({
    tenant_context: input.tenant_context,
    action: input.action,
    policy: input.policy,
  });
}

function rejected(blockedBy: string[], rbac?: DojoGovernanceRbacDecision | null): RegretPolicyControlResult {
  return {
    ok: false,
    status: "rejected",
    blocked_by: [...new Set(blockedBy)].sort(),
    ...(rbac ? { rbac_authorization: rbac } : {}),
  };
}

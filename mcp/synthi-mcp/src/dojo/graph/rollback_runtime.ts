import type { DojoGraphNode } from "./types.js";

export type DojoRollbackStrategy =
  | "none"
  | "human_checkpoint"
  | "same_session_restore"
  | "ci_fixture_reset"
  | "field_restore"
  | "file_restore"
  | "record_delete"
  | "compensating_action"
  | "mark_for_human_review";

export type DojoRollbackDecisionStatus =
  | "not_required"
  | "rollback_available"
  | "needs_human"
  | "blocked";

export interface DojoRollbackPolicyLike {
  strategy: DojoRollbackStrategy;
  checkpoints?: string[];
  requires_human_before?: string[];
}

export interface DojoRollbackDecision {
  status: DojoRollbackDecisionStatus;
  strategy: DojoRollbackStrategy;
  requires_human_review: boolean;
  blocked_by: string[];
  checkpoints: string[];
}

export function decideDojoRollbackForAssertionFailure(node: DojoGraphNode): DojoRollbackDecision {
  const policy = rollbackPolicyForNode(node);
  if (!policy) {
    return {
      status: "needs_human",
      strategy: "none",
      requires_human_review: true,
      blocked_by: ["rollback_policy_missing_human_review_required"],
      checkpoints: [],
    };
  }

  const checkpoints = policy.checkpoints ?? [];
  if (policy.strategy === "none") {
    return {
      status: "needs_human",
      strategy: "none",
      requires_human_review: true,
      blocked_by: ["rollback_unavailable_human_review_required"],
      checkpoints,
    };
  }
  if (policy.strategy === "human_checkpoint" || policy.strategy === "mark_for_human_review") {
    return {
      status: "needs_human",
      strategy: policy.strategy,
      requires_human_review: true,
      blocked_by: ["rollback_human_review_required"],
      checkpoints,
    };
  }
  return {
    status: "rollback_available",
    strategy: policy.strategy,
    requires_human_review: false,
    blocked_by: [],
    checkpoints,
  };
}

export function noRollbackRequired(): DojoRollbackDecision {
  return {
    status: "not_required",
    strategy: "none",
    requires_human_review: false,
    blocked_by: [],
    checkpoints: [],
  };
}

function rollbackPolicyForNode(node: DojoGraphNode): DojoRollbackPolicyLike | null {
  const policy = node.metadata?.["rollback_policy"];
  if (!isRollbackPolicyLike(policy)) return null;
  return policy;
}

function isRollbackPolicyLike(value: unknown): value is DojoRollbackPolicyLike {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const strategy = (value as Record<string, unknown>)["strategy"];
  return typeof strategy === "string" && isRollbackStrategy(strategy);
}

function isRollbackStrategy(value: string): value is DojoRollbackStrategy {
  return [
    "none",
    "human_checkpoint",
    "same_session_restore",
    "ci_fixture_reset",
    "field_restore",
    "file_restore",
    "record_delete",
    "compensating_action",
    "mark_for_human_review",
  ].includes(value);
}

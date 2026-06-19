export type DojoAffordancePatchKind =
  | "stable_locator"
  | "proof_hook"
  | "success_hook"
  | "risk_annotation"
  | "accessibility_label"
  | "sandbox_fixture"
  | "reset_profile";

export interface DojoAffordancePatchOperation {
  operation_id: string;
  kind: DojoAffordancePatchKind;
  file_path: string;
  target_component: string;
  target_match?: DojoAffordancePatchTargetMatch;
  affordance_id: string;
  before?: string;
  after: string;
  validation_expectation: string;
}

export interface DojoAffordancePatchTargetMatch {
  text?: string;
  role?: "button" | "link" | "input" | "action";
  attribute?: {
    name: string;
    value?: string;
  };
}

export interface DojoAffordancePrPlan {
  schema_version: "synthi.dojo.affordancePrPlan.v1";
  plan_id: string;
  app_origin: string;
  app_version: string;
  operations: DojoAffordancePatchOperation[];
  required_tests: string[];
  review_gates: string[];
}

export interface DojoAffordancePrPlanIssue {
  issue_id: string;
  severity: "error" | "warning";
  operation_id?: string;
  message: string;
}

export interface DojoAffordancePrPlanValidation {
  ok: boolean;
  issues: DojoAffordancePrPlanIssue[];
}

export function validateDojoAffordancePrPlan(plan: DojoAffordancePrPlan): DojoAffordancePrPlanValidation {
  const issues: DojoAffordancePrPlanIssue[] = [];
  if (plan.schema_version !== "synthi.dojo.affordancePrPlan.v1") {
    issues.push(errorIssue("affordance_pr_plan_schema_invalid", "Unsupported affordance PR plan schema."));
  }
  if (!plan.plan_id.trim()) issues.push(errorIssue("affordance_pr_plan_id_required", "Plan ID is required."));
  if (!plan.app_origin.trim()) issues.push(errorIssue("affordance_pr_plan_app_origin_required", "App origin is required."));
  if (!plan.app_version.trim()) issues.push(errorIssue("affordance_pr_plan_app_version_required", "App version is required."));
  if (plan.operations.length === 0) issues.push(errorIssue("affordance_pr_plan_operation_required", "At least one patch operation is required."));
  for (const operation of plan.operations) {
    lintOperation(operation, issues);
  }
  return {
    ok: issues.every((issue) => issue.severity !== "error"),
    issues,
  };
}

export function stableLocatorPatchOperation(input: {
  file_path: string;
  target_component: string;
  target_match?: DojoAffordancePatchTargetMatch;
  affordance_id: string;
  locator_attribute?: string;
}): DojoAffordancePatchOperation {
  const attribute = input.locator_attribute ?? "data-agent-action";
  return {
    operation_id: `patch_stable_locator_${slug(input.affordance_id)}`,
    kind: "stable_locator",
    file_path: input.file_path,
    target_component: input.target_component,
    ...(input.target_match ? { target_match: input.target_match } : {}),
    affordance_id: input.affordance_id,
    after: `${attribute}="${input.affordance_id}"`,
    validation_expectation: `Component ${input.target_component} exposes stable locator ${attribute}=${input.affordance_id}.`,
  };
}

export function proofHookPatchOperation(input: {
  file_path: string;
  target_component: string;
  target_match?: DojoAffordancePatchTargetMatch;
  affordance_id: string;
  hook_name: string;
}): DojoAffordancePatchOperation {
  return {
    operation_id: `patch_proof_hook_${slug(input.affordance_id)}`,
    kind: "proof_hook",
    file_path: input.file_path,
    target_component: input.target_component,
    ...(input.target_match ? { target_match: input.target_match } : {}),
    affordance_id: input.affordance_id,
    after: input.hook_name,
    validation_expectation: `Risky affordance ${input.affordance_id} calls proof hook ${input.hook_name}.`,
  };
}

function lintOperation(operation: DojoAffordancePatchOperation, issues: DojoAffordancePrPlanIssue[]): void {
  if (!operation.operation_id.trim()) issues.push(errorIssue("affordance_patch_operation_id_required", "Patch operation ID is required."));
  if (!operation.file_path.trim()) issues.push(errorIssue("affordance_patch_file_path_required", "Patch operation file path is required.", operation.operation_id));
  if (!operation.target_component.trim()) issues.push(errorIssue("affordance_patch_component_required", "Target component is required.", operation.operation_id));
  if (!operation.affordance_id.trim()) issues.push(errorIssue("affordance_patch_affordance_id_required", "Affordance ID is required.", operation.operation_id));
  if (!operation.after.trim()) issues.push(errorIssue("affordance_patch_after_required", "Patch operation after value is required.", operation.operation_id));
  if (!operation.validation_expectation.trim()) issues.push(errorIssue("affordance_patch_validation_required", "Patch operation requires validation expectation.", operation.operation_id));
  if (operation.kind === "stable_locator" && !/data-agent-action|data-testid|aria-label/.test(operation.after)) {
    issues.push(errorIssue("affordance_patch_stable_locator_invalid", "Stable locator patch must add a stable action/test/accessibility attribute.", operation.operation_id));
  }
  if (operation.kind === "proof_hook" && !/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(operation.after)) {
    issues.push(errorIssue("affordance_patch_proof_hook_invalid", "Proof hook patch must name a callable hook.", operation.operation_id));
  }
  lintTargetMatch(operation, issues);
}

function lintTargetMatch(operation: DojoAffordancePatchOperation, issues: DojoAffordancePrPlanIssue[]): void {
  const match = operation.target_match;
  if (!match) return;
  if (!match.text?.trim() && !match.role && !match.attribute) {
    issues.push(errorIssue("affordance_patch_target_match_empty", "Target match must include text, role, or attribute criteria.", operation.operation_id));
  }
  if (match.attribute && !/^[a-zA-Z_][a-zA-Z0-9_:-]*$/.test(match.attribute.name)) {
    issues.push(errorIssue("affordance_patch_target_attribute_invalid", "Target match attribute name is not a valid JSX attribute name.", operation.operation_id));
  }
  if (match.attribute?.value !== undefined && !match.attribute.value.trim()) {
    issues.push(errorIssue("affordance_patch_target_attribute_value_empty", "Target match attribute value cannot be empty.", operation.operation_id));
  }
}

function errorIssue(issueId: string, message: string, operationId?: string): DojoAffordancePrPlanIssue {
  return {
    issue_id: issueId,
    severity: "error",
    ...(operationId ? { operation_id: operationId } : {}),
    message,
  };
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "affordance";
}

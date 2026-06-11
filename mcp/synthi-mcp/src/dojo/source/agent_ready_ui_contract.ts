export type AgentReadyUiRisk = "safe" | "mutation" | "dangerous";
export type AgentReadyUiSubstrate = "dom" | "source" | "api" | "mcp";

export interface AgentReadyUiContractAction {
  affordance_id: string;
  component: string;
  route: string;
  role: string;
  risk: AgentReadyUiRisk;
  required_inputs: string[];
  success_condition: string;
  approval_policy: "none" | "ask_before" | "required";
  stable_locator: string;
  proof_required: boolean;
  proof_hook?: string;
  success_hook?: string;
  accessibility_label: string;
  allowed_substrate: AgentReadyUiSubstrate[];
  blocked_contexts: string[];
  source_version: string;
  contract_version: string;
}

export interface AgentReadyUiContract {
  schema_version: "synthi.dojo.agentReadyUiContract.v1";
  contract_id: string;
  app_origin: string;
  app_version: string;
  actions: AgentReadyUiContractAction[];
}

export interface AgentReadyUiContractIssue {
  issue_id: string;
  severity: "error" | "warning";
  affordance_id?: string;
  message: string;
}

export interface AgentReadyUiContractValidation {
  ok: boolean;
  issues: AgentReadyUiContractIssue[];
}

export function validateAgentReadyUiContract(contract: AgentReadyUiContract): AgentReadyUiContractValidation {
  const issues: AgentReadyUiContractIssue[] = [];
  if (contract.schema_version !== "synthi.dojo.agentReadyUiContract.v1") {
    issues.push(errorIssue("ui_contract_schema_version_invalid", "Unsupported Agent-Ready UI Contract schema version."));
  }
  if (!contract.contract_id.trim()) issues.push(errorIssue("ui_contract_id_required", "Contract ID is required."));
  if (!contract.app_origin.trim()) issues.push(errorIssue("ui_contract_app_origin_required", "App origin is required."));
  if (!contract.app_version.trim()) issues.push(errorIssue("ui_contract_app_version_required", "App version is required."));

  const affordanceIds = new Set<string>();
  for (const action of contract.actions) {
    lintAction(action, issues, affordanceIds);
  }

  return {
    ok: issues.every((issue) => issue.severity !== "error"),
    issues,
  };
}

function lintAction(
  action: AgentReadyUiContractAction,
  issues: AgentReadyUiContractIssue[],
  affordanceIds: Set<string>
): void {
  if (!action.affordance_id.trim()) issues.push(errorIssue("ui_affordance_id_required", "Affordance ID is required."));
  if (affordanceIds.has(action.affordance_id)) {
    issues.push(errorIssue("ui_affordance_id_duplicate", "Affordance ID must be unique.", action.affordance_id));
  }
  affordanceIds.add(action.affordance_id);
  if (!action.component.trim()) issues.push(errorIssue("ui_component_required", "Component is required.", action.affordance_id));
  if (!action.route.trim()) issues.push(errorIssue("ui_route_required", "Route is required.", action.affordance_id));
  if (!action.stable_locator.trim()) {
    issues.push(errorIssue("ui_stable_locator_required", "Stable locator is required.", action.affordance_id));
  }
  if (!action.accessibility_label.trim()) {
    issues.push(errorIssue("ui_accessibility_label_required", "Accessibility label is required.", action.affordance_id));
  }
  if (action.allowed_substrate.length === 0) {
    issues.push(errorIssue("ui_allowed_substrate_required", "At least one allowed substrate is required.", action.affordance_id));
  }
  if (action.risk !== "safe" && !action.success_hook?.trim()) {
    issues.push(errorIssue("ui_success_hook_required_for_risky_action", "Risky actions require a success hook.", action.affordance_id));
  }
  if ((action.risk === "mutation" || action.risk === "dangerous" || action.proof_required) && !action.proof_hook?.trim()) {
    issues.push(errorIssue("ui_proof_hook_required_for_risky_action", "Proof-required or risky actions require a proof hook.", action.affordance_id));
  }
  if (action.risk === "dangerous" && action.blocked_contexts.length === 0) {
    issues.push(errorIssue("ui_blocked_contexts_required_for_dangerous_action", "Dangerous actions require explicit blocked contexts.", action.affordance_id));
  }
  if (action.proof_required !== (action.risk !== "safe" || action.approval_policy !== "none")) {
    issues.push(warnIssue("ui_proof_requirement_review_recommended", "Proof requirement should match risk and approval policy.", action.affordance_id));
  }
}

function errorIssue(issueId: string, message: string, affordanceId?: string): AgentReadyUiContractIssue {
  return {
    issue_id: issueId,
    severity: "error",
    ...(affordanceId ? { affordance_id: affordanceId } : {}),
    message,
  };
}

function warnIssue(issueId: string, message: string, affordanceId?: string): AgentReadyUiContractIssue {
  return {
    issue_id: issueId,
    severity: "warning",
    ...(affordanceId ? { affordance_id: affordanceId } : {}),
    message,
  };
}

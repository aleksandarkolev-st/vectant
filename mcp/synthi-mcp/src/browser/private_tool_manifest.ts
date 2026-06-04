import type {
  WorkflowContractV7,
  WorkflowParameterV7,
} from "./workflow.js";

export interface PrivateWorkflowToolManifestV7 {
  kind: "privateMcpToolManifest";
  schema_version: "synthi_private_browser_tool_v1";
  status: "available" | "manualOnly" | "blocked";
  workflow_id: string;
  tool_name: string;
  title: string;
  description: string;
  parameters: Array<{
    name: string;
    label: string;
    required: boolean;
    redacted: boolean;
    value_shape: WorkflowParameterV7["valueShape"];
  }>;
  run_modes: WorkflowContractV7["publishPlan"]["runModes"];
  default_run_mode: "sameSession" | "prefixOnly" | "confirmBeforeCommit" | "ciOnly";
  auth: {
    durability: WorkflowContractV7["publishPlan"]["authDurability"];
    unattended_ready: boolean;
    required: boolean;
  };
  mutation: {
    mode: WorkflowContractV7["publishPlan"]["mutationMode"];
    first_mutation_step_id: string | null;
    requires_confirmation: boolean;
    requires_ci_isolation: boolean;
  };
  source_identity: WorkflowContractV7["sourceIdentityCoverage"];
  safety: {
    blockers: WorkflowContractV7["publishPlan"]["blockers"];
    limitations: WorkflowContractV7["limitations"];
    failure_classes: WorkflowContractV7["failureClasses"];
    notes: string[];
  };
  backing_tools: {
    compile_workflow: "synthi_browser_compile_workflow";
    run_workflow: "synthi_browser_run_workflow";
    auth_readiness: "synthi_auth_get_tool_auth_readiness";
    mutation_plan: "synthi_safety_get_mutation_plan";
    source_lookup: "synthi_source_lookup_token";
  };
}

export function generatePrivateWorkflowToolManifest(contract: WorkflowContractV7): PrivateWorkflowToolManifestV7 {
  const publish = contract.publishPlan;
  const hasMutation = contract.mutationBoundaryPlan.mutationSteps.length > 0;
  return {
    kind: "privateMcpToolManifest",
    schema_version: "synthi_private_browser_tool_v1",
    status: publish.readiness === "ready" ? "available" : publish.readiness,
    workflow_id: contract.workflowId,
    tool_name: publish.privateToolName,
    title: contract.name,
    description: contract.description,
    parameters: contract.parameters.map((parameter) => ({
      name: parameter.name,
      label: parameter.label,
      required: parameter.required,
      redacted: parameter.redacted,
      value_shape: parameter.valueShape,
    })),
    run_modes: publish.runModes,
    default_run_mode: hasMutation ? "confirmBeforeCommit" : publish.runModes[0] ?? "sameSession",
    auth: {
      durability: publish.authDurability,
      unattended_ready: publish.unattendedReady,
      required: contract.authPlan.required,
    },
    mutation: {
      mode: publish.mutationMode,
      first_mutation_step_id: contract.mutationBoundaryPlan.firstMutationStepId ?? null,
      requires_confirmation: hasMutation,
      requires_ci_isolation: hasMutation,
    },
    source_identity: contract.sourceIdentityCoverage,
    safety: {
      blockers: publish.blockers,
      limitations: contract.limitations,
      failure_classes: contract.failureClasses,
      notes: publish.notes,
    },
    backing_tools: {
      compile_workflow: "synthi_browser_compile_workflow",
      run_workflow: "synthi_browser_run_workflow",
      auth_readiness: "synthi_auth_get_tool_auth_readiness",
      mutation_plan: "synthi_safety_get_mutation_plan",
      source_lookup: "synthi_source_lookup_token",
    },
  };
}

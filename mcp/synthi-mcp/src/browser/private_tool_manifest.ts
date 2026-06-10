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
  target_origins: Array<{
    origin: string;
    primary: boolean;
    kinds: NonNullable<WorkflowContractV7["steps"][number]["targetContext"]>["kind"][];
    step_ids: string[];
    origin_consent_required: true;
    screenshot_consent_required: boolean;
    diagnostics_consent_required: boolean;
    approved_during_teach: boolean;
  }>;
  run_modes: WorkflowContractV7["publishPlan"]["runModes"];
  default_run_mode: "sameSession" | "prefixOnly" | "coldSession" | "confirmBeforeCommit" | "ciOnly";
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
  surface_replay: {
    unsupported_count: number;
    parameterized_count: number;
    steps: Array<{
      step_id: string;
      action: WorkflowContractV7["steps"][number]["action"]["kind"];
      kind: WorkflowContractV7["steps"][number]["surfacePlan"]["kind"];
      replay: WorkflowContractV7["steps"][number]["surfacePlan"]["replay"];
      notes: string[];
    }>;
  };
  safety: {
    blockers: WorkflowContractV7["publishPlan"]["blockers"];
    limitations: WorkflowContractV7["limitations"];
    failure_classes: WorkflowContractV7["failureClasses"];
    notes: string[];
  };
  backing_tools: {
    compile_workflow: "synthi_browser_compile_workflow";
    run_workflow: "synthi_browser_run_workflow";
    ci_isolated_replay: "synthi_safety_run_ci_isolated_replay";
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
    parameters: manifestParameters(contract.parameters),
    target_origins: manifestTargetOrigins(contract),
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
    surface_replay: {
      unsupported_count: contract.steps.filter((step) =>
        step.surfacePlan.replay === "unsupported" || step.surfacePlan.replay === "blocked"
      ).length,
      parameterized_count: contract.steps.filter((step) => step.surfacePlan.replay === "parameterized").length,
      steps: contract.steps.map((step) => ({
        step_id: step.stepId,
        action: step.action.kind,
        kind: step.surfacePlan.kind,
        replay: step.surfacePlan.replay,
        notes: [...step.surfacePlan.notes],
      })),
    },
    safety: {
      blockers: publish.blockers,
      limitations: contract.limitations,
      failure_classes: contract.failureClasses,
      notes: publish.notes,
    },
    backing_tools: {
      compile_workflow: "synthi_browser_compile_workflow",
      run_workflow: "synthi_browser_run_workflow",
      ci_isolated_replay: "synthi_safety_run_ci_isolated_replay",
      auth_readiness: "synthi_auth_get_tool_auth_readiness",
      mutation_plan: "synthi_safety_get_mutation_plan",
      source_lookup: "synthi_source_lookup_token",
    },
  };
}

function manifestTargetOrigins(contract: WorkflowContractV7): PrivateWorkflowToolManifestV7["target_origins"] {
  type TargetOrigin = PrivateWorkflowToolManifestV7["target_origins"][number];
  const byOrigin = new Map<string, TargetOrigin>();
  const addOrigin = (input: {
    origin?: string;
    kind: TargetOrigin["kinds"][number];
    stepId: string;
    screenshot: boolean;
    diagnostics: boolean;
    approved: boolean;
  }) => {
    const origin = input.origin?.trim();
    if (!origin) return;
    const existing = byOrigin.get(origin);
    if (existing) {
      if (!existing.kinds.includes(input.kind)) existing.kinds.push(input.kind);
      if (!existing.step_ids.includes(input.stepId)) existing.step_ids.push(input.stepId);
      existing.screenshot_consent_required = existing.screenshot_consent_required || input.screenshot;
      existing.diagnostics_consent_required = existing.diagnostics_consent_required || input.diagnostics;
      existing.approved_during_teach = existing.approved_during_teach || input.approved;
      return;
    }
    byOrigin.set(origin, {
      origin,
      primary: origin === contract.appOrigin,
      kinds: [input.kind],
      step_ids: [input.stepId],
      origin_consent_required: true,
      screenshot_consent_required: input.screenshot,
      diagnostics_consent_required: input.diagnostics,
      approved_during_teach: input.approved,
    });
  };

  for (const step of contract.steps) {
    const context = step.targetContext;
    if (!context) continue;
    addOrigin({
      origin: context.targetOrigin ?? context.origin,
      kind: context.kind,
      stepId: step.stepId,
      screenshot: context.consent.screenshotApproved,
      diagnostics: context.consent.diagnosticsApproved,
      approved: context.consent.exactOriginApproved,
    });
    if (context.frame?.origin) {
      addOrigin({
        origin: context.frame.origin,
        kind: context.kind === "popupIframe" ? "popupIframe" : "iframe",
        stepId: step.stepId,
        screenshot: context.consent.screenshotApproved,
        diagnostics: context.consent.diagnosticsApproved,
        approved: context.consent.exactOriginApproved,
      });
    }
    if (context.popup?.origin) {
      addOrigin({
        origin: context.popup.origin,
        kind: context.kind === "popupIframe" ? "popupIframe" : "popup",
        stepId: step.stepId,
        screenshot: context.consent.popupScreenshotApproved || context.consent.screenshotApproved,
        diagnostics: context.consent.diagnosticsApproved,
        approved: context.consent.popupOriginApproved || context.consent.exactOriginApproved,
      });
    }
  }

  return [...byOrigin.values()]
    .sort((a, b) => Number(b.primary) - Number(a.primary) || a.origin.localeCompare(b.origin))
    .map((target) => ({
      ...target,
      kinds: [...target.kinds].sort(),
      step_ids: [...target.step_ids].sort(),
    }));
}

function manifestParameters(parameters: WorkflowParameterV7[]): PrivateWorkflowToolManifestV7["parameters"] {
  const byName = new Map<string, PrivateWorkflowToolManifestV7["parameters"][number]>();
  for (const parameter of parameters) {
    const existing = byName.get(parameter.name);
    const next: PrivateWorkflowToolManifestV7["parameters"][number] = {
      name: parameter.name,
      label: parameter.label,
      required: parameter.required,
      redacted: parameter.redacted,
      value_shape: parameter.valueShape,
    };
    if (!existing) {
      byName.set(parameter.name, next);
      continue;
    }
    byName.set(parameter.name, {
      name: existing.name,
      label: existing.label || next.label,
      required: existing.required || next.required,
      redacted: existing.redacted || next.redacted,
      value_shape: mergedValueShape(existing.value_shape, next.value_shape),
    });
  }
  return [...byName.values()];
}

function mergedValueShape(
  a: WorkflowParameterV7["valueShape"],
  b: WorkflowParameterV7["valueShape"]
): WorkflowParameterV7["valueShape"] {
  if (a === b) return a;
  if (a === "secret" || b === "secret") return "secret";
  if (a === "unknown") return b;
  if (b === "unknown") return a;
  if (a === "empty") return b;
  if (b === "empty") return a;
  return "unknown";
}

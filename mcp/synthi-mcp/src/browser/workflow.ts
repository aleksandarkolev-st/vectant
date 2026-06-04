import type { BrowserActionKind, BrowserElementMetadata, BrowserTraceEvent, LocatorCandidate } from "./types.js";

export type WorkflowStateV7 =
  | "Draft"
  | "Runnable"
  | "Auth-ready"
  | "Source-linked"
  | "Read-only verified"
  | "Mutation-limited"
  | "Limited"
  | "Blocked";

export type WorkflowLimitationV7 =
  | "sourceIdentityMissing"
  | "mutationRequiresIsolation"
  | "unresolvedStep"
  | "crossOriginTrace"
  | "redactedInputValue"
  | "lowConfidenceLocator";

export type AuthDurabilityV7 =
  | "noneRequired"
  | "interactiveCheckpoint"
  | "idpCheckpoint"
  | "refreshProvider"
  | "ciTestAuth";

export type FailureClassV7 =
  | "locatorDrift"
  | "authMissing"
  | "authExpired"
  | "mutationBlocked"
  | "unsafeEnvironment"
  | "testDataMissing"
  | "routeChanged"
  | "hydrationDelay"
  | "networkFailure"
  | "appValidationError"
  | "closedShadowDomBlocked"
  | "canvasUnreliable"
  | "pointerDragUnreliable"
  | "sourceIdentityMissing"
  | "unknown";

type MutationKindV7 = "create" | "update" | "delete" | "archive" | "send" | "payment" | "deploy" | "unknown";

export interface WorkflowParameterV7 {
  name: string;
  label: string;
  sourceStepId: string;
  valueShape: "empty" | "shortText" | "longText" | "email" | "number" | "secret" | "unknown";
  required: boolean;
  redacted: boolean;
}

export interface WorkflowStepContractV7 {
  stepId: string;
  eventSeq: number;
  label: string;
  intent: string;
  action: {
    kind: BrowserActionKind | "assert";
    target?: {
      label: string;
      role?: string;
      locator?: string;
    };
    valueRef?: string;
  };
  locatorPlan: {
    primary?: LocatorCandidate;
    fallbacks: LocatorCandidate[];
    confidence: "high" | "medium" | "low" | "none";
  };
  sourcePlan: {
    status: "linked" | "missing";
    sourceId?: string;
  };
  expectedEffects: string[];
  mutation?: {
    kind: MutationKindV7;
    evidence: string[];
    canRunInSameSession: boolean;
    canRunInBackground: boolean;
    requiresIsolation: boolean;
  };
  limitations: WorkflowLimitationV7[];
}

export interface WorkflowContractV7 {
  workflowId: string;
  name: string;
  description: string;
  appOrigin: string;
  routePattern?: string;
  authPlan: {
    durability: AuthDurabilityV7;
    required: boolean;
    notes: string[];
  };
  mutationBoundaryPlan: {
    firstMutationStepId?: string;
    mutationSteps: Array<NonNullable<WorkflowStepContractV7["mutation"]> & { stepId: string }>;
    defaultReplayMode: "sameSession" | "prefixOnly" | "ciIsolated" | "blocked";
  };
  sourceIdentityCoverage: {
    linkedSteps: number;
    totalSteps: number;
    status: "complete" | "partial" | "missing";
  };
  parameters: WorkflowParameterV7[];
  steps: WorkflowStepContractV7[];
  successCriteria: Array<{
    id: string;
    label: string;
    source: "inferred" | "userMarked";
    required: boolean;
  }>;
  failureClasses: FailureClassV7[];
  replayModes: Array<"sameSession" | "prefixOnly" | "ciIsolated">;
  limitations: WorkflowLimitationV7[];
  generatedOutputs: Array<{
    kind: "playwright";
    status: "available" | "blocked";
    notes: string[];
  }>;
}

export interface WorkflowCardV7 {
  title: string;
  status: string;
  state: WorkflowStateV7[];
  summary: string[];
  stepCount: number;
  unresolvedCount: number;
  primaryCta: "validateSameSession" | "reviewLimitations" | "blocked";
}

export interface CompiledWorkflowV7 {
  contract: WorkflowContractV7;
  card: WorkflowCardV7;
}

const MUTATION_WORDS: Array<[RegExp, MutationKindV7, string]> = [
  [/\b(create|add|new|invite)\b/i, "create", "label_implies_create"],
  [/\b(save|update|edit|submit|apply|confirm)\b/i, "update", "label_implies_update"],
  [/\b(delete|remove|destroy)\b/i, "delete", "label_implies_delete"],
  [/\b(archive)\b/i, "archive", "label_implies_archive"],
  [/\b(send|email|notify)\b/i, "send", "label_implies_send"],
  [/\b(charge|pay|refund|payment)\b/i, "payment", "label_implies_payment"],
  [/\b(deploy|publish|merge)\b/i, "deploy", "label_implies_deploy"],
];

export function compileWorkflowContract(events: BrowserTraceEvent[]): CompiledWorkflowV7 {
  const ordered = [...events].sort((a, b) => (a.event_seq || 0) - (b.event_seq || 0));
  const actionEvents = ordered.filter((event) => event.kind === "human_action" || event.kind === "agent_action" || event.kind === "navigation");
  const appOrigin = firstHttpOrigin(actionEvents) ?? firstHttpOrigin(ordered) ?? "unknown";
  const steps = actionEvents.map((event, index) => stepFromEvent(event, index + 1));
  const parameters = parametersFromSteps(steps, actionEvents);
  const mutationSteps = steps
    .filter((step) => step.mutation)
    .map((step) => ({ stepId: step.stepId, ...step.mutation! }));
  const limitations = workflowLimitations(ordered, steps, appOrigin, mutationSteps.length > 0);
  const linkedSteps = steps.filter((step) => step.sourcePlan.status === "linked").length;
  const sourceStatus = linkedSteps === 0 ? "missing" : linkedSteps === steps.length ? "complete" : "partial";
  const firstMutationStepId = mutationSteps[0]?.stepId;
  const name = workflowName(steps);
  const replayModes: WorkflowContractV7["replayModes"] = mutationSteps.length > 0 ? ["sameSession", "prefixOnly"] : ["sameSession"];
  const contract: WorkflowContractV7 = {
    workflowId: workflowIdFor(appOrigin, steps),
    name,
    description: steps.length > 0 ? `${name} compiled from ${steps.length} taught browser steps.` : "No actionable taught steps were recorded.",
    appOrigin,
    routePattern: routePatternFor(actionEvents),
    authPlan: {
      durability: "noneRequired",
      required: false,
      notes: ["No auth checkpoint was detected in this trace."],
    },
    mutationBoundaryPlan: {
      ...(firstMutationStepId ? { firstMutationStepId } : {}),
      mutationSteps,
      defaultReplayMode: mutationSteps.length > 0 ? "prefixOnly" : "sameSession",
    },
    sourceIdentityCoverage: {
      linkedSteps,
      totalSteps: steps.length,
      status: sourceStatus,
    },
    parameters,
    steps,
    successCriteria: successCriteriaFor(steps),
    failureClasses: failureClassesFor(limitations, mutationSteps.length > 0),
    replayModes,
    limitations,
    generatedOutputs: [
      {
        kind: "playwright",
        status: steps.length > 0 ? "available" : "blocked",
        notes: mutationSteps.length > 0
          ? ["Generated Playwright should stop at the first mutation boundary for background hardening."]
          : ["Generated Playwright can run in the current same-session context."],
      },
    ],
  };
  return {
    contract,
    card: cardForContract(contract),
  };
}

function stepFromEvent(event: BrowserTraceEvent, ordinal: number): WorkflowStepContractV7 {
  const element = elementForEvent(event);
  const targetLabel = targetLabelFor(event, element);
  const primary = event.locator_candidates?.[0];
  const fallbacks = event.locator_candidates?.slice(1) ?? [];
  const confidence = locatorConfidence(primary);
  const actionKind = event.kind === "navigation" ? "navigate" : event.action ?? "wait";
  const stepId = event.event_id || `step_${ordinal}`;
  const parameterName = actionKind === "fill" || actionKind === "select" ? parameterNameFor(event, element, ordinal) : undefined;
  const mutation = mutationFor(actionKind, targetLabel, event);
  const limitations: WorkflowLimitationV7[] = [];
  if (!element?.source_id) limitations.push("sourceIdentityMissing");
  if (!primary) limitations.push("unresolvedStep");
  if (primary && primary.confidence < 0.7) limitations.push("lowConfidenceLocator");
  if (event.redacted) limitations.push("redactedInputValue");
  if (mutation) limitations.push("mutationRequiresIsolation");
  return {
    stepId,
    eventSeq: event.event_seq,
    label: labelForAction(actionKind, targetLabel),
    intent: intentForAction(actionKind, targetLabel),
    action: {
      kind: actionKind,
      ...(targetLabel ? { target: { label: targetLabel, ...(element?.role ? { role: element.role } : {}), ...(primary?.locator ? { locator: primary.locator } : {}) } } : {}),
      ...(parameterName ? { valueRef: parameterName } : {}),
    },
    locatorPlan: {
      ...(primary ? { primary } : {}),
      fallbacks,
      confidence,
    },
    sourcePlan: element?.source_id ? { status: "linked", sourceId: element.source_id } : { status: "missing" },
    expectedEffects: expectedEffectsFor(actionKind, targetLabel, mutation !== undefined),
    ...(mutation ? { mutation } : {}),
    limitations,
  };
}

function elementForEvent(event: BrowserTraceEvent): BrowserElementMetadata | undefined {
  const element = event.detail?.["element"];
  return element && typeof element === "object" ? element as BrowserElementMetadata : undefined;
}

function targetLabelFor(event: BrowserTraceEvent, element?: BrowserElementMetadata): string {
  if (element?.label) return element.label;
  if (element?.name) return element.name;
  if (element?.text) return compactText(element.text);
  if (element?.placeholder) return element.placeholder;
  if (element?.test_id) return element.test_id;
  if (event.selector) return event.selector;
  if (event.kind === "navigation") return routeName(event.url);
  return "recorded target";
}

function labelForAction(action: BrowserActionKind, targetLabel: string): string {
  switch (action) {
    case "fill":
      return `Fill ${targetLabel}`;
    case "click":
      return `Click ${targetLabel}`;
    case "press":
      return `Press key on ${targetLabel}`;
    case "select":
      return `Select ${targetLabel}`;
    case "check":
      return `Check ${targetLabel}`;
    case "uncheck":
      return `Uncheck ${targetLabel}`;
    case "navigate":
      return `Open ${targetLabel}`;
    case "wait":
      return `Wait for ${targetLabel}`;
  }
}

function intentForAction(action: BrowserActionKind, targetLabel: string): string {
  switch (action) {
    case "fill":
    case "select":
      return `Provide ${targetLabel} input`;
    case "click":
      return `Activate ${targetLabel}`;
    case "navigate":
      return `Reach ${targetLabel}`;
    case "wait":
      return `Wait for ${targetLabel}`;
    default:
      return `Perform ${action} on ${targetLabel}`;
  }
}

function expectedEffectsFor(action: BrowserActionKind, targetLabel: string, mutates: boolean): string[] {
  if (mutates) return [`${targetLabel} changes application state or reaches a mutation boundary.`];
  if (action === "fill" || action === "select") return [`${targetLabel} contains the parameter value.`];
  if (action === "navigate") return [`The browser reaches ${targetLabel}.`];
  return [`${targetLabel} remains visible and actionable.`];
}

function mutationFor(
  action: BrowserActionKind,
  targetLabel: string,
  event: BrowserTraceEvent
): WorkflowStepContractV7["mutation"] | undefined {
  if (action !== "click" && action !== "press" && action !== "select") return undefined;
  const evidence: string[] = [];
  for (const [pattern, kind, reason] of MUTATION_WORDS) {
    if (pattern.test(targetLabel)) {
      evidence.push(reason);
      return {
        kind,
        evidence,
        canRunInSameSession: true,
        canRunInBackground: false,
        requiresIsolation: true,
      };
    }
  }
  if (String(event.detail?.["network_method"] ?? "").match(/^(POST|PUT|PATCH|DELETE)$/i)) {
    return {
      kind: "unknown",
      evidence: ["network_method_implies_mutation"],
      canRunInSameSession: true,
      canRunInBackground: false,
      requiresIsolation: true,
    };
  }
  return undefined;
}

function parametersFromSteps(steps: WorkflowStepContractV7[], events: BrowserTraceEvent[]): WorkflowParameterV7[] {
  const byStep = new Map(events.map((event) => [event.event_id, event]));
  return steps.flatMap((step) => {
    const valueRef = step.action.valueRef;
    if (!valueRef) return [];
    const event = byStep.get(step.stepId);
    return [{
      name: valueRef,
      label: step.action.target?.label ?? valueRef,
      sourceStepId: step.stepId,
      valueShape: valueShape(event?.value, event?.redacted === true),
      required: true,
      redacted: event?.redacted === true,
    }];
  });
}

function parameterNameFor(event: BrowserTraceEvent, element: BrowserElementMetadata | undefined, ordinal: number): string {
  const explicit = typeof event.detail?.["field_name"] === "string" ? event.detail["field_name"] as string : undefined;
  const base = explicit || element?.label || element?.name || element?.placeholder || element?.test_id || `input_${ordinal}`;
  return slugIdentifier(base);
}

function valueShape(value: string | undefined, redacted: boolean): WorkflowParameterV7["valueShape"] {
  if (redacted) return "secret";
  if (value === undefined) return "unknown";
  if (value.length === 0) return "empty";
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) return "email";
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return "number";
  return value.length > 80 ? "longText" : "shortText";
}

function workflowLimitations(
  events: BrowserTraceEvent[],
  steps: WorkflowStepContractV7[],
  appOrigin: string,
  hasMutation: boolean
): WorkflowLimitationV7[] {
  const limitations = new Set<WorkflowLimitationV7>();
  if (steps.some((step) => step.sourcePlan.status === "missing")) limitations.add("sourceIdentityMissing");
  if (steps.some((step) => step.locatorPlan.confidence === "none")) limitations.add("unresolvedStep");
  if (steps.some((step) => step.locatorPlan.confidence === "low")) limitations.add("lowConfidenceLocator");
  if (steps.some((step) => step.limitations.includes("redactedInputValue"))) limitations.add("redactedInputValue");
  if (hasMutation) limitations.add("mutationRequiresIsolation");
  if (events.some((event) => event.origin && appOrigin !== "unknown" && event.origin !== appOrigin)) limitations.add("crossOriginTrace");
  return [...limitations];
}

function successCriteriaFor(steps: WorkflowStepContractV7[]): WorkflowContractV7["successCriteria"] {
  const last = steps[steps.length - 1];
  if (!last) return [];
  if (last.mutation) {
    return [{
      id: `${last.stepId}_boundary_visible`,
      label: `${last.action.target?.label ?? last.label} is reachable as the mutation boundary.`,
      source: "inferred",
      required: true,
    }];
  }
  return [{
    id: `${last.stepId}_effect_visible`,
    label: last.expectedEffects[0] ?? `${last.label} completes.`,
    source: "inferred",
    required: true,
  }];
}

function failureClassesFor(limitations: WorkflowLimitationV7[], hasMutation: boolean): FailureClassV7[] {
  const classes = new Set<FailureClassV7>(["locatorDrift", "hydrationDelay", "routeChanged", "networkFailure", "unknown"]);
  if (limitations.includes("sourceIdentityMissing")) classes.add("sourceIdentityMissing");
  if (limitations.includes("unresolvedStep")) classes.add("testDataMissing");
  if (hasMutation) {
    classes.add("mutationBlocked");
    classes.add("unsafeEnvironment");
  }
  return [...classes];
}

function cardForContract(contract: WorkflowContractV7): WorkflowCardV7 {
  const state: WorkflowStateV7[] = ["Draft"];
  if (contract.steps.length > 0) state.push("Runnable");
  if (!contract.authPlan.required) state.push("Auth-ready");
  if (contract.sourceIdentityCoverage.status !== "missing") state.push("Source-linked");
  if (contract.mutationBoundaryPlan.mutationSteps.length > 0) state.push("Mutation-limited");
  if (contract.limitations.length > 0) state.push("Limited");
  const unresolvedCount = contract.steps.filter((step) => step.limitations.includes("unresolvedStep")).length;
  return {
    title: contract.name,
    status: contract.steps.length > 0
      ? contract.mutationBoundaryPlan.mutationSteps.length > 0
        ? "Runnable in this session. Background hardening stops before mutation."
        : "Runnable in this session. Not hardened yet."
      : "Blocked. No actionable taught steps were recorded.",
    state,
    summary: [
      `${contract.steps.length} steps understood`,
      `${contract.parameters.length} parameters detected`,
      contract.sourceIdentityCoverage.status === "missing" ? "Source identity missing" : "Source identity linked",
      contract.mutationBoundaryPlan.mutationSteps.length > 0 ? "Mutation boundary detected" : "No mutation boundary detected",
    ],
    stepCount: contract.steps.length,
    unresolvedCount,
    primaryCta: contract.steps.length === 0 ? "blocked" : unresolvedCount > 0 ? "reviewLimitations" : "validateSameSession",
  };
}

function workflowName(steps: WorkflowStepContractV7[]): string {
  const mutation = steps.find((step) => step.mutation);
  if (mutation?.action.target?.label) return titleCase(mutation.action.target.label);
  const lastClick = [...steps].reverse().find((step) => step.action.kind === "click" && step.action.target?.label);
  if (lastClick?.action.target?.label) return titleCase(lastClick.action.target.label);
  return "Taught browser workflow";
}

function workflowIdFor(origin: string, steps: WorkflowStepContractV7[]): string {
  const seed = `${origin}:${steps.map((step) => `${step.eventSeq}:${step.action.kind}:${step.action.target?.label ?? ""}`).join("|")}`;
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  return `wf_${Math.abs(hash).toString(36)}`;
}

function firstHttpOrigin(events: BrowserTraceEvent[]): string | null {
  for (const event of events) {
    try {
      const url = new URL(event.url);
      if (url.protocol === "http:" || url.protocol === "https:") return url.origin;
    } catch {
      continue;
    }
  }
  return null;
}

function routePatternFor(events: BrowserTraceEvent[]): string | undefined {
  const event = events.find((candidate) => candidate.url);
  if (!event) return undefined;
  try {
    const parsed = new URL(event.url);
    return `${parsed.pathname || "/"}${parsed.search ? "?..." : ""}`;
  } catch {
    return undefined;
  }
}

function routeName(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname || parsed.origin;
  } catch {
    return url;
  }
}

function locatorConfidence(candidate?: LocatorCandidate): WorkflowStepContractV7["locatorPlan"]["confidence"] {
  if (!candidate) return "none";
  if (candidate.confidence >= 0.85) return "high";
  if (candidate.confidence >= 0.65) return "medium";
  return "low";
}

function slugIdentifier(value: string): string {
  const words = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return words || "input";
}

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function titleCase(value: string): string {
  const compact = compactText(value);
  if (!compact) return "Taught browser workflow";
  return compact.charAt(0).toUpperCase() + compact.slice(1);
}

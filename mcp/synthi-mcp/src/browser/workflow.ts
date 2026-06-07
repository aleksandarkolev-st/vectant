import { reduceLane0Windows, type Lane0StatusV7 } from "./lane0.js";
import { sourceIdentityRegistry } from "./source_identity.js";
import type { BrowserActionKind, BrowserElementMetadata, BrowserTraceEvent, LocatorCandidate } from "./types.js";

const RELATED_DBLCLICK_CLICK_WINDOW_MS = 1000;

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
  | "lowConfidenceLocator"
  | "iframeNeedsFrameLocator"
  | "popupOrMultiTab"
  | "canvasCoordinateOnly"
  | "closedShadowDomBlocked"
  | "pointerDragUnreliable";

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

export type WorkflowSurfaceKindV7 =
  | "dom"
  | "nativeHtmlDrag"
  | "fileDrop"
  | "clipboardDrop"
  | "pointerDrag"
  | "canvas"
  | "openShadowDom"
  | "closedShadowDom";

export type WorkflowSurfaceReplayV7 =
  | "durable"
  | "parameterized"
  | "sameSessionOnly"
  | "blocked"
  | "unsupported";

export interface WorkflowParameterV7 {
  name: string;
  label: string;
  sourceStepId: string;
  valueShape: "empty" | "shortText" | "longText" | "email" | "number" | "secret" | "filePath" | "unknown";
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
    status: "linked" | "missing" | "notRequired";
    sourceId?: string;
    workspaceId?: string;
    filePath?: string;
    line?: number;
    column?: number;
    adapter?: string;
    transformVersion?: string;
    missingReason?: "sourceTokenMissing";
  };
  semanticPlan?: {
    reducerVersion: string;
    windowId: string;
    groupId: string;
    groupLabel: string;
    confidence: "high" | "medium" | "low";
    reasons: string[];
  };
  surfacePlan: {
    kind: WorkflowSurfaceKindV7;
    replay: WorkflowSurfaceReplayV7;
    notes: string[];
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
  lane0: Lane0StatusV7;
  failureClasses: FailureClassV7[];
  replayModes: Array<"sameSession" | "prefixOnly" | "ciIsolated">;
  limitations: WorkflowLimitationV7[];
  counterfactualPlan: {
    mode: "readOnlyPrefix" | "sameSessionOnly" | "blocked";
    readOnly: boolean;
    stopsBeforeStepId?: string;
    profiles: Array<{
      name: "desktop" | "mobile" | "reducedMotion";
      enabled: boolean;
      replayMode: "sameSession" | "prefixOnly";
      reason: string;
    }>;
  };
  sourceAffordancePatches: Array<{
    stepId: string;
    targetLabel: string;
    reason: "missingSourceIdentity" | "lowConfidenceLocator" | "mutationBoundary";
    suggestedAttribute: string;
  }>;
  publishPlan: {
    privateToolName: string;
    readiness: "ready" | "manualOnly" | "blocked";
    unattendedReady: boolean;
    authDurability: AuthDurabilityV7;
    mutationMode: "readOnly" | "confirmBeforeCommit" | "ciOnly";
    runModes: Array<"sameSession" | "prefixOnly" | "confirmBeforeCommit" | "ciOnly">;
    blockers: WorkflowLimitationV7[];
    notes: string[];
  };
  generatedOutputs: Array<{
    kind: "playwright" | "sourceAffordancePatch" | "privateMcpToolManifest";
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

export type WorkflowReplayModeV7 = "sameSession" | "prefixOnly" | "coldSession";

export interface WorkflowReplayPlanV7 {
  mode: WorkflowReplayModeV7;
  status: "ready" | "stoppedAtMutationBoundary" | "blocked";
  workflowId: string;
  events: BrowserTraceEvent[];
  stoppedBeforeStepId?: string;
  warnings: string[];
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
  const lane0 = reduceLane0Windows(events);
  const ordered = lane0.events.sort((a, b) => (a.event_seq || 0) - (b.event_seq || 0));
  const actionEvents = coalesceActionEvents(
    ordered.filter((event) => event.kind === "human_action" || event.kind === "agent_action" || event.kind === "navigation")
  );
  const appOrigin = firstHttpOrigin(actionEvents) ?? firstHttpOrigin(ordered) ?? "unknown";
  const steps = actionEvents.map((event, index) => stepFromEvent(event, index + 1));
  const parameters = parametersFromSteps(steps, actionEvents);
  const mutationSteps = steps
    .filter((step) => step.mutation)
    .map((step) => ({ stepId: step.stepId, ...step.mutation! }));
  const limitations = workflowLimitations(ordered, steps, appOrigin, mutationSteps.length > 0);
  const replayBlocked = actionEvents.length === 0 || replayBlockingWarnings(limitations).length > 0;
  const linkedSteps = steps.filter((step) => step.sourcePlan.status !== "missing").length;
  const sourceStatus = linkedSteps === 0 ? "missing" : linkedSteps === steps.length ? "complete" : "partial";
  const firstMutationStepId = mutationSteps[0]?.stepId;
  const name = workflowName(steps);
  const authPlan = authPlanFor(actionEvents);
  const replayModes: WorkflowContractV7["replayModes"] = replayBlocked
    ? []
    : mutationSteps.length > 0 ? ["sameSession", "prefixOnly"] : ["sameSession"];
  const sourceAffordancePatches = sourceAffordancePatchesFor(steps);
  const publishPlan = publishPlanFor(name, limitations, mutationSteps.length > 0, actionEvents.length, authPlan);
  const contract: WorkflowContractV7 = {
    workflowId: workflowIdFor(appOrigin, steps),
    name,
    description: steps.length > 0 ? `${name} compiled from ${steps.length} taught browser steps.` : "No actionable taught steps were recorded.",
    appOrigin,
    routePattern: routePatternFor(actionEvents),
    authPlan,
    mutationBoundaryPlan: {
      ...(firstMutationStepId ? { firstMutationStepId } : {}),
      mutationSteps,
      defaultReplayMode: replayBlocked ? "blocked" : mutationSteps.length > 0 ? "prefixOnly" : "sameSession",
    },
    sourceIdentityCoverage: {
      linkedSteps,
      totalSteps: steps.length,
      status: sourceStatus,
    },
    parameters,
    steps,
    successCriteria: successCriteriaFor(steps),
    lane0: lane0.status,
    failureClasses: failureClassesFor(limitations, mutationSteps.length > 0, authPlan),
    replayModes,
    limitations,
    counterfactualPlan: counterfactualPlanFor(firstMutationStepId, steps.length, limitations),
    sourceAffordancePatches,
    publishPlan,
    generatedOutputs: [
      {
        kind: "playwright",
        status: replayBlocked ? "blocked" : "available",
        notes: replayBlocked
          ? replayBlockingWarnings(limitations)
          : mutationSteps.length > 0
          ? ["Generated Playwright should stop at the first mutation boundary for background hardening."]
          : ["Generated Playwright can run in the current same-session context."],
      },
      {
        kind: "sourceAffordancePatch",
        status: steps.length > 0 ? "available" : "blocked",
        notes: sourceAffordancePatches.length > 0
          ? ["Suggested source affordances target unstable or source-unlinked steps. No exact file path is required from the user."]
          : ["No source affordance suggestions are needed for this trace."],
      },
      {
        kind: "privateMcpToolManifest",
        status: publishPlan.readiness === "blocked" ? "blocked" : "available",
        notes: publishPlan.notes,
      },
    ],
  };
  return {
    contract,
    card: cardForContract(contract),
  };
}

function coalesceActionEvents(events: BrowserTraceEvent[]): BrowserTraceEvent[] {
  const result: BrowserTraceEvent[] = [];
  for (const event of events) {
    const previous = result[result.length - 1];
    if (previous && shouldDropClickAfterDblClick(previous, event)) {
      continue;
    }
    if (previous && shouldReplaceWithLatestFill(previous, event)) {
      result[result.length - 1] = event;
      continue;
    }
    while (event.action === "dblclick" && result.length > 0) {
      const prior = result[result.length - 1];
      if (!prior || !shouldDropClickBeforeDblClick(prior, event)) break;
      result.pop();
    }
    result.push(event);
  }
  return result;
}

function shouldReplaceWithLatestFill(previous: BrowserTraceEvent, next: BrowserTraceEvent): boolean {
  if (previous.kind !== next.kind) return false;
  if (previous.action !== "fill" || next.action !== "fill") return false;
  if (previous.tab_id !== next.tab_id || previous.origin !== next.origin) return false;
  const previousTarget = fillTargetKey(previous);
  const nextTarget = fillTargetKey(next);
  return previousTarget.length > 0 && previousTarget === nextTarget;
}

function fillTargetKey(event: BrowserTraceEvent): string {
  const element = elementForEvent(event);
  return [
    event.selector,
    event.locator_candidates?.[0]?.locator,
    stringDetail(event, "field_name"),
    element?.source_id,
    element?.test_id,
    element?.id,
    element?.label,
    element?.placeholder,
    element?.name,
    element?.css,
    element?.xpath,
  ].filter((part): part is string => typeof part === "string" && part.length > 0).join("|");
}

function shouldDropClickBeforeDblClick(previous: BrowserTraceEvent, next: BrowserTraceEvent): boolean {
  if (previous.kind !== next.kind) return false;
  if (previous.action !== "click" || next.action !== "dblclick") return false;
  if (previous.tab_id !== next.tab_id || previous.origin !== next.origin) return false;
  const previousTarget = actionTargetKey(previous);
  const nextTarget = actionTargetKey(next);
  return previousTarget.length > 0 && previousTarget === nextTarget;
}

function shouldDropClickAfterDblClick(previous: BrowserTraceEvent, next: BrowserTraceEvent): boolean {
  if (previous.kind !== next.kind) return false;
  if (previous.action !== "dblclick" || next.action !== "click") return false;
  if (previous.tab_id !== next.tab_id || previous.origin !== next.origin) return false;
  if (!isRelatedDblClickNoise(previous, next)) return false;
  const previousTarget = actionTargetKey(previous);
  const nextTarget = actionTargetKey(next);
  return previousTarget.length > 0 && previousTarget === nextTarget;
}

function isRelatedDblClickNoise(dblclick: BrowserTraceEvent, click: BrowserTraceEvent): boolean {
  if (dblclick.detail?.["dblclick_event"] !== true || click.detail?.["click_event"] !== true) return false;
  const elapsedMs = Math.abs((click.ts || 0) - (dblclick.ts || 0));
  return elapsedMs <= RELATED_DBLCLICK_CLICK_WINDOW_MS;
}

function actionTargetKey(event: BrowserTraceEvent): string {
  const element = elementForEvent(event);
  return [
    event.selector,
    event.locator_candidates?.[0]?.locator,
    element?.source_id,
    element?.test_id,
    element?.id,
    element?.label,
    element?.placeholder,
    element?.name,
    element?.text,
    element?.css,
    element?.xpath,
  ].filter((part): part is string => typeof part === "string" && part.length > 0).join("|");
}

function stringDetail(event: BrowserTraceEvent, key: string): string | undefined {
  const value = event.detail?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numericDetail(event: BrowserTraceEvent, key: string): number | undefined {
  const value = event.detail?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function counterfactualPlanFor(
  firstMutationStepId: string | undefined,
  stepCount: number,
  limitations: WorkflowLimitationV7[]
): WorkflowContractV7["counterfactualPlan"] {
  if (stepCount === 0 || replayBlockingWarnings(limitations).length > 0) {
    return {
      mode: "blocked",
      readOnly: true,
      profiles: [],
    };
  }
  if (firstMutationStepId) {
    return {
      mode: "readOnlyPrefix",
      readOnly: true,
      stopsBeforeStepId: firstMutationStepId,
      profiles: [
        { name: "desktop", enabled: true, replayMode: "prefixOnly", reason: "Stops before mutation boundary." },
        { name: "mobile", enabled: false, replayMode: "prefixOnly", reason: "Mobile counterfactual requires source identity or visual bridge coverage." },
        { name: "reducedMotion", enabled: true, replayMode: "prefixOnly", reason: "Verifies reachable controls without committing state." },
      ],
    };
  }
  return {
    mode: "sameSessionOnly",
    readOnly: true,
    profiles: [
      { name: "desktop", enabled: true, replayMode: "sameSession", reason: "No mutation boundary was detected." },
      {
        name: "mobile",
        enabled: !limitations.includes("canvasCoordinateOnly") && !limitations.includes("pointerDragUnreliable"),
        replayMode: "sameSession",
        reason: limitations.includes("canvasCoordinateOnly") || limitations.includes("pointerDragUnreliable")
          ? "Mobile counterfactual is skipped for coordinate or pointer-drag replay limitations."
          : "No coordinate-only limitation was detected.",
      },
      { name: "reducedMotion", enabled: true, replayMode: "sameSession", reason: "No mutation boundary was detected." },
    ],
  };
}

function sourceAffordancePatchesFor(steps: WorkflowStepContractV7[]): WorkflowContractV7["sourceAffordancePatches"] {
  const patches: WorkflowContractV7["sourceAffordancePatches"] = [];
  for (const step of steps) {
    const targetLabel = step.action.target?.label ?? step.label;
    if (step.sourcePlan.status === "missing") {
      patches.push({
        stepId: step.stepId,
        targetLabel,
        reason: "missingSourceIdentity",
        suggestedAttribute: `data-synthi-affordance="${affordanceName(targetLabel)}"`,
      });
    } else if (step.locatorPlan.confidence === "low") {
      patches.push({
        stepId: step.stepId,
        targetLabel,
        reason: "lowConfidenceLocator",
        suggestedAttribute: `data-testid="${affordanceName(targetLabel)}"`,
      });
    }
    if (step.mutation) {
      patches.push({
        stepId: step.stepId,
        targetLabel,
        reason: "mutationBoundary",
        suggestedAttribute: `data-synthi-mutation-boundary="${affordanceName(targetLabel)}"`,
      });
    }
  }
  return patches;
}

function publishPlanFor(
  workflowNameValue: string,
  limitations: WorkflowLimitationV7[],
  hasMutation: boolean,
  actionCount: number,
  authPlan: WorkflowContractV7["authPlan"]
): WorkflowContractV7["publishPlan"] {
  const hardBlockers = limitations.filter((limitation) =>
    limitation === "unresolvedStep" ||
    limitation === "iframeNeedsFrameLocator" ||
    limitation === "popupOrMultiTab" ||
    limitation === "closedShadowDomBlocked"
  );
  if (actionCount === 0 && !hardBlockers.includes("unresolvedStep")) hardBlockers.push("unresolvedStep");

  const softBlockers = limitations.filter((limitation) =>
    limitation === "sourceIdentityMissing" ||
    limitation === "lowConfidenceLocator" ||
    limitation === "canvasCoordinateOnly" ||
    limitation === "pointerDragUnreliable" ||
    limitation === "redactedInputValue" ||
    limitation === "mutationRequiresIsolation"
  );
  const mutationMode = hasMutation ? "confirmBeforeCommit" : "readOnly";
  const checkpointOnlyAuth = authPlan.required && !authDurabilityAllowsUnattended(authPlan.durability);
  const readiness = hardBlockers.length > 0
    ? "blocked"
    : hasMutation || softBlockers.length > 0 || checkpointOnlyAuth ? "manualOnly" : "ready";
  const unattendedReady = readiness === "ready" && authDurabilityAllowsUnattended(authPlan.durability);
  const runModes: WorkflowContractV7["publishPlan"]["runModes"] = hasMutation
    ? ["prefixOnly", "confirmBeforeCommit", "ciOnly"]
    : ["sameSession"];
  return {
    privateToolName: `synthi_app_${slugIdentifier(workflowNameValue)}`,
    readiness,
    unattendedReady,
    authDurability: authPlan.durability,
    mutationMode,
    runModes,
    blockers: [...new Set([...hardBlockers, ...softBlockers])],
    notes: publishNotesFor(readiness, unattendedReady, hasMutation, hardBlockers, softBlockers, authPlan),
  };
}

function publishNotesFor(
  readiness: WorkflowContractV7["publishPlan"]["readiness"],
  unattendedReady: boolean,
  hasMutation: boolean,
  hardBlockers: WorkflowLimitationV7[],
  softBlockers: WorkflowLimitationV7[],
  authPlan: WorkflowContractV7["authPlan"]
): string[] {
  if (readiness === "blocked") {
    return [
      `Private MCP tool manifest is blocked by ${hardBlockers.join(", ")}.`,
      "Review unresolved steps or unsupported browser surfaces before publishing.",
    ];
  }
  const notes: string[] = [];
  if (hasMutation) {
    notes.push("Generated private MCP tool must default to confirmBeforeCommit or ciOnly for mutation steps.");
  }
  if (softBlockers.length > 0) {
    notes.push(`Manual-only until limitations are resolved: ${softBlockers.join(", ")}.`);
  }
  if (authPlan.required && !authDurabilityAllowsUnattended(authPlan.durability)) {
    notes.push("This workflow can run while the saved login checkpoint is valid. It is not configured for unattended background runs.");
  }
  if (!unattendedReady) {
    notes.push("Do not mark this tool unattended durable without refreshProvider or ciTestAuth when auth is required.");
  } else {
    notes.push("Private MCP tool manifest can be generated for read-only unattended use.");
  }
  return notes;
}

function authPlanFor(events: BrowserTraceEvent[]): WorkflowContractV7["authPlan"] {
  const explicitDurability = events
    .map((event) => authDurabilityFromDetail(event.detail?.["auth_durability"]))
    .find((durability): durability is AuthDurabilityV7 => durability !== null);
  if (explicitDurability) {
    return {
      durability: explicitDurability,
      required: explicitDurability !== "noneRequired",
      notes: explicitDurability === "noneRequired"
        ? ["Trace explicitly marked this workflow as not requiring auth."]
        : [`Trace explicitly marked auth durability as ${explicitDurability}.`],
    };
  }
  if (events.some((event) => event.security?.auth_checkpoint_approved === true)) {
    return {
      durability: "interactiveCheckpoint",
      required: true,
      notes: ["Trace was recorded with a broker-approved auth checkpoint. Auth values remain broker-only."],
    };
  }
  return {
    durability: "noneRequired",
    required: false,
    notes: ["No auth checkpoint was detected in this trace."],
  };
}

function authDurabilityFromDetail(value: unknown): AuthDurabilityV7 | null {
  if (
    value === "noneRequired" ||
    value === "interactiveCheckpoint" ||
    value === "idpCheckpoint" ||
    value === "refreshProvider" ||
    value === "ciTestAuth"
  ) {
    return value;
  }
  return null;
}

function authDurabilityAllowsUnattended(durability: AuthDurabilityV7): boolean {
  return durability === "noneRequired" || durability === "refreshProvider" || durability === "ciTestAuth";
}

function affordanceName(value: string): string {
  return slugIdentifier(value).replace(/_/g, ".");
}

export function planWorkflowReplay(events: BrowserTraceEvent[], mode: WorkflowReplayModeV7 = "sameSession"): WorkflowReplayPlanV7 {
  const workflow = compileWorkflowContract(events);
  const ordered = coalesceActionEvents([...events]
    .sort((a, b) => (a.event_seq || 0) - (b.event_seq || 0))
    .filter((event) => event.kind === "human_action" || event.kind === "agent_action" || event.kind === "navigation"));
  const firstMutationStepId = workflow.contract.mutationBoundaryPlan.firstMutationStepId;
  if (ordered.length === 0) {
    return {
      mode,
      status: "blocked",
      workflowId: workflow.contract.workflowId,
      events: [],
      warnings: ["No actionable taught steps were recorded."],
    };
  }
  const blockedWarnings = replayBlockingWarnings(workflow.contract.limitations);
  if (blockedWarnings.length > 0) {
    return {
      mode,
      status: "blocked",
      workflowId: workflow.contract.workflowId,
      events: [],
      warnings: blockedWarnings,
    };
  }
  if ((mode === "prefixOnly" || mode === "coldSession") && firstMutationStepId) {
    return {
      mode,
      status: "stoppedAtMutationBoundary",
      workflowId: workflow.contract.workflowId,
      events: ordered.filter((event) => event.event_id !== firstMutationStepId && event.event_seq < (workflow.contract.steps.find((step) => step.stepId === firstMutationStepId)?.eventSeq ?? Number.MAX_SAFE_INTEGER)),
      stoppedBeforeStepId: firstMutationStepId,
      warnings: [mode === "coldSession" ? "Cold-session replay starts from a fresh browser context and stops before the first mutation boundary." : "Prefix replay stops before the first mutation boundary."],
    };
  }
  return {
    mode,
    status: "ready",
    workflowId: workflow.contract.workflowId,
    events: ordered,
    warnings: mode === "coldSession"
      ? ["Cold-session replay starts from a fresh browser context."]
      : workflow.contract.mutationBoundaryPlan.mutationSteps.length > 0
      ? ["Same-session replay includes mutation steps and must not be used for background hardening."]
      : [],
  };
}

export function classifyWorkflowReplayBlock(plan: Pick<WorkflowReplayPlanV7, "warnings">): FailureClassV7 {
  const message = plan.warnings.join(" ");
  if (/closed shadow/i.test(message)) return "closedShadowDomBlocked";
  if (/canvas/i.test(message)) return "canvasUnreliable";
  if (/pointer.*drag|sensor.*drag/i.test(message)) return "pointerDragUnreliable";
  if (/mutation/i.test(message)) return "mutationBlocked";
  if (/iframe|frame locator/i.test(message)) return "locatorDrift";
  if (/popup|multi-tab/i.test(message)) return "unsafeEnvironment";
  return "unknown";
}

export function classifyWorkflowReplayFailure(error: unknown, event?: BrowserTraceEvent): FailureClassV7 {
  const message = error instanceof Error ? error.message : String(error);
  if (/auth.*expired|expired.*auth|checkpoint.*expired/i.test(message)) return "authExpired";
  if (/auth|login|unauthorized|forbidden|checkpoint/i.test(message)) return "authMissing";
  if (/mutation.*blocked|mutation boundary|unsafe mutation/i.test(message)) return "mutationBlocked";
  if (/closed shadow/i.test(message)) return "closedShadowDomBlocked";
  if (/canvas/i.test(message)) return "canvasUnreliable";
  if (/pointer drag|pointer-drag/i.test(message)) return "pointerDragUnreliable";
  if (event?.action === "navigate" && /timeout|waiting|url|navigation/i.test(message)) return "routeChanged";
  if (/net::|ERR_|network/i.test(message)) return "networkFailure";
  if (/navigation|url/i.test(message)) return "routeChanged";
  if (/hydration|hydrate|not ready|not mounted/i.test(message)) return "hydrationDelay";
  if (/timeout|waiting|visible|locator|selector|strict mode|No locator/i.test(message)) return "locatorDrift";
  if (event?.action === "navigate") return "routeChanged";
  return "unknown";
}

export function normalizeReplayMode(value: unknown): WorkflowReplayModeV7 {
  if (value === "coldSession") return "coldSession";
  return value === "prefixOnly" ? "prefixOnly" : "sameSession";
}

function stepFromEvent(event: BrowserTraceEvent, ordinal: number): WorkflowStepContractV7 {
  const element = elementForEvent(event);
  const targetLabel = targetLabelFor(event, element);
  const primary = event.locator_candidates?.[0];
  const fallbacks = event.locator_candidates?.slice(1) ?? [];
  const confidence = locatorConfidence(primary);
  const actionKind = event.kind === "navigation" ? "navigate" : event.action ?? "wait";
  const stepId = event.event_id || `step_${ordinal}`;
  const parameterName = parameterNameForAction(event, element, ordinal, actionKind);
  const mutation = mutationFor(actionKind, targetLabel, event);
  const surfacePlan = surfacePlanFor(event, actionKind);
  const sourcePlan = actionKind === "navigate" ? { status: "notRequired" as const } : sourcePlanFor(element);
  const limitations: WorkflowLimitationV7[] = [];
  if (sourcePlan.status === "missing") limitations.push("sourceIdentityMissing");
  if (!primary && actionKind !== "navigate") limitations.push("unresolvedStep");
  if (primary && primary.confidence < 0.7) limitations.push("lowConfidenceLocator");
  if (event.redacted) limitations.push("redactedInputValue");
  if (mutation) limitations.push("mutationRequiresIsolation");
  if (eventNeedsFrameLocator(event)) limitations.push("iframeNeedsFrameLocator");
  if (eventIsCanvasCoordinateOnly(event)) limitations.push("canvasCoordinateOnly");
  if (eventIsClosedShadowDomBlocked(event)) limitations.push("closedShadowDomBlocked");
  if (eventIsPointerDrag(event)) limitations.push("pointerDragUnreliable");
  return {
    stepId,
    eventSeq: event.event_seq,
    label: labelForAction(actionKind, targetLabel),
    intent: event.semantic?.intent ?? intentForAction(actionKind, targetLabel),
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
    sourcePlan,
    ...(event.semantic ? {
      semanticPlan: {
        reducerVersion: event.semantic.reducer_version,
        windowId: event.semantic.window_id,
        groupId: event.semantic.group_id,
        groupLabel: event.semantic.group_label,
        confidence: event.semantic.confidence,
        reasons: event.semantic.reasons,
      },
    } : {}),
    surfacePlan,
    expectedEffects: expectedEffectsFor(actionKind, targetLabel, mutation !== undefined),
    ...(mutation ? { mutation } : {}),
    limitations,
  };
}

function sourcePlanFor(element?: BrowserElementMetadata): WorkflowStepContractV7["sourcePlan"] {
  const sourceId = element?.source_id;
  if (!sourceId) return { status: "missing" };
  const resolved = sourceIdentityRegistry.lookup(sourceId);
  if (!resolved) {
    return {
      status: "missing",
      sourceId,
      missingReason: "sourceTokenMissing",
    };
  }
  return {
    status: "linked",
    sourceId,
    workspaceId: resolved.workspace_id,
    filePath: resolved.filePath,
    line: resolved.line,
    column: resolved.column,
    adapter: resolved.adapter,
    transformVersion: resolved.transform_version,
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
    case "dblclick":
      return `Double-click ${targetLabel}`;
    case "contextmenu":
      return `Open context menu for ${targetLabel}`;
    case "hover":
      return `Hover over ${targetLabel}`;
    case "drag":
      return `Drag ${targetLabel}`;
    case "scroll":
      return `Scroll ${targetLabel}`;
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
    case "dblclick":
      return `Activate ${targetLabel} with double-click`;
    case "contextmenu":
      return `Open contextual actions for ${targetLabel}`;
    case "hover":
      return `Reveal or inspect ${targetLabel}`;
    case "drag":
      return `Move ${targetLabel} with explicit drag mode`;
    case "scroll":
      return `Restore ${targetLabel} scroll position`;
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
  if (action === "hover") return [`${targetLabel} reveal state is visible.`];
  if (action === "contextmenu") return [`${targetLabel} contextual actions are visible.`];
  if (action === "drag") return [`${targetLabel} drag target remains reachable.`];
  if (action === "scroll") return [`${targetLabel} scroll position is restored.`];
  if (action === "navigate") return [`The browser reaches ${targetLabel}.`];
  return [`${targetLabel} remains visible and actionable.`];
}

function mutationFor(
  action: BrowserActionKind,
  targetLabel: string,
  event: BrowserTraceEvent
): WorkflowStepContractV7["mutation"] | undefined {
  if (action !== "click" && action !== "dblclick" && action !== "press" && action !== "select") return undefined;
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
      valueShape: parameterValueShape(event),
      required: true,
      redacted: event?.redacted === true,
    }];
  });
}

function parameterNameForAction(
  event: BrowserTraceEvent,
  element: BrowserElementMetadata | undefined,
  ordinal: number,
  actionKind: BrowserActionKind
): string | undefined {
  if (actionKind === "fill" || actionKind === "select") {
    return event.semantic?.parameter_name ?? parameterNameFor(event, element, ordinal);
  }
  if (actionKind === "drag" && dragClassFor(event) === "filedrop") {
    const explicit = typeof event.detail?.["file_parameter"] === "string"
      ? event.detail["file_parameter"] as string
      : typeof event.detail?.["file_env"] === "string"
        ? event.detail["file_env"] as string
        : undefined;
    return slugIdentifier(explicit || element?.label || element?.name || element?.test_id || `file_${ordinal}`);
  }
  return undefined;
}

function parameterNameFor(event: BrowserTraceEvent, element: BrowserElementMetadata | undefined, ordinal: number): string {
  const explicit = typeof event.detail?.["field_name"] === "string" ? event.detail["field_name"] as string : undefined;
  const base = explicit || element?.label || element?.name || element?.placeholder || element?.test_id || `input_${ordinal}`;
  return slugIdentifier(base);
}

function parameterValueShape(event: BrowserTraceEvent | undefined): WorkflowParameterV7["valueShape"] {
  if (event?.action === "drag" && dragClassFor(event) === "filedrop") return "filePath";
  return valueShape(event?.value, event?.redacted === true);
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
  if (steps.some((step) => step.action.kind !== "navigate" && step.locatorPlan.confidence === "none")) limitations.add("unresolvedStep");
  if (steps.some((step) => step.locatorPlan.confidence === "low")) limitations.add("lowConfidenceLocator");
  if (steps.some((step) => step.limitations.includes("redactedInputValue"))) limitations.add("redactedInputValue");
  if (steps.some((step) => step.limitations.includes("iframeNeedsFrameLocator"))) limitations.add("iframeNeedsFrameLocator");
  if (steps.some((step) => step.limitations.includes("canvasCoordinateOnly"))) limitations.add("canvasCoordinateOnly");
  if (steps.some((step) => step.limitations.includes("closedShadowDomBlocked"))) limitations.add("closedShadowDomBlocked");
  if (steps.some((step) => step.limitations.includes("pointerDragUnreliable"))) limitations.add("pointerDragUnreliable");
  if (hasMutation) limitations.add("mutationRequiresIsolation");
  if (events.some((event) => event.origin && appOrigin !== "unknown" && event.origin !== appOrigin)) limitations.add("crossOriginTrace");
  const actionTabIds = new Set(events
    .filter((event) => event.kind === "human_action" || event.kind === "agent_action" || event.kind === "navigation")
    .map((event) => event.tab_id)
    .filter(Boolean));
  if (actionTabIds.size > 1 || events.some((event) => event.detail?.["surface"] === "popup")) limitations.add("popupOrMultiTab");
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

function failureClassesFor(
  limitations: WorkflowLimitationV7[],
  hasMutation: boolean,
  authPlan: WorkflowContractV7["authPlan"]
): FailureClassV7[] {
  const classes = new Set<FailureClassV7>(["locatorDrift", "hydrationDelay", "routeChanged", "networkFailure", "unknown"]);
  if (authPlan.required || authPlan.durability !== "noneRequired") {
    classes.add("authMissing");
    classes.add("authExpired");
  }
  if (limitations.includes("sourceIdentityMissing")) classes.add("sourceIdentityMissing");
  if (limitations.includes("unresolvedStep")) classes.add("testDataMissing");
  if (limitations.includes("canvasCoordinateOnly")) classes.add("canvasUnreliable");
  if (limitations.includes("closedShadowDomBlocked")) classes.add("closedShadowDomBlocked");
  if (limitations.includes("pointerDragUnreliable")) classes.add("pointerDragUnreliable");
  if (limitations.includes("popupOrMultiTab")) classes.add("unsafeEnvironment");
  if (hasMutation) {
    classes.add("mutationBlocked");
    classes.add("unsafeEnvironment");
  }
  return [...classes];
}

function cardForContract(contract: WorkflowContractV7): WorkflowCardV7 {
  const state: WorkflowStateV7[] = ["Draft"];
  if (contract.mutationBoundaryPlan.defaultReplayMode === "blocked") state.push("Blocked");
  else if (contract.steps.length > 0) state.push("Runnable");
  if (!contract.authPlan.required || contract.authPlan.durability !== "noneRequired") state.push("Auth-ready");
  if (contract.sourceIdentityCoverage.status !== "missing") state.push("Source-linked");
  if (contract.mutationBoundaryPlan.mutationSteps.length > 0) state.push("Mutation-limited");
  if (contract.limitations.length > 0) state.push("Limited");
  const unresolvedCount = contract.steps.filter((step) => step.limitations.includes("unresolvedStep")).length;
  return {
    title: contract.name,
    status: contract.steps.length > 0
      ? contract.mutationBoundaryPlan.defaultReplayMode === "blocked"
        ? "Blocked. Review unsupported replay surfaces before validation."
        : contract.mutationBoundaryPlan.mutationSteps.length > 0
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
    primaryCta: contract.steps.length === 0 || contract.mutationBoundaryPlan.defaultReplayMode === "blocked"
      ? "blocked"
      : unresolvedCount > 0 ? "reviewLimitations" : "validateSameSession",
  };
}

function replayBlockingWarnings(limitations: WorkflowLimitationV7[]): string[] {
  const warnings: string[] = [];
  if (limitations.includes("iframeNeedsFrameLocator")) {
    warnings.push("Replay blocked: iframe step has no durable frame locator.");
  }
  if (limitations.includes("popupOrMultiTab")) {
    warnings.push("Replay blocked: popup or multi-tab workflows are not supported by the current same-tab runner.");
  }
  if (limitations.includes("closedShadowDomBlocked")) {
    warnings.push("Replay blocked: closed Shadow DOM requires a dev-only bridge or external affordance.");
  }
  if (limitations.includes("canvasCoordinateOnly")) {
    warnings.push("Replay blocked: coordinate-only canvas/WebGL actions require a semantic app bridge.");
  }
  if (limitations.includes("pointerDragUnreliable")) {
    warnings.push("Replay blocked: pointer or sensor-based drag requires calibrated replay support.");
  }
  return warnings;
}

function eventNeedsFrameLocator(event: BrowserTraceEvent): boolean {
  return Boolean(event.frame_id) && typeof event.detail?.["frame_locator"] !== "string";
}

function eventIsCanvasCoordinateOnly(event: BrowserTraceEvent): boolean {
  return isCanvasSurface(event) && !hasSemanticCanvasBridge(event);
}

function eventIsClosedShadowDomBlocked(event: BrowserTraceEvent): boolean {
  const surface = surfaceLabel(event);
  const closed = /closedshadow|closed-shadow/.test(surface) ||
    event.detail?.["closed_shadow_dom"] === true ||
    event.detail?.["shadow_dom"] === "closed";
  return closed && !hasClosedShadowBridge(event);
}

function eventIsPointerDrag(event: BrowserTraceEvent): boolean {
  if (eventHasCalibratedPointerReplay(event)) return false;
  const dragClass = dragClassFor(event);
  if (event.action === "drag" && dragClass !== "nativehtmldnd" && dragClass !== "filedrop" && dragClass !== "clipboarddrop") return true;
  return /pointersensor|unknowndrag|canvasdrag/.test(dragClass) ||
    event.detail?.["pointer_drag"] === true;
}

function eventHasCalibratedPointerReplay(event: BrowserTraceEvent): boolean {
  if (event.action !== "drag") return false;
  const dragClass = dragClassFor(event);
  const isPointerClass = /pointersensor|pointerdrag|unknowndrag/.test(dragClass) || event.detail?.["pointer_drag"] === true;
  if (!isPointerClass) return false;
  if (event.detail?.["pointer_replay"] !== "calibrated" && event.detail?.["pointer_calibrated"] !== true) return false;
  if (typeof event.detail?.["drop_locator"] !== "string" && typeof event.value !== "string") return false;
  return numericDetail(event, "pointer_start_x_ratio") !== undefined &&
    numericDetail(event, "pointer_start_y_ratio") !== undefined &&
    numericDetail(event, "pointer_end_x_ratio") !== undefined &&
    numericDetail(event, "pointer_end_y_ratio") !== undefined;
}

function surfacePlanFor(event: BrowserTraceEvent, action: BrowserActionKind): WorkflowStepContractV7["surfacePlan"] {
  const dragClass = dragClassFor(event);
  if (eventIsClosedShadowDomBlocked(event)) {
    return {
      kind: "closedShadowDom",
      replay: "blocked",
      notes: ["Closed Shadow DOM is blocked unless the app exposes a dev-only bridge or durable external affordance."],
    };
  }
  if (hasClosedShadowBridge(event)) {
    return {
      kind: "closedShadowDom",
      replay: "sameSessionOnly",
      notes: ["Closed Shadow DOM is reachable through an explicit dev bridge; do not publish it as generic browser automation."],
    };
  }
  if (event.detail?.["shadow_dom"] === "open") {
    return {
      kind: "openShadowDom",
      replay: "durable",
      notes: ["Open Shadow DOM can use normal Playwright locator piercing where the locator remains stable."],
    };
  }
  if (eventIsCanvasCoordinateOnly(event)) {
    return {
      kind: "canvas",
      replay: "unsupported",
      notes: ["Canvas/WebGL action is coordinate-only and is not durable without a semantic app bridge."],
    };
  }
  if (isCanvasSurface(event)) {
    const mode = String(event.detail?.["canvas_replay_mode"] ?? event.detail?.["canvasReplayMode"] ?? "").toLowerCase();
    return {
      kind: "canvas",
      replay: mode === "vlmlocatethenclick" ? "sameSessionOnly" : "durable",
      notes: mode === "vlmlocatethenclick"
        ? ["Canvas replay uses an optional VLM locate-then-click adapter and should remain review-gated."]
        : ["Canvas replay is backed by an explicit semantic app bridge."],
    };
  }
  if (action === "drag") {
    if (eventHasCalibratedPointerReplay(event)) {
      return {
        kind: "pointerDrag",
        replay: "sameSessionOnly",
        notes: ["Pointer-sensor drag has calibrated source/drop locators and relative replay points for same-session validation."],
      };
    }
    if (dragClass === "nativehtmldnd") {
      return {
        kind: "nativeHtmlDrag",
        replay: typeof event.detail?.["drop_locator"] === "string" || typeof event.value === "string" ? "durable" : "sameSessionOnly",
        notes: ["Native HTML drag-and-drop can use Playwright dragTo when a durable drop target locator is recorded."],
      };
    }
    if (dragClass === "filedrop") {
      return {
        kind: "fileDrop",
        replay: "parameterized",
        notes: ["File drop replay requires a caller-provided file path or declared fixture; generated code must not invent file contents."],
      };
    }
    if (dragClass === "clipboarddrop") {
      return {
        kind: "clipboardDrop",
        replay: "parameterized",
        notes: ["Clipboard drop replay requires caller-provided clipboard data and is review-gated."],
      };
    }
    return {
      kind: "pointerDrag",
      replay: "blocked",
      notes: ["Pointer-sensor drag is not high-confidence without calibration."],
    };
  }
  const editorStrategy = editorReplayStrategyFor(event);
  if (editorStrategy) {
    return {
      kind: "dom",
      replay: editorStrategy === "keyboardInsert" ? "sameSessionOnly" : "durable",
      notes: [editorStrategy === "keyboardInsert"
        ? "Code-editor surface uses focus and keyboard insertion because the durable target is not a standard form control."
        : "Code-editor surface is backed by a standard fillable browser control."],
    };
  }
  return {
    kind: "dom",
    replay: "durable",
    notes: ["Ordinary DOM interaction with broker-ranked locators."],
  };
}

function isCanvasSurface(event: BrowserTraceEvent): boolean {
  const element = elementForEvent(event);
  const surface = surfaceLabel(event);
  return element?.tag?.toLowerCase() === "canvas" ||
    /canvas|webgl/.test(surface) ||
    event.detail?.["canvas"] === true;
}

function hasSemanticCanvasBridge(event: BrowserTraceEvent): boolean {
  const mode = String(event.detail?.["canvas_replay_mode"] ?? event.detail?.["canvasReplayMode"] ?? "").toLowerCase();
  return event.detail?.["semantic_bridge"] === true ||
    event.detail?.["app_affordance_bridge"] === true ||
    mode === "semanticbridge";
}

function hasClosedShadowBridge(event: BrowserTraceEvent): boolean {
  return event.detail?.["dev_shadow_bridge"] === true ||
    event.detail?.["shadow_bridge"] === "dev" ||
    event.detail?.["closed_shadow_bridge"] === true;
}

function dragClassFor(event: BrowserTraceEvent): string {
  return String(event.detail?.["drag_class"] ?? event.detail?.["dragClass"] ?? "").toLowerCase();
}

function surfaceLabel(event: BrowserTraceEvent): string {
  return String(
    event.detail?.["surface"] ??
    event.detail?.["interaction_surface"] ??
    event.detail?.["visual_surface"] ??
    event.detail?.["surface_class"] ??
    ""
  ).toLowerCase();
}

function editorReplayStrategyFor(event: BrowserTraceEvent): string {
  const detailStrategy = event.detail?.["editor_replay_strategy"];
  if (typeof detailStrategy === "string" && detailStrategy.length > 0) return detailStrategy;
  const element = elementForEvent(event);
  return element?.editor_replay_strategy ?? "";
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

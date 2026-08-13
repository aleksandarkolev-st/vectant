import {
  TOOL_METADATA_CATALOG,
  type ToolMetadataCatalog,
  type VectantToolMetadata,
} from "./tool_metadata_catalog.js";

/**
 * A schema-free planning boundary for atomic Vectant work.
 *
 * This module intentionally consumes only `VectantToolMetadata`: tool names,
 * groups, and keywords. It does not import registration code, tool schemas, or
 * handlers, so callers can use it before deciding which small set of tools to
 * expose to an execution agent.
 */

export const VECTANT_ROUTING_ROLES = [
  "implementation",
  "debugging",
  "infrastructure",
  "data",
  "security",
  "research",
  "validation",
] as const;

export type VectantRoutingRole = (typeof VECTANT_ROUTING_ROLES)[number];
export type AtomicTaskRisk = "low" | "medium" | "high" | "critical";
export type AtomicValidationOverride = "required" | "not-required";

/** Minimal task data that is safe and sufficient for metadata-only routing. */
export interface AtomicTaskMetadata {
  readonly id?: string;
  readonly description: string;
  readonly category?: string;
  readonly keywords?: readonly string[];
  /** Exact tool names are an optional caller-controlled narrow prefilter. */
  readonly toolNames?: readonly string[];
  readonly risk?: AtomicTaskRisk;
  readonly validation?: AtomicValidationOverride;
  /** Explicitly marks a local, mechanical operation as not needing routing. */
  readonly fastPath?: boolean;
}

/**
 * A role policy is deliberately metadata-only. Applications can inject their
 * own cost/capability policy without coupling routing to a model provider.
 */
export interface VectantAgentPolicy {
  readonly role: VectantRoutingRole;
  readonly cost: number;
  readonly groups?: readonly string[];
  readonly keywords?: readonly string[];
  readonly categories?: readonly string[];
  /** Used only if no specialized policy is capable. */
  readonly fallback?: boolean;
}

export interface AtomicTaskRouterOptions {
  /** Defaults to every action advertised by the Synthi/Vectant MCP. */
  readonly catalog?: ToolMetadataCatalog;
  /** Cost-ordered capability policies; useful to inject in tests or hosts. */
  readonly agentPolicies?: readonly VectantAgentPolicy[];
  /** Limits the narrow tool subset exposed to an execution agent. Defaults to 3. */
  readonly maxTools?: number;
  /** Allows a host to add mechanical fast-path rules without changing routing. */
  readonly isFastPath?: (task: Readonly<AtomicTaskMetadata>) => boolean;
}

export interface RoutedVectantTool {
  readonly name: string;
  readonly groups: readonly string[];
  readonly keywords: readonly string[];
  readonly origin: VectantToolMetadata["origin"];
}

export interface AtomicTaskValidationDecision {
  readonly required: boolean;
  readonly role: "validation" | null;
  readonly mode: "independent" | "not-required";
  readonly reason: string;
}

export type AtomicTaskRouteTrace =
  | {
    readonly stage: "atomic-task";
    readonly taskId: string;
    readonly category: string | null;
  }
  | {
    readonly stage: "fast-path";
    readonly reason: string;
  }
  | {
    readonly stage: "tool-selection";
    readonly catalogEntriesInspected: number;
    readonly selectedToolNames: readonly string[];
    readonly omittedToolCount: number;
  }
  | {
    readonly stage: "role-selection";
    readonly capableRoles: readonly VectantRoutingRole[];
    readonly selectedRole: VectantRoutingRole;
  }
  | {
    readonly stage: "validation-decision";
    readonly required: boolean;
    readonly mode: AtomicTaskValidationDecision["mode"];
  }
  | {
    readonly stage: "execution-context";
    readonly exposedToolNames: readonly string[];
  };

export interface AtomicTaskRoute {
  readonly version: "vectant.atomic-task-route/v1";
  readonly task: Readonly<AtomicTaskMetadata>;
  readonly fastPath: boolean;
  readonly execution: {
    readonly role: VectantRoutingRole;
  };
  /** This is the complete MCP surface exposed by the route; no schemas leak. */
  readonly tools: readonly RoutedVectantTool[];
  readonly validation: AtomicTaskValidationDecision;
  readonly reason: string;
  readonly trace: readonly AtomicTaskRouteTrace[];
}

/**
 * A small, injectable compatibility shape for `@vectant/atomic-orchestrator`.
 * It mirrors its route contract without importing its JavaScript source into
 * this package's TypeScript compilation boundary.
 */
export interface AtomicOrchestratorCompatibleRoute {
  readonly role: VectantRoutingRole;
  readonly skills: readonly [];
  readonly validation: "independent" | "none";
  readonly reason: string;
  readonly suggested_tools: readonly string[];
}

/** The only Vectant metadata made available to an execution agent. */
export interface VectantExecutionContext {
  readonly task: Readonly<AtomicTaskMetadata>;
  readonly role: VectantRoutingRole;
  readonly tools: readonly RoutedVectantTool[];
  readonly validation: AtomicTaskValidationDecision;
}

const DEFAULT_MAX_TOOLS = 3;
const DEFAULT_FAST_PATH = /^(?:format|rename|typo|mechanical)\b/i;
const MUTATING_TERMS = new Set([
  "apply",
  "attach",
  "create",
  "delete",
  "open",
  "publish",
  "record",
  "request",
  "revoke",
  "run",
  "set",
  "update",
  "write",
]);
const ACTION_TERMS = new Set([
  "apply",
  "attach",
  "create",
  "delete",
  "detach",
  "issue",
  "open",
  "publish",
  "record",
  "request",
  "revoke",
  "run",
  "set",
  "update",
  "validate",
  "verify",
  "write",
]);
const VALIDATION_TERMS = new Set([
  "check",
  "proof",
  "test",
  "validate",
  "verification",
  "verify",
]);

/**
 * The implementation policy is intentionally the fallback. Specialized roles
 * must match task/catalog metadata and then the least expensive one wins.
 */
export const DEFAULT_VECTANT_AGENT_POLICIES: readonly VectantAgentPolicy[] = [
  {
    role: "validation",
    cost: 1,
    groups: ["verification", "proof"],
    keywords: ["check", "proof", "test", "validate", "verify"],
  },
  {
    role: "debugging",
    cost: 2,
    groups: ["telemetry"],
    keywords: ["debug", "error", "failure", "log", "regression"],
  },
  {
    role: "security",
    cost: 3,
    groups: ["authentication", "safety", "human-escalation"],
    keywords: ["auth", "permission", "privacy", "security"],
  },
  {
    role: "research",
    cost: 4,
    groups: ["observation"],
    keywords: ["discover", "inspect", "investigate", "research"],
  },
  {
    role: "infrastructure",
    cost: 5,
    groups: ["runtime", "attachment", "project"],
    keywords: ["attach", "deploy", "runtime", "workspace"],
  },
  {
    role: "data",
    cost: 6,
    groups: ["source-identity", "snapshot"],
    keywords: ["data", "migration", "snapshot", "source"],
  },
  {
    role: "implementation",
    cost: 100,
    fallback: true,
  },
] as const;

interface NormalizedTask extends AtomicTaskMetadata {
  readonly id: string;
  readonly terms: readonly string[];
}

interface ScoredTool {
  readonly tool: VectantToolMetadata;
  readonly score: number;
  readonly unmatchedTerms: number;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function terms(value: string): string[] {
  const camelSeparated = value.replace(/([a-z])([A-Z])/g, "$1 $2");
  const split = camelSeparated.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  // Keep a compact form for each original word too: "CodeSite" should match
  // catalog metadata written as `codesite`, without turning an entire sentence
  // into one unhelpful token.
  const compactWords = value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return unique([...split, ...compactWords]);
}

function normalizedTerms(values: readonly string[]): string[] {
  return unique(values.flatMap(terms));
}

function normalizeTask(task: AtomicTaskMetadata): NormalizedTask {
  const description = task.description.trim();
  if (description.length === 0) {
    throw new TypeError("Atomic task routing requires a non-empty description.");
  }

  const id = task.id?.trim() || "atomic-task";
  const category = task.category?.trim();
  const keywords = task.keywords ? unique(task.keywords.map((keyword) => keyword.trim()).filter(Boolean)) : undefined;
  const toolNames = task.toolNames ? unique(task.toolNames.map((name) => name.trim()).filter(Boolean)) : undefined;
  const termInputs = [description, ...(category ? [category] : []), ...(keywords ?? [])];

  return {
    id,
    description,
    ...(category ? { category } : {}),
    ...(keywords && keywords.length > 0 ? { keywords } : {}),
    ...(toolNames && toolNames.length > 0 ? { toolNames } : {}),
    ...(task.risk ? { risk: task.risk } : {}),
    ...(task.validation ? { validation: task.validation } : {}),
    ...(task.fastPath ? { fastPath: true } : {}),
    terms: normalizedTerms(termInputs),
  };
}

function metadataTerms(tool: VectantToolMetadata): string[] {
  return unique([
    ...tool.keywords.flatMap(terms),
    ...tool.groups.flatMap(terms),
  ]);
}

function scoreTool(tool: VectantToolMetadata, taskTerms: ReadonlySet<string>): ScoredTool {
  const toolTerms = metadataTerms(tool).filter((term) => term !== "vectant");
  const matchedTerms = unique(toolTerms.filter((term) => taskTerms.has(term)));
  return {
    tool,
    score: matchedTerms.length,
    unmatchedTerms: toolTerms.filter((term) => !taskTerms.has(term)).length,
  };
}

function compareScoredTools(left: ScoredTool, right: ScoredTool): number {
  return right.score - left.score
    || left.unmatchedTerms - right.unmatchedTerms
    || left.tool.name.localeCompare(right.tool.name);
}

function routedTool(tool: VectantToolMetadata): RoutedVectantTool {
  return {
    name: tool.name,
    groups: [...tool.groups],
    keywords: [...tool.keywords],
    origin: tool.origin,
  };
}

function matchedDomains(entries: readonly VectantToolMetadata[], taskTerms: ReadonlySet<string>): string[] {
  const domains = unique(entries.flatMap((entry) => entry.groups).filter((group) => (
    terms(group).some((term) => taskTerms.has(term))
  )));

  // Browser actions are a more specific expression of the runtime domain.
  if (domains.includes("browser")) {
    return domains.filter((domain) => domain !== "runtime");
  }
  // Agent Dojo is more specific than its proof/governance facets.
  if (domains.includes("agent-dojo")) {
    return domains.filter((domain) => domain !== "proof" && domain !== "governance");
  }
  // CodeSite is more specific than its control-plane facet.
  if (domains.includes("codesite")) {
    return domains.filter((domain) => domain !== "control-plane");
  }
  return domains;
}

function selectTools(
  catalog: ToolMetadataCatalog,
  task: NormalizedTask,
  maxTools: number,
): readonly VectantToolMetadata[] {
  const entries = catalog.entries;
  if (task.toolNames && task.toolNames.length > 0) {
    const requested = new Set(task.toolNames);
    return entries.filter((entry) => requested.has(entry.name)).slice(0, maxTools);
  }

  const taskTerms = new Set(task.terms);
  const scored = entries.map((entry) => scoreTool(entry, taskTerms)).filter((entry) => entry.score > 0);
  if (scored.length === 0) {
    return [];
  }

  const domains = matchedDomains(entries, taskTerms);
  const selected: ScoredTool[] = [];

  // Preserve explicitly requested actions before applying the general domain
  // ranking. A mixed request such as "open a CodeSite transaction and issue
  // a Dojo proof" has two independent actions; a global score would otherwise
  // let the more descriptive half eclipse the other one.
  for (const action of task.terms.filter((term) => ACTION_TERMS.has(term))) {
    const actionCandidates = scored.filter((entry) => (
      metadataTerms(entry.tool).includes(action)
      && (domains.length === 0 || entry.tool.groups.some((group) => domains.includes(group)))
    ));
    const selectedAction = [...actionCandidates].sort(compareScoredTools)[0];
    if (selectedAction) {
      selected.push(selectedAction);
    }
  }

  if (domains.length > 0) {
    for (const domain of [...domains].sort()) {
      const candidates = scored.filter((entry) => entry.tool.groups.includes(domain));
      if (candidates.length === 0) {
        continue;
      }
      const topScore = Math.max(...candidates.map((entry) => entry.score));
      const topCandidates = candidates.filter((entry) => entry.score === topScore);
      const leastUnmatched = Math.min(...topCandidates.map((entry) => entry.unmatchedTerms));
      selected.push(...topCandidates.filter((entry) => entry.unmatchedTerms === leastUnmatched));
    }
  } else {
    const topScore = Math.max(...scored.map((entry) => entry.score));
    const topCandidates = scored.filter((entry) => entry.score === topScore);
    const leastUnmatched = Math.min(...topCandidates.map((entry) => entry.unmatchedTerms));
    selected.push(...topCandidates.filter((entry) => entry.unmatchedTerms === leastUnmatched));
  }

  return unique(selected.map((entry) => entry.tool.name))
    .map((name) => entries.find((entry) => entry.name === name))
    .filter((entry): entry is VectantToolMetadata => entry !== undefined)
    .sort((left, right) => {
      const leftScore = scored.find((entry) => entry.tool.name === left.name);
      const rightScore = scored.find((entry) => entry.tool.name === right.name);
      return compareScoredTools(leftScore as ScoredTool, rightScore as ScoredTool);
    })
    .slice(0, maxTools);
}

function isPolicyCapable(
  policy: VectantAgentPolicy,
  task: NormalizedTask,
  selectedTools: readonly VectantToolMetadata[],
): boolean {
  const taskTerms = new Set(task.terms);
  const selectedGroups = new Set(selectedTools.flatMap((tool) => tool.groups));
  const hasGroup = (policy.groups ?? []).some((group) => selectedGroups.has(group));
  const hasKeyword = (policy.keywords ?? []).some((keyword) => terms(keyword).some((term) => taskTerms.has(term)));
  const hasCategory = Boolean(task.category && (policy.categories ?? []).includes(task.category));
  return hasGroup || hasKeyword || hasCategory;
}

function selectRole(
  policies: readonly VectantAgentPolicy[],
  task: NormalizedTask,
  selectedTools: readonly VectantToolMetadata[],
): { readonly role: VectantRoutingRole; readonly capableRoles: readonly VectantRoutingRole[] } {
  const capable = policies.filter((policy) => !policy.fallback && isPolicyCapable(policy, task, selectedTools));
  const candidates = capable.length > 0
    ? capable
    : policies.filter((policy) => policy.fallback);
  const ordered = [...(candidates.length > 0 ? candidates : DEFAULT_VECTANT_AGENT_POLICIES.filter((policy) => policy.fallback))]
    .sort((left, right) => left.cost - right.cost || left.role.localeCompare(right.role));
  const selected = ordered[0];
  if (!selected) {
    // Kept only as a defensive guard for hostile injected policy lists.
    return { role: "implementation", capableRoles: [] };
  }
  return {
    role: selected.role,
    capableRoles: capable
      .map((policy) => policy.role)
      .sort((left, right) => left.localeCompare(right)),
  };
}

function validationDecision(
  task: NormalizedTask,
  selectedTools: readonly VectantToolMetadata[],
): AtomicTaskValidationDecision {
  if (task.validation === "required") {
    return { required: true, role: "validation", mode: "independent", reason: "Requested by the atomic task." };
  }
  if (task.validation === "not-required") {
    return { required: false, role: null, mode: "not-required", reason: "Explicitly waived by the atomic task." };
  }

  const selectedTerms = new Set(selectedTools.flatMap(metadataTerms));
  const highRisk = task.risk === "high" || task.risk === "critical";
  const validates = [...selectedTerms].some((term) => VALIDATION_TERMS.has(term));
  const mutates = [...selectedTerms].some((term) => MUTATING_TERMS.has(term));
  const requires = highRisk || validates || mutates;
  const reason = highRisk
    ? "High-risk atomic work requires independent validation."
    : validates
      ? "The selected metadata includes a verification or proof capability."
      : mutates
        ? "The selected metadata includes a state-changing capability."
        : "The selected metadata is observational or no Vectant capability matched.";
  return {
    required: requires,
    role: requires ? "validation" : null,
    mode: requires ? "independent" : "not-required",
    reason,
  };
}

function isDefaultFastPath(task: NormalizedTask): boolean {
  return task.fastPath === true || DEFAULT_FAST_PATH.test(task.description);
}

/**
 * Creates a reusable router. It only computes a plan: tool registration,
 * execution, and validation invocation remain the caller's responsibility.
 */
export function createAtomicTaskRouter(options: AtomicTaskRouterOptions = {}) {
  const catalog = options.catalog ?? TOOL_METADATA_CATALOG;
  const policies = options.agentPolicies ?? DEFAULT_VECTANT_AGENT_POLICIES;
  const maxTools = options.maxTools ?? DEFAULT_MAX_TOOLS;
  if (!Number.isInteger(maxTools) || maxTools < 1) {
    throw new RangeError("Atomic task routing requires maxTools to be a positive integer.");
  }

  const route = (input: AtomicTaskMetadata): AtomicTaskRoute => {
    const task = normalizeTask(input);
    const fastPath = options.isFastPath?.(task) ?? isDefaultFastPath(task);
    const baseTrace: AtomicTaskRouteTrace[] = [{
      stage: "atomic-task",
      taskId: task.id,
      category: task.category ?? null,
    }];

    if (fastPath) {
      const validation: AtomicTaskValidationDecision = {
        required: false,
        role: null,
        mode: "not-required",
        reason: "Fast-path operations are local and mechanical.",
      };
      return {
        version: "vectant.atomic-task-route/v1",
        task,
        fastPath: true,
        execution: { role: "implementation" },
        tools: [],
        validation,
        reason: "Fast path selected for a local mechanical operation.",
        trace: [
          ...baseTrace,
          { stage: "fast-path", reason: "Explicit or mechanical fast-path rule matched." },
          { stage: "validation-decision", required: false, mode: "not-required" },
          { stage: "execution-context", exposedToolNames: [] },
        ],
      };
    }

    const selectedTools = selectTools(catalog, task, maxTools);
    const role = selectRole(policies, task, selectedTools);
    const validation = validationDecision(task, selectedTools);
    const tools = selectedTools.map(routedTool);
    const selectedToolNames = tools.map((tool) => tool.name);
    const reason = tools.length > 0
      ? `Selected ${tools.length} metadata-matched Vectant tool${tools.length === 1 ? "" : "s"} and the cheapest capable ${role.role} role.`
      : "No Vectant metadata matched; selected the cheapest capable fallback role without exposing tools.";

    return {
      version: "vectant.atomic-task-route/v1",
      task,
      fastPath: false,
      execution: { role: role.role },
      tools,
      validation,
      reason,
      trace: [
        ...baseTrace,
        {
          stage: "tool-selection",
          catalogEntriesInspected: catalog.entries.length,
          selectedToolNames,
          omittedToolCount: Math.max(0, catalog.entries.length - selectedToolNames.length),
        },
        { stage: "role-selection", capableRoles: role.capableRoles, selectedRole: role.role },
        { stage: "validation-decision", required: validation.required, mode: validation.mode },
        { stage: "execution-context", exposedToolNames: selectedToolNames },
      ],
    };
  };

  return { route };
}

/** Routes a task against the default catalog without exposing MCP schemas. */
export function routeAtomicVectantTask(input: AtomicTaskMetadata): AtomicTaskRoute {
  return createAtomicTaskRouter().route(input);
}

/**
 * Builds the only execution payload a caller should pass downstream. It has no
 * catalog reference, omitted tool names, registration details, or schemas.
 */
export function createVectantExecutionContext(route: AtomicTaskRoute): VectantExecutionContext {
  return {
    task: route.task,
    role: route.execution.role,
    tools: route.tools.map((tool) => ({
      name: tool.name,
      groups: [...tool.groups],
      keywords: [...tool.keywords],
      origin: tool.origin,
    })),
    validation: route.validation,
  };
}

/** Adapts this plan to the source contract accepted by `atomic-orchestrator`. */
export function toAtomicOrchestratorCompatibleRoute(
  route: AtomicTaskRoute,
): AtomicOrchestratorCompatibleRoute {
  return {
    role: route.execution.role,
    skills: [],
    validation: route.validation.required ? "independent" : "none",
    reason: route.reason,
    suggested_tools: route.tools.map((tool) => tool.name),
  };
}

/** Stable JSON for trace sinks or external routing agents. */
export function serializeAtomicTaskRoute(route: AtomicTaskRoute): string {
  return JSON.stringify(route);
}

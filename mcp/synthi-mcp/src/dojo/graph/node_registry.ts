import { DOJO_GRAPH_NODE_KINDS, type DojoGraphNodeKind, type DojoSkillGraph } from "./types.js";

export { DOJO_GRAPH_NODE_KINDS } from "./types.js";

export type DojoGraphNodeRuntimePhase =
  | "control"
  | "observation"
  | "effect"
  | "evidence"
  | "recovery";

export interface DojoGraphNodeHandler {
  kind: DojoGraphNodeKind;
  runtime_phase: DojoGraphNodeRuntimePhase;
  description: string;
  preflight_skips_execution: boolean;
  requires_human_decision: boolean;
  executes_rollback: boolean;
  executes_substrate: boolean;
  evaluates_branch: boolean;
  evaluates_retry_policy: boolean;
  evaluates_case_law_binding: boolean;
  validates_proof_in_production: boolean;
}

export interface DojoGraphNodeRegistry {
  list(): DojoGraphNodeHandler[];
  get(kind: DojoGraphNodeKind): DojoGraphNodeHandler | undefined;
  has(kind: DojoGraphNodeKind): boolean;
}

export interface DojoGraphNodeRegistryValidation {
  ok: boolean;
  missing_handlers: DojoGraphNodeKind[];
  duplicate_handlers: DojoGraphNodeKind[];
}

const DEFAULT_DOJO_GRAPH_NODE_HANDLERS: DojoGraphNodeHandler[] = [
  handler("Trigger", "control", "Starts a graph run from a demonstrated or scheduled trigger."),
  handler("Input", "control", "Binds user, policy, and fixture inputs into run state."),
  handler("Observe", "observation", "Observes UI, API, source, or fixture state without mutation."),
  handler("Locate", "observation", "Locates a stable UI, source, API, or entity target."),
  handler("Action", "effect", "Executes an allowed substrate action.", {
    preflight_skips_execution: true,
    executes_substrate: true,
    validates_proof_in_production: true,
  }),
  handler("Assertion", "evidence", "Verifies postconditions from observed runtime evidence.", {
    preflight_skips_execution: true,
  }),
  handler("Branch", "control", "Chooses the next graph path from executable predicates.", {
    evaluates_branch: true,
  }),
  handler("Permission", "control", "Represents permission and approval requirements."),
  handler("Guardrail", "control", "Evaluates safety predicates before protected actions."),
  handler("Retry", "control", "Applies bounded retry policy.", {
    evaluates_retry_policy: true,
  }),
  handler("Artifact", "evidence", "Writes or references durable artifacts."),
  handler("Subskill", "control", "Delegates to a certified subskill."),
  handler("Human", "control", "Pauses or gates execution on a human decision.", {
    requires_human_decision: true,
  }),
  handler("Rollback", "recovery", "Executes rollback or escalation policy.", {
    executes_rollback: true,
  }),
  handler("Memory", "control", "Reads or writes bounded node memory."),
  handler("Adversary", "control", "Represents adversarial scenario pressure."),
  handler("Checkride", "evidence", "Runs or references certification scenarios."),
  handler("Proof", "control", "Validates proof capsule requirements.", {
    validates_proof_in_production: true,
  }),
  handler("CaseLaw", "control", "Enforces approved case-law binding state.", {
    evaluates_case_law_binding: true,
  }),
  handler("Expiry", "control", "Represents skill, policy, source, or evidence expiry."),
];

export function createDefaultDojoGraphNodeRegistry(): DojoGraphNodeRegistry {
  return createDojoGraphNodeRegistry(DEFAULT_DOJO_GRAPH_NODE_HANDLERS);
}

export function createDojoGraphNodeRegistry(handlers: DojoGraphNodeHandler[]): DojoGraphNodeRegistry {
  const handlersByKind = new Map<DojoGraphNodeKind, DojoGraphNodeHandler>();
  for (const item of handlers) {
    if (!DOJO_GRAPH_NODE_KINDS.includes(item.kind)) {
      throw new Error(`dojo_graph_node_handler_unknown_kind:${item.kind}`);
    }
    if (handlersByKind.has(item.kind)) {
      throw new Error(`dojo_graph_node_handler_duplicate:${item.kind}`);
    }
    handlersByKind.set(item.kind, freezeHandler(item));
  }
  return {
    list: () => [...handlersByKind.values()].map(freezeHandler),
    get: (kind) => handlersByKind.get(kind),
    has: (kind) => handlersByKind.has(kind),
  };
}

export function validateDojoGraphNodeRegistryForGraph(
  graph: DojoSkillGraph,
  registry: DojoGraphNodeRegistry = createDefaultDojoGraphNodeRegistry()
): DojoGraphNodeRegistryValidation {
  const missing = new Set<DojoGraphNodeKind>();
  const seen = new Set<DojoGraphNodeKind>();
  const duplicates = new Set<DojoGraphNodeKind>();
  for (const handler of registry.list()) {
    if (seen.has(handler.kind)) duplicates.add(handler.kind);
    seen.add(handler.kind);
  }
  for (const node of graph.nodes) {
    if (!registry.has(node.kind)) missing.add(node.kind);
  }
  return {
    ok: missing.size === 0 && duplicates.size === 0,
    missing_handlers: [...missing].sort(),
    duplicate_handlers: [...duplicates].sort(),
  };
}

function handler(
  kind: DojoGraphNodeKind,
  runtimePhase: DojoGraphNodeRuntimePhase,
  description: string,
  overrides: Partial<Omit<DojoGraphNodeHandler, "kind" | "runtime_phase" | "description">> = {}
): DojoGraphNodeHandler {
  return freezeHandler({
    kind,
    runtime_phase: runtimePhase,
    description,
    preflight_skips_execution: false,
    requires_human_decision: false,
    executes_rollback: false,
    executes_substrate: false,
    evaluates_branch: false,
    evaluates_retry_policy: false,
    evaluates_case_law_binding: false,
    validates_proof_in_production: false,
    ...overrides,
  });
}

function freezeHandler(handler: DojoGraphNodeHandler): DojoGraphNodeHandler {
  return Object.freeze({ ...handler });
}

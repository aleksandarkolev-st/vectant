/**
 * Teacher facade: the five-verb surface every substrate shares.
 *
 *   attach  -> open a session under an explicit realm consent decision
 *   observe -> read world state (channels optional; defaults just work)
 *   teach   -> record a human demonstration (begin/end), compile contract
 *   run     -> replay a compiled competency (same or fresh state)
 *   explain -> human-language failure explanation from classifier output
 *
 * The happy path touches nothing but these verbs with defaults. Internals
 * (differ, attribution evidence, affordance tiers) stay behind this facade.
 * Zero jargon escapes: explanations map trunk classes to plain sentences.
 */

import type {
  SessionHandle,
  SubstrateAdapterBundle,
} from "./substrate.js";
import { requireCapability } from "./substrate.js";
import { evaluateRealmConsent, grantRealmCapability, type RealmConsentRecord } from "./consent.js";
import { classifyFromEvidence, type ClassificationEvidence } from "./classifier.js";
import { deriveUncertainty, validateContractStep, type EmbodiedWorkflowContract } from "./contract.js";
import { runStateDiffer } from "./state_differ/index.js";
import type { PersistenceTrace } from "./state_differ/types.js";
import type { ChangedValue } from "./world_state.js";
import type { SubstrateKind } from "./event.js";
import { resolveSemanticClass, validateWorldStateSchema, type WorldStateSchema } from "./world_state.js";

// ---------------------------------------------------------------------------
// Verb inputs/outputs
// ---------------------------------------------------------------------------

export interface ConsentDecisionInput {
  subject: string;
  realm: { realm_kind: string; realm_id: string };
  /** Which capabilities to grant for this session. */
  allow: ReadonlyArray<"observe" | "record" | "act">;
}

export interface AttachedSession<THandle extends SessionHandle = SessionHandle> {
  handle: THandle;
  substrate_kind: string;
  schema: WorldStateSchema;
  consent: RealmConsentRecord;
}

export interface Demonstration {
  trace_id: string;
  steps: Array<{ event: unknown }>;
}

export interface TeachResult {
  demonstration: Demonstration;
  steps_recorded: number;
  /** Compiled per-step contracts when the substrate exposes enough signal. */
  contract: EmbodiedWorkflowContract | null;
  problems: string[];
}

// ---------------------------------------------------------------------------
// Facade
// ---------------------------------------------------------------------------

export class EmbodiedTeacher {
  private readonly bundle: SubstrateAdapterBundle;
  readonly substrate_kind: string;

  constructor(bundle: SubstrateAdapterBundle) {
    this.bundle = bundle;
    this.substrate_kind = bundle.substrate_kind;
  }

  /** Verb 1: attach — consent is explicit input, never implicit. */
  async attach(consent: ConsentDecisionInput): Promise<AttachedSession> {
    let record = { realm: consent.realm, subject: consent.subject, capabilities: {} } as RealmConsentRecord;
    for (const capability of consent.allow) {
      record = grantRealmCapability(record, capability, 0);
    }
    const realm = { realm_kind: consent.realm.realm_kind, realm_id: consent.realm.realm_id };
    if (!evaluateRealmConsent(record, realm, "observe").allowed && consent.allow.includes("observe")) {
      throw new Error("consent setup failed");
    }
    const handle = await this.bundle.attach({
      realm,
      consent_proof: { subject: consent.subject, realm, approved_capabilities: consent.allow },
    });
    // Schema materializes at attach time (never queried mid-run).
    let schema: WorldStateSchema | undefined;
    if (this.bundle.observer) {
      const declared = this.bundle.observer.describeWorldSchema() as unknown as WorldStateSchema;
      const problems = validateWorldStateSchema(declared);
      if (problems.length === 0) schema = declared;
    }
    return {
      handle,
      substrate_kind: this.substrate_kind,
      schema: schema ?? {
        schema_id: `${this.substrate_kind}.undeclared`,
        schema_version: "0.0.1",
        value_types: [],
        identity: { id_scheme: "derived", survives: [], reidentification_rule: "none declared" },
        observability: { fully_observable: false, hidden_state: ["undeclared schema"], policy: "best_effort" },
      },
      consent: record,
    };
  }

  /** Verb 2: observe — defaults just work. */
  async observe(session: AttachedSession, channels?: readonly string[]): Promise<unknown> {
    const observer = requireCapability(this.substrate_kind, (b) => b.observer, "observer");
    return observer.observe(session.handle, channels);
  }

  /** Verb 3: teach — begin/end recording; compiles a contract from the
   *  demonstration using the differ when the adapter supplies diffs. */
  async beginTeach(session: AttachedSession): Promise<void> {
    const recorder = requireCapability(this.substrate_kind, (b) => b.recorder, "recorder");
    recorder.beginRecord(session.handle);
  }

  async endTeach(
    session: AttachedSession,
    options: {
      /** Adapter-side stage-1 diff of the demonstration (before -> after). */
      changedValues?: ChangedValue[];
      persistenceTraces?: PersistenceTrace[];
      baseline?: Map<string, unknown>;
      controlDiffs?: Array<{ source_id: string; changed: ChangedValue[] }>;
      intent?: string;
    } = {},
  ): Promise<TeachResult> {
    const recorder = requireCapability(this.substrate_kind, (b) => b.recorder, "recorder");
    const fragment = recorder.endRecord(session.handle);
    const problems: string[] = [];
    let contract: EmbodiedWorkflowContract | null = null;

    if (options.changedValues && options.changedValues.length > 0 && session.schema.value_types.length > 0) {
      const differResult = runStateDiffer(
        {
          changed_values: options.changedValues.map((change) => ({
            ...change,
            semantic_class: resolveSemanticClass(session.schema, change.path),
          })),
          window: { start_tick: 0, end_tick: fragment.steps.length, settle_tick: fragment.steps.length + 2 },
          schema: session.schema,
          ...(options.controlDiffs ? { control_diffs: options.controlDiffs } : {}),
        },
        options.persistenceTraces ?? [],
        options.baseline ?? new Map(),
      );
      if (differResult.delta_truncated) {
        problems.push(`delta budget exceeded (${differResult.dropped_count} dropped - flagged, not silent)`);
      }
      const effects = differResult.deltas
        .filter((delta) => delta.compiled_predicate && delta.persistence_class === "durable")
        .map((delta) => ({
          predicate: {
            predicate_id: delta.compiled_predicate!.predicate_id,
            args: delta.compiled_predicate!.args,
          },
          severity: delta.causal_class === "actor_caused" ? ("hard" as const) : ("optional" as const),
          uncertainty: deriveUncertainty(delta.evidence, 2, false),
        }));
      const step = {
        step_id: `${fragment.trace_id}-step-0`,
        intent: options.intent ?? `reproduce ${fragment.steps.length} recorded steps`,
        substrate_kind: this.substrate_kind as SubstrateKind,
        preconditions: [],
        action: { kind: "composite", primitive_class: "discrete" as const },
        expected_effects: effects,
        tolerated_variants: [],
        hard_failures: [],
        steps: fragment.steps.map((s) => s.event),
      };
      const stepProblems = validateContractStep(step);
      problems.push(...stepProblems.map((p) => `${p.path}: ${p.problem}`));
      contract = {
        embodied_contract_version: 1,
        contract_id: `contract-${fragment.trace_id}`,
        steps: [step],
        realm_scopes: [{ realm_kind: session.handle.realm.realm_kind, realm_id: session.handle.realm.realm_id }],
      };
    }

    return {
      demonstration: { trace_id: fragment.trace_id, steps: fragment.steps.map((s) => ({ event: s.event })) },
      steps_recorded: fragment.steps.length,
      contract,
      problems,
    };
  }

  /** Verb 4: run — replay with an explicit mode; returns structured outcome. */
  async run(
    session: AttachedSession,
    demonstration: Demonstration,
    mode: "same_state" | "fresh_state",
  ) {
    const replayProvider = requireCapability(this.substrate_kind, (b) => b.replay_provider, "replay_provider");
    return replayProvider.replay(
      { trace_id: demonstration.trace_id, steps: demonstration.steps.map((s) => ({ event: s.event })) },
      { handle: session.handle, mode },
    );
  }

  /** Verb 5: explain — human language, no jargon escapes. */
  explainFailure(stepIndex: number, classifierTrunk?: string): string {
    if (!classifierTrunk) {
      return `Step ${stepIndex + 1} could not be verified in the current state.`;
    }
    // Structured evidence maps through the shared classifier so wording and
    // classification can never drift apart.
    const evidence = trunkToEvidence(classifierTrunk);
    if (evidence) {
      const classified = classifyFromEvidence(evidence);
      return humanSentenceFor(stepIndex, classified.trunk);
    }
    return humanSentenceFor(stepIndex, "unknown");
  }
}

function trunkToEvidence(trunk: string): ClassificationEvidence | null {
  switch (trunk) {
    case "perception_drift":
      return { kind: "affordance_resolution", resolved: false } as const;
    case "identity_lost":
      return { kind: "identity_reidentification", matched: false, candidates_tried: 1 } as const;
    case "load_delay":
      return { kind: "timing", waited_ms: 1, budget_ms: 1, settled: false } as const;
    case "network_failure":
      return { kind: "transport", attempts: 0, reachable: false } as const;
    case "app_validation_error":
      return { kind: "app_rejection", validation_errors: 1, state_conflict: false } as const;
    case "world_changed":
    case "test_data_missing":
      return { kind: "data_binding", missing_bindings: ["changed-state"] } as const;
    default:
      return null;
  }
}

const SENTENCES: Record<string, string> = {
  perception_drift:
    "The thing this step used to recognize looks different now. Re-teach the step or update what it should look for.",
  identity_lost:
    "The target of this step cannot be found anymore. It may have been renamed or removed.",
  load_delay:
    "Things were still loading when the step ran. Waiting longer before this step may fix it.",
  network_failure:
    "The connection needed for this step was unavailable. Check connectivity and retry.",
  app_validation_error:
    "The application refused the action - its state did not allow it at that moment.",
  world_changed:
    "The expected result of this step is no longer present; the surrounding flow has moved on.",
  test_data_missing:
    "Data this step depends on is missing or has changed value.",
  mutation_blocked:
    "This step performs a change that current policy does not allow right now.",
  unsafe_environment:
    "It is not safe to perform this step in the environment's current condition.",
  consent_missing:
    "Permission to perform this step has not been granted for this scope.",
  auth:
    "Sign-in state required by this step is missing or expired.",
  substrate_limitation:
    "This kind of action cannot be performed reliably in this world.",
  unknown:
    "The step failed for an unrecognized reason; raw diagnostics are available on request.",
};

function humanSentenceFor(stepIndex: number, trunk: string): string {
  return `Step ${stepIndex + 1} failed: ${SENTENCES[trunk] ?? SENTENCES.unknown}`;
}

/** Convenience: build a teacher from a registered substrate kind. */
export function teacherForRegistered(substrateKind: string): EmbodiedTeacher {
  // Lazy import avoidance: caller registers adapters before calling this.
  const registry = requireRegisteredBundle(substrateKind);
  return new EmbodiedTeacher(registry);
}

import { getAdapter } from "./substrate.js";
function requireRegisteredBundle(kind: string): SubstrateAdapterBundle {
  return getAdapter(kind);
}


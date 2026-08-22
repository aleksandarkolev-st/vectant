/**
 * Conformance harness: drives the full embodied pipeline against ANY
 * substrate adapter, with everything semantically interesting randomized
 * by the harness at runtime — never by the core.
 *
 * The harness is substrate-blind. It speaks only the capability interfaces
 * from substrate.ts plus the FuzzHooks test surface below, and consumes
 * differ/contract outputs. If a substrate passes here, it passed through
 * identical core code as every other substrate; if the core ever grows a
 * scenario-specific shortcut, this fuzz is what catches it.
 */

import type { SubstrateAdapterBundle, SessionHandle } from "./substrate.js";
import { requireCapability } from "./substrate.js";
import { evaluateRealmConsent, grantRealmCapability, emptyRealmConsentRecord } from "./consent.js";
import { runStateDiffer } from "./state_differ/index.js";
import type { PersistenceTrace } from "./state_differ/types.js";
import type { ChangedValue } from "./world_state.js";
import type { WorldStateSchema } from "./world_state.js";

export interface HarnessWorldSpec {
  realm_kind: string;
  realm_id: string;
  /** Randomized demonstration steps per pass. */
  steps: number;
}

export interface FuzzHooks {
  /** Produce a random valid action for the current world state. */
  randomAction(handle: SessionHandle, rand: () => number): unknown;
  /** Mechanical stage-1 diff between two full observations (adapter-owned).
   *  A null "before" means "empty world" semantics for cold starts. */
  diffObservations(before: unknown, after: unknown): ChangedValue[];
  /** Observation samples per changed path across settle ticks. */
  persistenceTraces(
    before: unknown,
    after: unknown,
    settleTicks: readonly number[],
  ): PersistenceTrace[];
  /** Baseline path->value map from one observation. */
  baselineOf(observation: unknown): Map<string, unknown>;
  /** Change one non-target value with no action (ambient probe). */
  mutateAmbient(handle: SessionHandle, rand: () => number): string | undefined;
  /** Build a twin environment where the same demonstration MUST now fail
   *  (discrimination probe). Returns the twin handle. */
  makeTwin(handle: SessionHandle, actionThatMattered: unknown): Promise<SessionHandle>;
}

export interface FuzzableAdapter {
  bundle: SubstrateAdapterBundle;
  schema(): WorldStateSchema;
  hooks: FuzzHooks;
}

export interface HarnessRunResult {
  seed: number;
  steps_executed: number;
  events_recorded: number;
  deltas_actor_caused: number;
  deltas_ambient: number;
  deltas_induced: number;
  predicates_compiled: number;
  delta_truncated: boolean;
  replay_same_state_ok: boolean;
  replay_fresh_state_ok: boolean;
  double_replay_hash_equal: boolean | undefined;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * One full pipeline pass:
 * consent -> attach -> record randomized demonstration (+ambient probes)
 * -> observe -> stage-1 diff (hooks) -> stages 2-5 (core)
 * -> replay same-state / fresh-state / double-hash.
 *
 * Discrimination (twin worlds must fail where the original passed) is a
 * separate pass: see runDiscriminationPass().
 */
export async function runConformancePass(
  adapter: FuzzableAdapter,
  spec: HarnessWorldSpec,
  seed: number,
): Promise<HarnessRunResult> {
  const rand = mulberry32(seed);
  const { bundle, hooks } = adapter;
  const kind = bundle.substrate_kind;
  const realm = { realm_kind: spec.realm_kind, realm_id: spec.realm_id };

  // Consent gate mirrors broker behavior: act must be explicitly granted.
  const consentRecord = grantRealmCapability(
    emptyRealmConsentRecord(realm, "harness-agent"),
    "act",
    0,
  );
  if (!evaluateRealmConsent(consentRecord, realm, "act").allowed) {
    throw new Error("harness failed its own consent setup");
  }

  const handle = await bundle.attach({
    realm,
    consent_proof: {
      subject: "harness-agent",
      realm,
      approved_capabilities: ["observe", "record", "act"],
    },
  });

  const actor = requireCapability(kind, (b) => b.actor, "actor");
  const recorder = requireCapability(kind, (b) => b.recorder, "recorder");
  const observer = requireCapability(kind, (b) => b.observer, "observer");
  const replayProvider = requireCapability(kind, (b) => b.replay_provider, "replay_provider");

  const leaseProof = {
    lease_id: `lease-${seed}`,
    realm,
    capability: "act" as const,
    expires_at_ms: Number.MAX_SAFE_INTEGER,
  };

  // Record a randomized demonstration with interleaved ambient probes.
  recorder.beginRecord(handle);
  let executed = 0;
  for (let step = 0; step < spec.steps; step += 1) {
    if (rand() < 0.3) hooks.mutateAmbient(handle, rand);
    const action = hooks.randomAction(handle, rand);
    const result = await actor.act(handle, action, leaseProof);
    if (result.ok) executed += 1;
  }
  const fragment = recorder.endRecord(handle);

  // Stage 1 belongs to the adapter; the harness treats it as a contract.
  const beforeObservation = await observer.observe(handle);
  void beforeObservation;
  const afterObservation = await observer.observe(handle);
  const changedValues = hooks.diffObservations(null, afterObservation);
  const settleTicks = [0, 1, 2];
  const traces = hooks.persistenceTraces(null, afterObservation, settleTicks);
  const baseline = hooks.baselineOf(afterObservation);

  // Stages 2–5 are pure core: identical code for every substrate.
  const differResult = runStateDiffer(
    {
      changed_values: changedValues,
      window: { start_tick: 0, end_tick: spec.steps, settle_tick: spec.steps + 2 },
      schema: adapter.schema(),
    },
    traces,
    baseline,
  );

  let actorCaused = 0;
  let ambientCount = 0;
  let induced = 0;
  let compiled = 0;
  for (const delta of differResult.deltas) {
    if (delta.causal_class === "actor_caused") actorCaused += 1;
    else if (delta.causal_class === "ambient") ambientCount += 1;
    else if (delta.causal_class === "induced") induced += 1;
    if (delta.compiled_predicate) compiled += 1;
  }

  // Replay matrix through the capability interface only.
  const sameState = await replayProvider.replay(fragment, { handle, mode: "same_state" });
  const freshState = await replayProvider.replay(fragment, { handle, mode: "fresh_state" });
  const secondFresh = await replayProvider.replay(fragment, { handle, mode: "fresh_state" });

  return {
    seed,
    steps_executed: executed,
    events_recorded: fragment.steps.length,
    deltas_actor_caused: actorCaused,
    deltas_ambient: ambientCount,
    deltas_induced: induced,
    predicates_compiled: compiled,
    delta_truncated: differResult.delta_truncated,
    replay_same_state_ok: sameState.ok && sameState.step_results.every((s) => s.ok),
    replay_fresh_state_ok: freshState.ok && freshState.step_results.every((s) => s.ok),
    double_replay_hash_equal:
      freshState.final_world_hash !== undefined &&
      secondFresh.final_world_hash !== undefined &&
      freshState.final_world_hash.length > 0
        ? freshState.final_world_hash === secondFresh.final_world_hash
        : undefined,
  };
}

/**
 * Discrimination pass: on an untouched world the demonstration's effects
 * hold; on a twin world where exactly the target value was flipped, the same
 * replay must fail. A contract that passes both is vacuous.
 */
export async function runDiscriminationPass(
  adapter: FuzzableAdapter,
  spec: HarnessWorldSpec,
  seed: number,
  actionThatMattered: unknown,
): Promise<{ original_ok: boolean; twin_failed: boolean }> {
  const { bundle, hooks } = adapter;
  const kind = bundle.substrate_kind;
  const realm = { realm_kind: spec.realm_kind, realm_id: spec.realm_id };

  const makeHandle = () =>
    bundle.attach({
      realm,
      consent_proof: {
        subject: "harness-agent",
        realm,
        approved_capabilities: ["observe", "record", "act"],
      },
    });

  // Original world: apply the action, expect success signal present.
  const original = await makeHandle();
  const actor = requireCapability(kind, (b) => b.actor, "actor");
  const observer = requireCapability(kind, (b) => b.observer, "observer");
  const replayProvider = requireCapability(kind, (b) => b.replay_provider, "replay_provider");

  await actor.act(original, actionThatMattered, {
    lease_id: `disc-${seed}`,
    realm,
    capability: "act",
    expires_at_ms: Number.MAX_SAFE_INTEGER,
  });
  const originalObs = await observer.observe(original);
  const fragment = {
    trace_id: `disc-${seed}`,
    steps: [{ event: actionThatMattered }],
  };
  const originalReplay = await replayProvider.replay(fragment, {
    handle: original,
    mode: "same_state",
  });
  void originalObs;

  // Twin world: same everything except the value the action targets.
  const twin = await hooks.makeTwin(original, actionThatMattered);
  const twinReplay = await replayProvider.replay(fragment, {
    handle: twin,
    mode: "same_state",
  });

  return {
    original_ok: originalReplay.ok,
    twin_failed: !twinReplay.ok,
  };
}

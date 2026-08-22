/**
 * Capability-split substrate interfaces and the registry that negotiates
 * them structurally.
 *
 * An adapter is a bundle of narrow capabilities, never an execution
 * environment. Downstream code (broker, differ orchestration, hardening)
 * declares the capability it needs; the registry hands back only adapters
 * that implement it. Missing capabilities degrade behavior deterministically
 * (e.g. no ForkProvider => attribution uses multi-demo voting) instead of
 * boolean flags scattered through the core.
 *
 * Everything here is generic over observation/action payloads: TObservation,
 * TAction, THandle. No substrate semantics live in this file.
 */

import type { RealmRef } from "./event.js";

/** A session into one environment, obtained under one realm consent. */
export interface SessionHandle<
  TEnvironment = unknown,
  TRealm extends RealmRef = RealmRef,
> {
  handle_id: string;
  environment: TEnvironment;
  realm: TRealm;
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/** Read access to world state through typed channels + schema declaration. */
export interface ObserverCap<TObservation = unknown, THandle = SessionHandle> {
  observe(handle: THandle, channels?: readonly string[]): Promise<TObservation>;
  /** The adapter's declared ontology. Must be materialized at attach time;
   *  the core never queries adapter code paths for semantics mid-run. */
  describeWorldSchema(): WorldStateSchemaLike;
  /** Which channels exist (ordered cheapest-first). */
  readonly channels: readonly string[];
}

/** Act on the world under a caller-supplied lease proof. */
export interface ActorCap<TAction = unknown, THandle = SessionHandle> {
  act(handle: THandle, action: TAction, leaseProof: LeaseProof): Promise<ActResult>;
}

export interface ActResult {
  ok: boolean;
  applied_tick?: number;
  refusal_reason?: string;
}

/** Capture a human/agent demonstration into a trace fragment. */
export interface RecorderCap<TEvent = unknown, THandle = SessionHandle> {
  beginRecord(handle: THandle): void;
  endRecord(handle: THandle): TraceFragmentLike;
}

/** Deterministic reset profiles. */
export interface ResetProviderCap<TProfileId extends string = string> {
  readonly resetProfiles: readonly TProfileId[];
  reset(handle: SessionHandle, profile: TProfileId): Promise<void>;
}

/** Branch world state for counterfactual controls. */
export interface ForkProviderCap<THandle extends SessionHandle = SessionHandle, TFork = unknown> {
  fork(handle: THandle): Promise<THandle & { fork_of: string }>;
  disposeFork(forkHandle: TFork): Promise<void>;
}

/** Re-execute a recorded fragment against an explicit environment handle. */
export interface ReplayProviderCap<TEvent = unknown> {
  replay(
    fragment: TraceFragmentLike,
    options: {
      handle: SessionHandle;
      mode: "same_state" | "fresh_state";
      /** Fresh-state replays may reset through this profile first. */
      reset_profile?: string;
    },
  ): Promise<ReplayOutcome>;
}

export interface ReplayOutcome {
  ok: boolean;
  /** Per-step results aligned with fragment steps. */
  step_results: Array<{
    step_index: number;
    ok: boolean;
    classifier_trunk?: string;
    detail?: Record<string, unknown>;
  }>;
  /** Hash of resulting world state for double-replay equality checks. */
  final_world_hash?: string;
}

/** Opaque proof that a lease is active; the broker mints these, not adapters. */
export interface LeaseProof {
  lease_id: string;
  realm: RealmRef;
  capability: "act";
  expires_at_ms: number;
}

export interface TraceFragmentLike {
  trace_id: string;
  steps: Array<{ event: unknown; pre_observation_ref?: string; post_observation_ref?: string }>;
}

/** Minimal structural mirror to avoid importing world_state.ts here. */
export interface WorldStateSchemaLike {
  schema_id: string;
  schema_version: string;
  value_types: Array<{ path_pattern: string; type: unknown; semantic_class?: string }>;
  identity: { id_scheme: "stable" | "session" | "derived"; survives: readonly string[]; reidentification_rule?: string };
  observability: { fully_observable: boolean; hidden_state: string[]; policy: string };
  noise_fingerprints?: Array<{ fingerprint_id: string; path_pattern: string; period_hint_ticks?: number }>;
}

// ---------------------------------------------------------------------------
// Adapter bundle + registration
// ---------------------------------------------------------------------------

/**
 * What an adapter ships. Every field is optional except identity: the
 * registry derives capability support structurally from what is present.
 */
export interface SubstrateAdapterBundle<
  TObservation = unknown,
  TAction = unknown,
  THandle extends SessionHandle = SessionHandle,
> {
  /** Registry key, e.g. "browser", "terminal", "grid.world". Namespaced
   *  with a dot when experimental. */
  substrate_kind: string;
  adapter_version: string;

  observer?: ObserverCap<TObservation, THandle>;
  actor?: ActorCap<TAction, THandle>;
  recorder?: RecorderCap<never, THandle>;
  reset_provider?: ResetProviderCap<string>;
  fork_provider?: ForkProviderCap<THandle>;
  replay_provider?: ReplayProviderCap<never>;

  /** Attach under an explicit realm consent decision made upstream. */
  attach(request: { realm: RealmRef; consent_proof: ConsentProof }): Promise<THandle>;
  detach?(handle: THandle): Promise<void>;
}

/** Opaque token from the consent authority proving realm approval. */
export interface ConsentProof {
  subject: string;
  realm: RealmRef;
  approved_capabilities: ReadonlyArray<"observe" | "record" | "act">;
}

export class CapabilityMissingError extends Error {
  constructor(substrateKind: string, capability: string) {
    super(`substrate "${substrateKind}" does not provide capability "${capability}"`);
    this.name = "CapabilityMissingError";
  }
}

interface RegisteredAdapter {
  bundle: SubstrateAdapterBundle;
}

const registered = new Map<string, RegisteredAdapter>();

export function registerSubstrateAdapter(bundle: SubstrateAdapterBundle): void {
  if (!bundle.substrate_kind || bundle.substrate_kind.includes(" ")) {
    throw new Error(`invalid substrate kind "${bundle.substrate_kind}"`);
  }
  const existing = registered.get(bundle.substrate_kind);
  if (existing && existing.bundle !== bundle) {
    throw new Error(`substrate "${bundle.substrate_kind}" already registered`);
  }
  registered.set(bundle.substrate_kind, { bundle });
}

export function unregisterAllSubstrateAdapters(): void {
  registered.clear();
}

export function getAdapter(substrateKind: string): SubstrateAdapterBundle {
  const entry = registered.get(substrateKind);
  if (!entry) throw new Error(`no adapter registered for "${substrateKind}"`);
  return entry.bundle;
}

export function requireCapability<
  T,
>(
  substrateKind: string,
  pick: (bundle: SubstrateAdapterBundle) => T | undefined,
  capabilityName: string,
): T {
  const bundle = getAdapter(substrateKind);
  const capability = pick(bundle);
  if (!capability) throw new CapabilityMissingError(substrateKind, capabilityName);
  return capability;
}

/** Structural negotiation helpers used by downstream components. */
export function hasCapability(
  substrateKind: string,
  capability: "observer" | "actor" | "recorder" | "reset_provider" | "fork_provider" | "replay_provider",
): boolean {
  const bundle = registered.get(substrateKind)?.bundle;
  if (!bundle) return false;
  return Boolean(bundle[capability]);
}

export function listRegisteredSubstrates(): string[] {
  return [...registered.keys()].sort();
}

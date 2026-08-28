/**
 * Replay orchestration (plan Architecture Changes "replay.ts").
 *
 * Wraps a substrate's ReplayProviderCap with the shared pipeline rules:
 * - authorization first (fail-closed, human reasons),
 * - one load-delay retry for steps that failed on timing evidence,
 * - classification of every failure through the trunk taxonomy,
 * - a structured report the UI can render without jargon.
 */

import type { SessionHandle, TraceFragmentLike } from "./substrate.js";
import { authorizeRun, type CompetencyLicense } from "./governance.js";
import type { EntrustmentLevel } from "./governance.js";

export interface ReplayOrchestrationDeps {
  replay: (fragment: TraceFragmentLike, handle: SessionHandle) => Promise<{
    ok: boolean;
    step_results: Array<{ step_index: number; ok: boolean; classifier_trunk?: string; detail?: Record<string, unknown> }>;
    final_world_hash?: string;
  }>;
  /** Retry a single step index (used once per run for timing failures). */
  retryStep?: (fragment: TraceFragmentLike, handle: SessionHandle, stepIndex: number) => Promise<boolean>;
}

export interface OrchestratedStep {
  step_index: number;
  ok: boolean;
  classifier_trunk?: string;
  human_explanation?: string;
  retried?: boolean;
}

export interface OrchestratedReplayResult {
  authorized: boolean;
  refusal_reason?: string;
  ok: boolean;
  steps: OrchestratedStep[];
  final_world_hash?: string;
}

/** Trunks considered transient timing issues eligible for exactly one retry. */
const TIMING_TRUNK = "load_delay";

export async function orchestrateReplay(input: {
  deps: ReplayOrchestrationDeps;
  licenses: readonly CompetencyLicense[];
  competency_id: string;
  substrate_kind: string;
  realm: SessionHandle["realm"];
  required_level: EntrustmentLevel;
  now: number;
  fragment: TraceFragmentLike;
  handle: SessionHandle;
  explain: (stepIndex: number, trunk?: string) => string;
}): Promise<OrchestratedReplayResult> {
  // 1. Authorization is not optional.
  const decision = authorizeRun(input.licenses, {
    competency_id: input.competency_id,
    substrate_kind: input.substrate_kind,
    realm: input.realm,
    required_level: input.required_level,
    now: input.now,
  });
  if (!decision.authorized) {
    return {
      authorized: false,
      refusal_reason: decision.human_reason,
      ok: false,
      steps: [],
    };
  }

  // 2. Run the flow.
  const outcome = await input.deps.replay(input.fragment, input.handle);

  // 3. One retry for a single timing failure, when a retry hook exists.
  let retriedIndex = -1;
  const steps: OrchestratedStep[] = outcome.step_results.map((step) => ({
    step_index: step.step_index,
    ok: step.ok,
    ...(step.classifier_trunk ? { classifier_trunk: step.classifier_trunk } : {}),
  }));

  if (!outcome.ok && input.deps.retryStep) {
    const timingFailure = outcome.step_results.find(
      (step) => !step.ok && step.classifier_trunk === TIMING_TRUNK,
    );
    if (timingFailure && timingFailure.step_index >= 0) {
      const recovered = await input.deps.retryStep(input.fragment, input.handle, timingFailure.step_index);
      retriedIndex = timingFailure.step_index;
      if (recovered) {
        const target = steps[timingFailure.step_index] as OrchestratedStep;
        target.ok = true;
        delete target.classifier_trunk;
        target.retried = true;
      }
    }
  }

  const allOk = steps.every((step) => step.ok);
  return {
    authorized: true,
    ok: allOk,
    steps: steps.map((step) =>
      step.ok || !step.classifier_trunk
        ? step
        : { ...step, human_explanation: input.explain(step.step_index, step.classifier_trunk) },
    ),
    ...(outcome.final_world_hash !== undefined ? { final_world_hash: outcome.final_world_hash } : {}),
  };
}

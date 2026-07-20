import { session } from "../session.js";
import {
  classifyHmrMessage,
  type GpuProofTrustInvalidation,
  type HmrClassification,
  type HmrTerminalEvent,
} from "../hmr.js";
import {
  errorResponse,
  errorFromException,
  jsonResponse,
  type ToolResponse,
} from "./shared.js";
import {
  GPU_HMR_PROOF_STATES,
  gpuHmrProofMatches,
  gpuHmrProofStateRank,
  type GpuHmrProofMatchOpts,
  type GpuHmrProofValidation,
  isKnownGpuHmrProofState,
  validateGpuHmrProofState,
  type GpuHmrProofTelemetry,
} from "../gpu_proof.js";
import { buildGpuHmrFrameGateEvidenceBinding } from "../gpu_frame_gate_binding.js";

interface WaitHmrArgs {
  timeoutMs?: unknown;
  module?: unknown;
  since_ts?: unknown;
  sinceTs?: unknown;
  preview_id?: unknown;
  previewId?: unknown;
  requiredGpuProofState?: unknown;
  requireGpuFullRuntimeProof?: unknown;
}

const DEFAULT_TIMEOUT_MS = 20 * 60_000;
const POST_APPLY_OBSERVE_ENV = "SYNTHI_MCP_HMR_POST_APPLY_OBSERVE_MS";
const FRAME_GATE_POLL_MS = 50;
const DEV_LOOP_PROOF_STATUS_SCHEMA_VERSION = "synthi.gpu.hmr.dev_loop_proof_status.v1";
const STRICT_PROOF_WAIT_DECISION_SCHEMA_VERSION = "synthi.gpu.hmr.strict_proof_wait_decision.v1";
const STRUCTURAL_PROOF_GAP_REASONS = new Set([
  "unknown_result_proof_state",
  "unknown_degraded_proof_state",
  "degraded_state_blocks_required_proof",
  "proof_material_identity_unverifiable",
  "proof_stage_missing",
  "proof_stage_not_passed",
  "proof_ledger_missing",
  "proof_ledger_rejected",
  "runtime_proof_artifact_missing",
  "runtime_proof_artifact_rejected",
]);

function resolvePostApplyObserveMs(pipelineBudgetMs: number): number {
  const raw = process.env[POST_APPLY_OBSERVE_ENV];
  if (raw !== undefined) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return pipelineBudgetMs;
}

function terminalEventFromClassification(
  cls: HmrClassification,
  elapsedMs: number
): HmrTerminalEvent {
  return {
    status: cls.status,
    source: cls.source,
    elapsedMs,
    detail: cls.detail,
  };
}

function terminalEventFromGpuProof(
  proof: GpuHmrProofTelemetry,
  elapsedMs: number
): HmrTerminalEvent {
  return {
    status: "applied",
    source: "gpu_proof",
    elapsedMs,
    detail: {
      terminal_equivalent: "gpu_hmr_full_runtime_proof",
      proofRef: proof.proofRef,
      resultState: proof.resultState,
      source: proof.source,
    },
    observedAt: proof.observedAt,
  };
}

function requiredGpuProofState(args: WaitHmrArgs): string | null {
  if (args.requireGpuFullRuntimeProof === true) {
    return "gpu-hmr-full-runtime-proven";
  }
  if (typeof args.requiredGpuProofState !== "string" || !args.requiredGpuProofState.trim()) {
    return null;
  }
  return args.requiredGpuProofState.trim();
}

function latestGpuProofFromAttached(
  attached: ReturnType<typeof session.require>,
  opts: GpuHmrProofMatchOpts
): GpuHmrProofTelemetry | null {
  const hmr = attached.channels.hmr as {
    latestGpuProof?: (opts?: GpuHmrProofMatchOpts) => GpuHmrProofTelemetry | null;
  };
  const proof = hmr.latestGpuProof?.(opts) ?? null;
  return gpuHmrProofMatches(proof, opts) ? proof : null;
}

function gpuProofPayload(proof: GpuHmrProofTelemetry | null): Record<string, unknown> | null {
  if (proof === null) return null;
  return {
    schemaVersion: proof.schemaVersion,
    proofRef: proof.proofRef,
    proofIdPresent: proof.proofIdPresent,
    proofArtifactPresent: proof.proofArtifactPresent,
    resultState: proof.resultState,
    degradedState: proof.degradedState,
    source: proof.source,
    observedAt: proof.observedAt,
    ...(proof.parentControlVerificationMaterial === undefined
      ? {}
      : {
          parentControlVerificationMaterial:
            proof.parentControlVerificationMaterial,
        }),
  };
}

function strictProofStructuralGap(
  validation: GpuHmrProofValidation,
  requiredState: string
): string | null {
  if (validation.satisfied) return null;
  if (validation.reason === undefined) return null;
  if (!STRUCTURAL_PROOF_GAP_REASONS.has(validation.reason)) return null;
  if (validation.reason === "proof_state_missing" || validation.reason === "proof_state_below_required") {
    return null;
  }
  if (
    validation.reason === "proof_ledger_missing"
    || validation.reason === "proof_ledger_rejected"
    || validation.reason === "runtime_proof_artifact_missing"
    || validation.reason === "runtime_proof_artifact_rejected"
  ) {
    return validation.resultRank >= gpuHmrProofStateRank(requiredState)
      ? validation.reason
      : null;
  }
  return validation.reason;
}

function proofWaitDecisionPayload(
  proof: GpuHmrProofTelemetry | null,
  validation: GpuHmrProofValidation,
  reason: string,
  elapsedMs: number,
  timeoutMs: number,
  hmrObservedAt: number | null
): Record<string, unknown> {
  const failedRuntimeProofArtifactGates =
    validation.runtimeProofArtifactValidation?.failedGates?.map((gate) => gate.code) ?? [];
  const failedLedgerInvariants =
    validation.proofLedgerValidation?.failedInvariants?.map((failure) => failure.code) ?? [];
  return {
    schemaVersion: STRICT_PROOF_WAIT_DECISION_SCHEMA_VERSION,
    decision: "fail_fast_structural_gap",
    reason,
    evidence_authority: "strict_proof_wait_timeout_intelligence_not_gpu_hmr_acceptance",
    accepted_for_gpu_hmr: false,
    gpu_hmr_success: false,
    required_state: validation.requiredState,
    result_state: validation.resultState,
    degraded_state: validation.degradedState,
    result_rank: validation.resultRank,
    effective_result_rank: validation.effectiveResultRank,
    required_rank: validation.requiredRank,
    proof_ref: proof?.proofRef ?? null,
    proof_artifact_present: proof?.proofArtifactPresent ?? false,
    hmr_observed_at: hmrObservedAt,
    proof_observed_at: proof?.observedAt ?? null,
    elapsed_ms: elapsedMs,
    timeout_ms: timeoutMs,
    remaining_timeout_ms: Math.max(0, timeoutMs - elapsedMs),
    failed_runtime_proof_artifact_gates: failedRuntimeProofArtifactGates,
    failed_ledger_invariants: failedLedgerInvariants,
    basis: [
      "observed_gpu_proof_validation_failed",
      `reason:${reason}`,
      "strict_wait_can_fail_closed_without_waiting_for_timeout",
    ],
  };
}

function attachDevLoopProofPendingStatus(
  payload: Record<string, unknown>,
  proof: GpuHmrProofTelemetry | null,
  requiredState: string | null
): void {
  if (requiredState !== null || payload.status !== "applied") return;
  payload.proof_pending = true;
  payload.proof_status = "hmr_applied_proof_pending";
  payload.gpu_hmr_dev_loop = {
    schemaVersion: DEV_LOOP_PROOF_STATUS_SCHEMA_VERSION,
    mode: "non_blocking_dev_loop",
    hmr_fast_path_status: "applied",
    proof_pending: true,
    strict_ledger_validation_requested: false,
    accepted_for_gpu_hmr: false,
    gpu_hmr_success: false,
    evidence_authority: "hmr_fast_path_only_not_gpu_hmr_acceptance",
    reason: proof === null ? "proof_telemetry_missing" : "strict_proof_state_not_requested",
    latest_proof_state: proof?.resultState ?? null,
    latest_degraded_state: proof?.degradedState ?? null,
    latest_proof_rank: proof === null ? 0 : gpuHmrProofStateRank(proof.resultState),
    next_strict_proof_state: "gpu-hmr-full-runtime-proven",
  };
}

async function waitForDecodedFrameAtOrAfter(
  attached: ReturnType<typeof session.require>,
  minTsMs: number,
  timeoutMs: number,
  shouldAbort: () => boolean = () => false,
): Promise<{ frame_seq: number; ts_ms: number } | null> {
  const start = Date.now();
  for (;;) {
    if (shouldAbort()) return null;
    try {
      const frame = await attached.frames.getFrame();
      if (frame.ts >= minTsMs) {
        return { frame_seq: frame.seq, ts_ms: frame.ts };
      }
    } catch {
      // No decoded frame yet. Keep polling until the caller's wait budget expires.
    }
    if (shouldAbort()) return null;
    if (Date.now() - start >= timeoutMs) return null;
    const remaining = Math.max(0, timeoutMs - (Date.now() - start));
    await new Promise((resolve) => setTimeout(resolve, Math.min(FRAME_GATE_POLL_MS, remaining)));
  }
}

interface FrameGateObservation {
  frame_seq: number;
  ts_ms: number;
}

function issueFrameGateCaptureToken(input: {
  attached: ReturnType<typeof session.require>;
  frameGate: Record<string, unknown>;
  observation: FrameGateObservation;
  proof: GpuHmrProofTelemetry | null;
  requiredProofState: string | null;
  hmrObservedAtMs: number;
  proofMatchOpts: GpuHmrProofMatchOpts;
}): void {
  const requiresFullRuntimeBinding = input.requiredProofState !== null
    && gpuHmrProofStateRank(input.requiredProofState)
      >= gpuHmrProofStateRank("gpu-hmr-full-runtime-proven");
  let evidenceBinding: Readonly<Record<string, unknown>> | undefined;

  if (requiresFullRuntimeBinding) {
    const bindingResult = buildGpuHmrFrameGateEvidenceBinding({
      proof: input.proof,
      hmrObservedAtMs: input.hmrObservedAtMs,
      frameObservedAtMs: input.observation.ts_ms,
      proofMatchScope: {
        module: input.proofMatchOpts.module ?? null,
        preview_id: input.proofMatchOpts.previewId ?? null,
        proof_since_ts_ms: input.proofMatchOpts.sinceTs ?? null,
      },
    });
    if (!bindingResult.accepted || bindingResult.binding === null) {
      input.frameGate["runtime_binding_status"] = "unavailable";
      input.frameGate["capture_binding_ready"] = false;
      input.frameGate["runtime_binding_failure_codes"] = bindingResult.failures
        .map((failure) => failure.code);
      input.frameGate["capture_binding_authority"] =
        "frame_observation_without_runtime_binding_not_gpu_hmr_visual_proof";
      return;
    }
    evidenceBinding = bindingResult.binding;
  }

  const gateToken = session.issueFrameGateToken({
    session_id: input.attached.sessionId,
    frame_seq: input.observation.frame_seq,
    ts_ms: input.observation.ts_ms,
    ...(evidenceBinding !== undefined ? { evidence_binding: evidenceBinding } : {}),
  });
  input.frameGate["gate_token"] = gateToken.token;
  input.frameGate["gate_token_issued_at_ms"] = gateToken.issued_at_ms;
  input.frameGate["gate_token_expires_at_ms"] = gateToken.expires_at_ms;
  input.frameGate["capture_binding_ready"] = true;
  if (evidenceBinding !== undefined) {
    input.frameGate["runtime_binding_status"] = "bound";
    input.frameGate["evidence_binding_hash"] = gateToken.evidence_binding_hash;
    input.frameGate["evidence_binding_schema_version"] = evidenceBinding["schema_version"];
    input.frameGate["runtime_proof_ref"] = evidenceBinding["runtime_proof_ref"];
    input.frameGate["capture_binding_authority"] =
      "runtime_bound_frame_gate_token_only_not_gpu_hmr_success";
  } else {
    input.frameGate["runtime_binding_status"] = "not_requested";
    input.frameGate["capture_binding_authority"] =
      "legacy_frame_gate_token_only_not_gpu_hmr_visual_proof";
  }
}

function validateGpuHmrProofAtOrAfter(
  proof: GpuHmrProofTelemetry | null,
  requiredState: string,
  minProofObservedAt?: number,
): GpuHmrProofValidation {
  const validation = validateGpuHmrProofState(proof, requiredState);
  if (
    validation.satisfied
    && minProofObservedAt !== undefined
    && (proof === null || proof.observedAt < minProofObservedAt)
  ) {
    return {
      ...validation,
      satisfied: false,
      reason: "proof_observed_before_required_boundary",
    };
  }
  return validation;
}

function responseWithGpuProofValidation(
  payload: Record<string, unknown>,
  proof: GpuHmrProofTelemetry | null,
  requiredState: string | null,
  minProofObservedAt?: number,
): ToolResponse {
  attachDevLoopProofPendingStatus(payload, proof, requiredState);
  if (proof !== null) {
    payload.gpu_proof_telemetry = gpuProofPayload(proof);
  }
  if (requiredState === null) {
    if (proof !== null) {
      payload.gpu_proof_validation = {
        validated: false,
        satisfied: false,
        reason: "proof_state_not_requested",
      };
    }
    return jsonResponse(payload);
  }
  if (!isKnownGpuHmrProofState(requiredState)) {
    return errorResponse("invalid_gpu_hmr_required_proof_state", {
      requiredGpuProofState: requiredState,
      allowed: GPU_HMR_PROOF_STATES,
    });
  }

  const validation = validateGpuHmrProofAtOrAfter(
    proof,
    requiredState,
    minProofObservedAt,
  );
  payload.gpu_proof_validation = validation;
  if (validation.proofLedgerValidation !== undefined) {
    payload.gpu_proof_ledger_validation = validation.proofLedgerValidation;
  }
  if (!validation.satisfied) {
    return errorResponse("gpu_hmr_proof_insufficient", payload);
  }
  if (proof !== null) {
    payload.gpu_proof = gpuProofPayload(proof);
  }
  return jsonResponse(payload);
}

export async function waitHmrTool(args: unknown): Promise<ToolResponse> {
  const a = (args ?? {}) as WaitHmrArgs;
  const timeoutMs =
    typeof a.timeoutMs === "number" && a.timeoutMs > 0
      ? a.timeoutMs
      : DEFAULT_TIMEOUT_MS;
  const module = typeof a.module === "string" && a.module.trim() ? a.module.trim() : undefined;
  const sinceTsValue = a.since_ts ?? a.sinceTs;
  if (sinceTsValue !== undefined && (typeof sinceTsValue !== "number" || !Number.isFinite(sinceTsValue) || sinceTsValue < 0)) {
    return errorResponse("invalid_args", {
      field: a.since_ts !== undefined ? "since_ts" : "sinceTs",
      expected: "non-negative ms epoch timestamp",
    });
  }
  const sinceTs = typeof sinceTsValue === "number" ? sinceTsValue : undefined;
  const previewIdValue = a.preview_id ?? a.previewId;
  if (previewIdValue !== undefined && typeof previewIdValue !== "string") {
    return errorResponse("invalid_args", {
      field: a.preview_id !== undefined ? "preview_id" : "previewId",
      expected: "string",
    });
  }
  const previewId = typeof previewIdValue === "string" && previewIdValue.trim()
    ? previewIdValue.trim()
    : undefined;
    const requiredProofState = requiredGpuProofState(a);
    const proofCanSatisfyTerminal = requiredProofState !== null
      && gpuHmrProofStateRank(requiredProofState) >= gpuHmrProofStateRank("gpu-hmr-full-runtime-proven");
    const waitContract: Record<string, unknown> = {
    timeout_ms: timeoutMs,
    module: module ?? null,
    since_ts: sinceTs ?? null,
    preview_id: previewId ?? null,
    required_gpu_proof_state: requiredProofState,
    require_gpu_full_runtime_proof: a.requireGpuFullRuntimeProof === true,
  };
  const unsubscribePostApply: Array<() => void> = [];
  let terminalWaitAbort: AbortController | null = null;

  try {
    const start = Date.now();
    const attached = session.require();
    const proofSinceTs = sinceTs ?? start;
    const proofMatchOpts: GpuHmrProofMatchOpts = {
      sinceTs: proofSinceTs,
      ...(module ? { module } : {}),
      ...(previewId ? { previewId } : {}),
    };
    waitContract.proof_since_ts = proofSinceTs;
    let latestGpuProof = latestGpuProofFromAttached(attached, proofMatchOpts);
    let satisfyingGpuProof: GpuHmrProofTelemetry | null = null;
    let sawAppliedTerminal = false;
    let postApplyTerminal: HmrClassification | null = null;
    let notifyPostApplyTerminal: (() => void) | null = null;
    let notifyRequiredProof: (() => void) | null = null;
    let proofTrustInvalidation: GpuProofTrustInvalidation | null = null;
    let resolveProofTrustInvalidation:
      ((event: GpuProofTrustInvalidation) => void) | null = null;
    const proofTrustInvalidationSignal = new Promise<GpuProofTrustInvalidation>((resolve) => {
      resolveProofTrustInvalidation = resolve;
    });
    const satisfyingRequiredProof = (
      minObservedAt?: number,
    ): GpuHmrProofTelemetry | null => {
      if (proofTrustInvalidation !== null || requiredProofState === null) return null;
      if (
        satisfyingGpuProof !== null
        && validateGpuHmrProofAtOrAfter(
          satisfyingGpuProof,
          requiredProofState,
          minObservedAt,
        ).satisfied
      ) {
        return satisfyingGpuProof;
      }

      satisfyingGpuProof = null;
      const candidate = latestGpuProof;
      if (
        candidate !== null
        && validateGpuHmrProofAtOrAfter(
          candidate,
          requiredProofState,
          minObservedAt,
        ).satisfied
      ) {
        satisfyingGpuProof = candidate;
      }
      return satisfyingGpuProof;
    };
    const requiredProofSatisfied = (minObservedAt?: number): boolean =>
      satisfyingRequiredProof(minObservedAt) !== null;
    const gpuProofForCurrentWait = (): GpuHmrProofTelemetry | null =>
      satisfyingGpuProof ?? latestGpuProof;
    const requiredProofStructuralGap = (minObservedAt?: number): string | null => {
      if (requiredProofState === null || proofTrustInvalidation !== null) return null;
      if (
        minObservedAt !== undefined
        && latestGpuProof !== null
        && latestGpuProof.observedAt < minObservedAt
      ) {
        return null;
      }
      return strictProofStructuralGap(
        validateGpuHmrProofState(latestGpuProof, requiredProofState),
        requiredProofState
      );
    };
    const proofChannel = attached.channels.hmr as typeof attached.channels.hmr & {
      onGpuProof: (
        opts: GpuHmrProofMatchOpts,
        cb: (proof: GpuHmrProofTelemetry) => void
      ) => () => void;
    };
    unsubscribePostApply.push(proofChannel.onGpuProofTrustInvalidated((event) => {
      if (proofTrustInvalidation !== null) return;
      proofTrustInvalidation = event;
      latestGpuProof = null;
      satisfyingGpuProof = null;
      resolveProofTrustInvalidation?.(event);
      resolveProofTrustInvalidation = null;
      notifyRequiredProof?.();
      notifyPostApplyTerminal?.();
    }));
    unsubscribePostApply.push(proofChannel.onGpuProof(proofMatchOpts, (proof) => {
      if (proofTrustInvalidation !== null) return;
      latestGpuProof = proof;
      notifyRequiredProof?.();
    }));
    unsubscribePostApply.push(attached.channels.hmr.onMessage((msg) => {
      const cls = classifyHmrMessage(msg);
      if (!cls) return;
      if (cls.status === "applied") {
        sawAppliedTerminal = true;
        return;
      }
      if (!sawAppliedTerminal || postApplyTerminal) return;
      postApplyTerminal = cls;
      notifyPostApplyTerminal?.();
      notifyRequiredProof?.();
    }));

    const waitForPostApplyTerminal = (
      timeoutMs: number
    ): { promise: Promise<HmrClassification | null>; cancel: () => void } => {
      if (postApplyTerminal) {
        return { promise: Promise.resolve(postApplyTerminal), cancel: () => {} };
      }
      if (timeoutMs <= 0) {
        return { promise: Promise.resolve(null), cancel: () => {} };
      }
      let cancel = (): void => {};
      const promise = new Promise<HmrClassification | null>((resolve) => {
        let settled = false;
        const settle = (value: HmrClassification | null): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (notifyPostApplyTerminal === onTerminal) notifyPostApplyTerminal = null;
          resolve(value);
        };
        const onTerminal = (): void => settle(postApplyTerminal);
        notifyPostApplyTerminal = onTerminal;
        const timer = setTimeout(() => settle(null), timeoutMs);
        cancel = (): void => settle(null);
      });
      return { promise, cancel };
    };

    const proofTrustInvalidationResponse = (stage: string): ToolResponse | null => {
      const invalidation = proofTrustInvalidation;
      if (requiredProofState === null || invalidation === null) return null;
      const elapsedMs = Date.now() - start;
      return responseWithGpuProofValidation({
        status: "rejected",
        elapsedMs,
        source: "gpu_proof",
        detail: {
          reason: "gpu_proof_trust_invalidated",
          invalidation_stage: stage,
        },
        wait_contract: waitContract,
        proof_wait_decision: "fail_fast_trust_invalidated",
        gpu_proof_wait: {
          status: "failed_fast",
          reason: "gpu_proof_trust_invalidated",
          invalidation_stage: stage,
          required_gpu_proof_state: requiredProofState,
          accepted_for_gpu_hmr: false,
          gpu_hmr_success: false,
        },
        gpu_proof_trust_invalidation: {
          schema_version: invalidation.schemaVersion,
          evidence_authority: invalidation.proofAuthority,
          reason_class: invalidation.reasonClass,
          invalidated_at: invalidation.invalidatedAt,
          accepted_for_gpu_hmr: false,
          gpu_hmr_success: false,
          can_satisfy_runtime_proof: false,
        },
      }, null, requiredProofState);
    };

    const raceWithProofTrustInvalidation = async <T>(
      work: Promise<T>,
    ): Promise<
      | { kind: "value"; value: T }
      | { kind: "proof_trust_invalidated"; event: GpuProofTrustInvalidation }
    > => {
      if (requiredProofState === null) {
        return { kind: "value", value: await work };
      }
      if (proofTrustInvalidation !== null) {
        return { kind: "proof_trust_invalidated", event: proofTrustInvalidation };
      }
      return Promise.race([
        work.then((value) => ({ kind: "value" as const, value })),
        proofTrustInvalidationSignal.then((event) => ({
          kind: "proof_trust_invalidated" as const,
          event,
        })),
      ]);
    };

    const waitForRequiredGpuProof = (
      timeoutMs: number,
      opts: { settleOnTerminal?: boolean; allowStructuralGap?: boolean; minProofObservedAt?: number } = {}
    ): {
      promise: Promise<
        "satisfied" | "terminal" | "structural_gap" | "proof_trust_invalidated" | "timeout"
      >;
      cancel: () => void;
    } => {
      const settleOnTerminal = opts.settleOnTerminal !== false;
      const allowStructuralGap = opts.allowStructuralGap === true;
      if (proofTrustInvalidation !== null) {
        return { promise: Promise.resolve("proof_trust_invalidated"), cancel: () => {} };
      }
      if (requiredProofState === null || requiredProofSatisfied(opts.minProofObservedAt)) {
        return { promise: Promise.resolve("satisfied"), cancel: () => {} };
      }
      if (allowStructuralGap && requiredProofStructuralGap(opts.minProofObservedAt) !== null) {
        return { promise: Promise.resolve("structural_gap"), cancel: () => {} };
      }
      if (settleOnTerminal && postApplyTerminal) {
        return { promise: Promise.resolve("terminal"), cancel: () => {} };
      }
      if (timeoutMs <= 0) {
        return { promise: Promise.resolve("timeout"), cancel: () => {} };
      }
      let cancel = (): void => {};
      type ProofWaitOutcome =
        | "satisfied"
        | "terminal"
        | "structural_gap"
        | "proof_trust_invalidated"
        | "timeout";
      const promise = new Promise<ProofWaitOutcome>((resolve) => {
        let settled = false;
        const settle = (value: ProofWaitOutcome): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (notifyRequiredProof === onProofOrTerminal) notifyRequiredProof = null;
          resolve(value);
        };
        const onProofOrTerminal = (): void => {
          if (proofTrustInvalidation !== null) {
            settle("proof_trust_invalidated");
          } else if (requiredProofSatisfied(opts.minProofObservedAt)) {
            settle("satisfied");
          } else if (allowStructuralGap && requiredProofStructuralGap(opts.minProofObservedAt) !== null) {
            settle("structural_gap");
          } else if (settleOnTerminal && postApplyTerminal) {
            settle("terminal");
          }
        };
        notifyRequiredProof = onProofOrTerminal;
        const timer = setTimeout(() => settle("timeout"), timeoutMs);
        cancel = (): void => settle("timeout");
      });
      return { promise, cancel };
    };

    const structuralGapResponse = (hmrObservedAt: number | null = null): ToolResponse | null => {
      if (requiredProofState === null) return null;
      const validation = validateGpuHmrProofState(latestGpuProof, requiredProofState);
      const reason = strictProofStructuralGap(validation, requiredProofState);
      if (reason === null) return null;
      const elapsedMs = Date.now() - start;
      const decision = proofWaitDecisionPayload(
        latestGpuProof,
        validation,
        reason,
        elapsedMs,
        timeoutMs,
        hmrObservedAt
      );
      return responseWithGpuProofValidation({
        status: "applied",
        elapsedMs,
        source: "gpu_proof",
        detail: {
          reason: "strict_gpu_hmr_proof_structural_gap",
          proof_wait_reason: reason,
        },
        wait_contract: waitContract,
        proof_wait_decision: "fail_fast_structural_gap",
        gpu_proof_wait: {
          status: "failed_fast",
          reason: "post_apply_gpu_proof_insufficient",
          validation_reason: reason,
          required_gpu_proof_state: validation.requiredState,
          latest_proof_state: validation.resultState,
          hmr_observed_at: hmrObservedAt,
          proof_observed_at: latestGpuProof?.observedAt ?? null,
          accepted_for_gpu_hmr: false,
          gpu_hmr_success: false,
        },
        proof_wait_timeout_intelligence: decision,
      }, latestGpuProof, requiredProofState, hmrObservedAt ?? undefined);
    };

    terminalWaitAbort = new AbortController();
    const terminalWait = attached.channels.hmr.waitForTerminal({
      timeoutMs,
      module,
      sinceTs,
      previewId,
      signal: terminalWaitAbort.signal,
    });
    let result: HmrTerminalEvent;
    if (proofCanSatisfyTerminal) {
      const proofWait = waitForRequiredGpuProof(timeoutMs);
      const outcome = await Promise.race([
        terminalWait.then((terminal) => ({ kind: "terminal" as const, terminal })),
        proofWait.promise.then((proofStatus) => ({ kind: "proof" as const, proofStatus })),
      ]);
      proofWait.cancel();
      if (outcome.kind === "proof" && outcome.proofStatus === "proof_trust_invalidated") {
        return proofTrustInvalidationResponse("terminal_or_proof_wait")!;
      }
      const terminalSatisfyingProof = satisfyingGpuProof;
      if (
        outcome.kind === "proof"
        && outcome.proofStatus === "satisfied"
        && terminalSatisfyingProof !== null
      ) {
        result = terminalEventFromGpuProof(terminalSatisfyingProof, Date.now() - start);
      } else {
        result = outcome.kind === "terminal"
          ? outcome.terminal
          : await terminalWait;
        if (result.status !== "applied" && requiredProofState !== null) {
          const remaining = Math.max(0, timeoutMs - (Date.now() - start));
          const lateProofWait = waitForRequiredGpuProof(remaining, { settleOnTerminal: false });
          const lateProofOutcome = await lateProofWait.promise;
          lateProofWait.cancel();
          if (lateProofOutcome === "proof_trust_invalidated") {
            return proofTrustInvalidationResponse("late_proof_wait")!;
          }
          const lateSatisfyingProof = satisfyingGpuProof;
          if (lateProofOutcome === "satisfied" && lateSatisfyingProof !== null) {
            result = terminalEventFromGpuProof(lateSatisfyingProof, Date.now() - start);
          }
        }
      }
    } else {
      const terminalOutcome = await raceWithProofTrustInvalidation(terminalWait);
      if (terminalOutcome.kind === "proof_trust_invalidated") {
        return proofTrustInvalidationResponse("terminal_wait")!;
      }
      result = terminalOutcome.value;
    }
    const postTerminalTrustFailure = proofTrustInvalidationResponse("terminal_resolved");
    if (postTerminalTrustFailure !== null) return postTerminalTrustFailure;
    let frameGate: Record<string, unknown> | undefined;
    let frameGateObservation: FrameGateObservation | null = null;
    let hmrObservedAtForFrameGate: number | null = null;

    if (result.status === "applied") {
      const tHmr = result.observedAt ?? Date.now();
      hmrObservedAtForFrameGate = tHmr;
      const budget = session.pipelineBudgetMs();
      const remaining = Math.max(0, timeoutMs - (Date.now() - start));
      if (session.frameSeqGateEnabled()) {
        const postApplyWait = waitForPostApplyTerminal(remaining);
        const frameOrTerminalOutcome = await raceWithProofTrustInvalidation(
          Promise.race([
            session
              .awaitFrameAdvanceAtOrAfter(
                tHmr + budget,
                remaining,
                terminalWaitAbort.signal,
              )
              .then((satisfiedBy) => ({ kind: "frame" as const, satisfiedBy })),
            postApplyWait.promise.then((terminal) => ({
              kind: "terminal" as const,
              terminal,
            })),
          ]),
        );
        postApplyWait.cancel();
        if (frameOrTerminalOutcome.kind === "proof_trust_invalidated") {
          return proofTrustInvalidationResponse("frame_gate_wait")!;
        }
        const outcome = frameOrTerminalOutcome.value;
        if (outcome.kind === "terminal" && outcome.terminal) {
          const late = terminalEventFromClassification(outcome.terminal, Date.now() - start);
          return responseWithGpuProofValidation({
            status: late.status,
            elapsedMs: Date.now() - start,
            hmrElapsedMs: late.elapsedMs,
            source: late.source,
            detail: late.detail ?? null,
            post_apply_terminal: true,
            wait_contract: waitContract,
          }, gpuProofForCurrentWait(), requiredProofState);
        }
        if (outcome.kind === "terminal") {
          frameGate = {
            status: "timeout",
            pipeline_budget_ms: budget,
            note: "no post-budget frame_advance observed; screenshot may reflect pre-reload frame",
          };
        }
        if (outcome.kind === "frame") {
          const satisfiedBy = outcome.satisfiedBy;
          frameGateObservation = satisfiedBy;
          frameGate = satisfiedBy
            ? {
                status: "satisfied",
                frame_seq: satisfiedBy.frame_seq,
                ts_ms: satisfiedBy.ts_ms,
                session_id: attached.sessionId,
                capture_binding_required: true,
                pipeline_budget_ms: budget,
              }
            : {
                status: "timeout",
                pipeline_budget_ms: budget,
                note: "no post-budget frame_advance observed; screenshot may reflect pre-reload frame",
              };
        }
      } else {
        const observeMs = Math.min(resolvePostApplyObserveMs(budget), remaining);
        const decodedWaitMs = remaining;
        const decodedFrameWait = waitForDecodedFrameAtOrAfter(
          attached,
          tHmr + budget,
          decodedWaitMs,
          () => requiredProofState !== null && proofTrustInvalidation !== null,
        );
        const lateTerminalWait = waitForPostApplyTerminal(observeMs);
        type DecodedFrameOutcome = {
          kind: "decoded_frame";
          satisfiedBy: { frame_seq: number; ts_ms: number } | null;
        };
        type TerminalOutcome = {
          kind: "terminal";
          terminal: HmrClassification;
        };
        const decodedFrameOutcome: Promise<DecodedFrameOutcome> = decodedFrameWait.then((satisfiedBy) => ({
          kind: "decoded_frame" as const,
          satisfiedBy,
        }));
        const terminalOutcome: Promise<TerminalOutcome | DecodedFrameOutcome> = (async () => {
          const terminal = await lateTerminalWait.promise;
          return terminal
            ? { kind: "terminal" as const, terminal }
            : decodedFrameOutcome;
        })();
        const decodedOrTerminalOutcome = await raceWithProofTrustInvalidation(
          Promise.race<DecodedFrameOutcome | TerminalOutcome>([
            decodedFrameOutcome,
            terminalOutcome,
          ]),
        );
        lateTerminalWait.cancel();
        if (decodedOrTerminalOutcome.kind === "proof_trust_invalidated") {
          return proofTrustInvalidationResponse("decoded_frame_gate_wait")!;
        }
        const outcome = decodedOrTerminalOutcome.value;
        if (outcome.kind === "terminal" && outcome.terminal) {
          const lateTerminal = outcome.terminal;
          const late = terminalEventFromClassification(lateTerminal, Date.now() - start);
          return responseWithGpuProofValidation({
            status: late.status,
            elapsedMs: Date.now() - start,
            hmrElapsedMs: late.elapsedMs,
            source: late.source,
            detail: late.detail ?? null,
            post_apply_terminal: true,
            wait_contract: waitContract,
          }, gpuProofForCurrentWait(), requiredProofState);
        }
        const satisfiedBy = outcome.kind === "decoded_frame" ? outcome.satisfiedBy : null;
        frameGateObservation = satisfiedBy;
        frameGate = satisfiedBy
          ? {
              status: "satisfied",
              frame_seq: satisfiedBy.frame_seq,
              ts_ms: satisfiedBy.ts_ms,
              session_id: attached.sessionId,
              capture_binding_required: true,
              capture_binding_source: "decoded_frame",
              pipeline_budget_ms: budget,
              frame_advance_fallback_used: true,
            }
          : {
              status: "timeout",
              reason: "decoded_frame_gate_timeout",
              note: "no post-budget decoded frame observed and frame_advance telemetry was unavailable",
              pipeline_budget_ms: budget,
              post_apply_observe_ms: observeMs,
              frame_gate_timeout_ms: decodedWaitMs,
            };
      }
    }

    const preTokenTrustFailure = proofTrustInvalidationResponse("before_frame_token");
    if (preTokenTrustFailure !== null) return preTokenTrustFailure;

    if (
      result.status === "applied"
      && requiredProofState !== null
      && !requiredProofSatisfied(hmrObservedAtForFrameGate ?? undefined)
    ) {
      const remaining = Math.max(0, timeoutMs - (Date.now() - start));
      const hmrObservedAtForProofWait = hmrObservedAtForFrameGate ?? result.observedAt ?? start;
      const proofWait = waitForRequiredGpuProof(remaining, {
        allowStructuralGap: true,
        minProofObservedAt: hmrObservedAtForProofWait,
      });
      const proofOutcome = await proofWait.promise;
      proofWait.cancel();
      if (proofOutcome === "proof_trust_invalidated") {
        return proofTrustInvalidationResponse("post_apply_proof_wait")!;
      }
      if (proofOutcome === "structural_gap") {
        const gap = structuralGapResponse(hmrObservedAtForProofWait);
        if (gap !== null) return gap;
      }
      if (proofOutcome === "terminal" && postApplyTerminal) {
        const late = terminalEventFromClassification(postApplyTerminal, Date.now() - start);
        return responseWithGpuProofValidation({
          status: late.status,
          elapsedMs: Date.now() - start,
          hmrElapsedMs: late.elapsedMs,
          source: late.source,
          detail: late.detail ?? null,
          post_apply_terminal: true,
          wait_contract: waitContract,
          ...(frameGate !== undefined ? { frame_gate: frameGate } : {}),
        }, gpuProofForCurrentWait(), requiredProofState);
      }
    }

    const requiresFullRuntimeFrameBinding = requiredProofState !== null
      && gpuHmrProofStateRank(requiredProofState)
        >= gpuHmrProofStateRank("gpu-hmr-full-runtime-proven");
    const frameBindingGpuProof = gpuProofForCurrentWait();
    if (
      result.status === "applied"
      && requiresFullRuntimeFrameBinding
      && frameGate !== undefined
      && frameGateObservation !== null
      && frameBindingGpuProof !== null
      && frameGateObservation.ts_ms < frameBindingGpuProof.observedAt
    ) {
      const remaining = Math.max(0, timeoutMs - (Date.now() - start));
      const minFrameObservedAt = Math.max(
        frameBindingGpuProof.observedAt,
        (hmrObservedAtForFrameGate ?? frameBindingGpuProof.observedAt) + session.pipelineBudgetMs(),
      );
      const postProofObservationOutcome = await raceWithProofTrustInvalidation(
        session.frameSeqGateEnabled()
          ? session.awaitFrameAdvanceAtOrAfter(
              minFrameObservedAt,
              remaining,
              terminalWaitAbort.signal,
            )
          : waitForDecodedFrameAtOrAfter(
              attached,
              minFrameObservedAt,
              remaining,
              () => requiredProofState !== null && proofTrustInvalidation !== null,
            ),
      );
      if (postProofObservationOutcome.kind === "proof_trust_invalidated") {
        return proofTrustInvalidationResponse("post_proof_frame_reacquisition")!;
      }
      const postProofObservation = postProofObservationOutcome.value;
      if (postProofObservation === null) {
        frameGate["runtime_binding_status"] = "unavailable";
        frameGate["capture_binding_ready"] = false;
        frameGate["runtime_binding_failure_codes"] = [
          "post_proof_frame_observation_missing",
        ];
        frameGate["capture_binding_authority"] =
          "pre_proof_frame_observation_not_gpu_hmr_visual_proof";
        frameGateObservation = null;
      } else {
        frameGateObservation = postProofObservation;
        frameGate["frame_seq"] = postProofObservation.frame_seq;
        frameGate["ts_ms"] = postProofObservation.ts_ms;
        frameGate["capture_reacquired_after_proof"] = true;
        frameGate["proof_observed_at_ms"] = frameBindingGpuProof.observedAt;
      }
    }

    if (
      result.status === "applied"
      && frameGate !== undefined
      && frameGateObservation !== null
      && hmrObservedAtForFrameGate !== null
      && (requiredProofState === null || isKnownGpuHmrProofState(requiredProofState))
    ) {
      issueFrameGateCaptureToken({
        attached,
        frameGate,
        observation: frameGateObservation,
        proof: gpuProofForCurrentWait(),
        requiredProofState,
        hmrObservedAtMs: hmrObservedAtForFrameGate,
        proofMatchOpts,
      });
    }

    const postTokenTrustFailure = proofTrustInvalidationResponse("after_frame_token");
    if (postTokenTrustFailure !== null) return postTokenTrustFailure;

    return responseWithGpuProofValidation({
      status: result.status,
      elapsedMs: Date.now() - start,
      hmrElapsedMs: result.elapsedMs,
      source: result.source,
      detail: result.detail ?? null,
      wait_contract: waitContract,
      ...(result.observedAt !== undefined ? { hmrObservedAt: result.observedAt } : {}),
      ...(result.retained ? {
        terminal_recovered_from: "hmr_terminal_history",
        terminal_sequence: result.sequence ?? null,
      } : {}),
      ...(frameGate !== undefined ? { frame_gate: frameGate } : {}),
    }, gpuProofForCurrentWait(), requiredProofState, result.status === "applied"
      ? hmrObservedAtForFrameGate ?? undefined
      : undefined);
  } catch (err) {
    return errorFromException("wait_hmr_failed", err);
  } finally {
    terminalWaitAbort?.abort();
    for (const unsubscribe of unsubscribePostApply) unsubscribe();
  }
}

import { session } from "../session.js";
import {
  classifyHmrMessage,
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
  classifyGpuHmrProofMessage,
  gpuHmrProofMatches,
  type GpuHmrProofMatchOpts,
  isKnownGpuHmrProofState,
  validateGpuHmrProofState,
  type GpuHmrProofTelemetry,
} from "../gpu_proof.js";

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

const DEFAULT_TIMEOUT_MS = 60_000;
const POST_APPLY_OBSERVE_ENV = "SYNTHI_MCP_HMR_POST_APPLY_OBSERVE_MS";

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
    proofId: proof.proofId,
    proofArtifactPath: proof.proofArtifactPath,
    resultState: proof.resultState,
    degradedState: proof.degradedState,
    degradedReason: proof.degradedReason,
    label: proof.label,
    source: proof.source,
    observedAt: proof.observedAt,
  };
}

function responseWithGpuProofValidation(
  payload: Record<string, unknown>,
  proof: GpuHmrProofTelemetry | null,
  requiredState: string | null
): ToolResponse {
  if (proof !== null) {
    payload.gpu_proof = gpuProofPayload(proof);
  }
  if (requiredState === null) {
    return jsonResponse(payload);
  }
  if (!isKnownGpuHmrProofState(requiredState)) {
    return errorResponse("invalid_gpu_hmr_required_proof_state", {
      requiredGpuProofState: requiredState,
      allowed: GPU_HMR_PROOF_STATES,
    });
  }

  const validation = validateGpuHmrProofState(proof, requiredState);
  payload.gpu_proof_validation = validation;
  if (!validation.satisfied) {
    return errorResponse("gpu_hmr_proof_insufficient", payload);
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
  const waitContract = {
    timeout_ms: timeoutMs,
    module: module ?? null,
    since_ts: sinceTs ?? null,
    preview_id: previewId ?? null,
    required_gpu_proof_state: requiredProofState,
    require_gpu_full_runtime_proof: a.requireGpuFullRuntimeProof === true,
  };
  let unsubscribePostApply: (() => void) | null = null;

  try {
    const start = Date.now();
    const attached = session.require();
    const proofMatchOpts: GpuHmrProofMatchOpts = {
      ...(sinceTs !== undefined ? { sinceTs } : {}),
      ...(module ? { module } : {}),
      ...(previewId ? { previewId } : {}),
    };
    let latestGpuProof = latestGpuProofFromAttached(attached, proofMatchOpts);
    let sawAppliedTerminal = false;
    let postApplyTerminal: HmrClassification | null = null;
    let notifyPostApplyTerminal: (() => void) | null = null;
    unsubscribePostApply = attached.channels.hmr.onMessage((msg) => {
      const proof = classifyGpuHmrProofMessage(msg);
      if (gpuHmrProofMatches(proof, proofMatchOpts)) latestGpuProof = proof;
      const cls = classifyHmrMessage(msg);
      if (!cls) return;
      if (cls.status === "applied") {
        sawAppliedTerminal = true;
        return;
      }
      if (!sawAppliedTerminal || postApplyTerminal) return;
      postApplyTerminal = cls;
      notifyPostApplyTerminal?.();
    });

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

    const result = await attached.channels.hmr.waitForTerminal({
      timeoutMs,
      module,
      sinceTs,
      previewId,
    });
    let frameGate: Record<string, unknown> | undefined;

    if (result.status === "applied") {
      const tHmr = result.observedAt ?? Date.now();
      const budget = session.pipelineBudgetMs();
      const remaining = Math.max(0, timeoutMs - (Date.now() - start));
      if (session.frameSeqGateEnabled()) {
        const postApplyWait = waitForPostApplyTerminal(remaining);
        const outcome = await Promise.race([
          session
            .awaitFrameAdvanceAtOrAfter(tHmr + budget, remaining)
            .then((satisfiedBy) => ({ kind: "frame" as const, satisfiedBy })),
          postApplyWait.promise.then((terminal) => ({
            kind: "terminal" as const,
            terminal,
          })),
        ]);
        postApplyWait.cancel();
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
          }, latestGpuProof, requiredProofState);
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
          frameGate = satisfiedBy
            ? {
                status: "satisfied",
                frame_seq: satisfiedBy.frame_seq,
                ts_ms: satisfiedBy.ts_ms,
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
        const lateTerminal = await waitForPostApplyTerminal(observeMs).promise;
        if (lateTerminal) {
          const late = terminalEventFromClassification(lateTerminal, Date.now() - start);
          return responseWithGpuProofValidation({
            status: late.status,
            elapsedMs: Date.now() - start,
            hmrElapsedMs: late.elapsedMs,
            source: late.source,
            detail: late.detail ?? null,
            post_apply_terminal: true,
            wait_contract: waitContract,
          }, latestGpuProof, requiredProofState);
        }
        frameGate = {
          status: "disabled",
          reason: "no_frame_advance_observed",
          pipeline_budget_ms: budget,
          post_apply_observe_ms: observeMs,
        };
      }
    }

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
    }, latestGpuProof, requiredProofState);
  } catch (err) {
    return errorFromException("wait_hmr_failed", err);
  } finally {
    unsubscribePostApply?.();
  }
}

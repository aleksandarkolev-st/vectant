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
  gpuHmrProofStateRank,
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

const DEFAULT_TIMEOUT_MS = 20 * 60_000;
const POST_APPLY_OBSERVE_ENV = "SYNTHI_MCP_HMR_POST_APPLY_OBSERVE_MS";
const FRAME_GATE_POLL_MS = 50;

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
      proofId: proof.proofId,
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

async function waitForDecodedFrameAtOrAfter(
  attached: ReturnType<typeof session.require>,
  minTsMs: number,
  timeoutMs: number
): Promise<{ frame_seq: number; ts_ms: number } | null> {
  const start = Date.now();
  for (;;) {
    try {
      const frame = await attached.frames.getFrame();
      if (frame.ts >= minTsMs) {
        return { frame_seq: frame.seq, ts_ms: frame.ts };
      }
    } catch {
      // No decoded frame yet. Keep polling until the caller's wait budget expires.
    }
    if (Date.now() - start >= timeoutMs) return null;
    const remaining = Math.max(0, timeoutMs - (Date.now() - start));
    await new Promise((resolve) => setTimeout(resolve, Math.min(FRAME_GATE_POLL_MS, remaining)));
  }
}

function responseWithGpuProofValidation(
  payload: Record<string, unknown>,
  proof: GpuHmrProofTelemetry | null,
  requiredState: string | null
): ToolResponse {
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

  const validation = validateGpuHmrProofState(proof, requiredState);
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
  let unsubscribePostApply: (() => void) | null = null;

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
    let sawAppliedTerminal = false;
    let postApplyTerminal: HmrClassification | null = null;
    let notifyPostApplyTerminal: (() => void) | null = null;
    let notifyRequiredProof: (() => void) | null = null;
    const requiredProofSatisfied = (): boolean => {
      return requiredProofState !== null
        && validateGpuHmrProofState(latestGpuProof, requiredProofState).satisfied;
    };
    unsubscribePostApply = attached.channels.hmr.onMessage((msg) => {
      const proof = classifyGpuHmrProofMessage(msg);
      if (gpuHmrProofMatches(proof, proofMatchOpts)) {
        latestGpuProof = proof;
        notifyRequiredProof?.();
      }
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

    const waitForRequiredGpuProof = (
      timeoutMs: number
    ): { promise: Promise<"satisfied" | "terminal" | "timeout">; cancel: () => void } => {
      if (requiredProofState === null || requiredProofSatisfied()) {
        return { promise: Promise.resolve("satisfied"), cancel: () => {} };
      }
      if (postApplyTerminal) {
        return { promise: Promise.resolve("terminal"), cancel: () => {} };
      }
      if (timeoutMs <= 0) {
        return { promise: Promise.resolve("timeout"), cancel: () => {} };
      }
      let cancel = (): void => {};
      const promise = new Promise<"satisfied" | "terminal" | "timeout">((resolve) => {
        let settled = false;
        const settle = (value: "satisfied" | "terminal" | "timeout"): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (notifyRequiredProof === onProofOrTerminal) notifyRequiredProof = null;
          resolve(value);
        };
        const onProofOrTerminal = (): void => {
          if (requiredProofSatisfied()) {
            settle("satisfied");
          } else if (postApplyTerminal) {
            settle("terminal");
          }
        };
        notifyRequiredProof = onProofOrTerminal;
        const timer = setTimeout(() => settle("timeout"), timeoutMs);
        cancel = (): void => settle("timeout");
      });
      return { promise, cancel };
    };

    const terminalWait = attached.channels.hmr.waitForTerminal({
      timeoutMs,
      module,
      sinceTs,
      previewId,
    });
    let result: HmrTerminalEvent;
    if (proofCanSatisfyTerminal) {
      const proofWait = waitForRequiredGpuProof(timeoutMs);
      const outcome = await Promise.race([
        terminalWait.then((terminal) => ({ kind: "terminal" as const, terminal })),
        proofWait.promise.then((proofStatus) => ({ kind: "proof" as const, proofStatus })),
      ]);
      proofWait.cancel();
      if (outcome.kind === "proof" && outcome.proofStatus === "satisfied" && latestGpuProof !== null) {
        result = terminalEventFromGpuProof(latestGpuProof, Date.now() - start);
      } else {
        result = outcome.kind === "terminal"
          ? outcome.terminal
          : await terminalWait;
      }
    } else {
      result = await terminalWait;
    }
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
          const gateToken = satisfiedBy
            ? session.issueFrameGateToken({
                session_id: attached.sessionId,
                frame_seq: satisfiedBy.frame_seq,
                ts_ms: satisfiedBy.ts_ms,
              })
            : null;
          frameGate = satisfiedBy
            ? {
                status: "satisfied",
                frame_seq: satisfiedBy.frame_seq,
                ts_ms: satisfiedBy.ts_ms,
                session_id: attached.sessionId,
                gate_token: gateToken?.token,
                gate_token_issued_at_ms: gateToken?.issued_at_ms,
                gate_token_expires_at_ms: gateToken?.expires_at_ms,
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
        const decodedFrameWait = waitForDecodedFrameAtOrAfter(attached, tHmr + budget, decodedWaitMs);
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
        const outcome = await Promise.race<DecodedFrameOutcome | TerminalOutcome>([
          decodedFrameOutcome,
          terminalOutcome,
        ]);
        lateTerminalWait.cancel();
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
          }, latestGpuProof, requiredProofState);
        }
        const satisfiedBy = outcome.kind === "decoded_frame" ? outcome.satisfiedBy : null;
        const gateToken = satisfiedBy
          ? session.issueFrameGateToken({
              session_id: attached.sessionId,
              frame_seq: satisfiedBy.frame_seq,
              ts_ms: satisfiedBy.ts_ms,
            })
          : null;
        frameGate = satisfiedBy
          ? {
              status: "satisfied",
              frame_seq: satisfiedBy.frame_seq,
              ts_ms: satisfiedBy.ts_ms,
              session_id: attached.sessionId,
              gate_token: gateToken?.token,
              gate_token_issued_at_ms: gateToken?.issued_at_ms,
              gate_token_expires_at_ms: gateToken?.expires_at_ms,
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

    if (result.status === "applied" && requiredProofState !== null && !requiredProofSatisfied()) {
      const remaining = Math.max(0, timeoutMs - (Date.now() - start));
      const proofWait = waitForRequiredGpuProof(remaining);
      const proofOutcome = await proofWait.promise;
      proofWait.cancel();
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
        }, latestGpuProof, requiredProofState);
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

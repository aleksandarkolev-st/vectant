import type { AttachedSession } from "../session.js";
import { leaseRegistry, type LeaseScope } from "../arbitration/lease.js";
import type { BrokerErrorCode } from "./errors.js";
import { brokerError } from "./errors.js";
import { brokerFallbackController } from "./fallback.js";
import { brokerRolloutController } from "./rollout.js";
import { brokerRuntime } from "./runtime.js";
import { requestSharedLease } from "../tools/shared_lease.js";

export type BrokerInputMode = "shadow" | "enforce";

export interface BrokerInputGateError {
  error: BrokerErrorCode;
  broker_error: ReturnType<typeof brokerError>;
  action: string;
  [key: string]: unknown;
}

interface RawViewport {
  w?: unknown;
  h?: unknown;
  dpr?: unknown;
}

interface InputViewport {
  w: number;
  h: number;
  dpr: number;
}

const DPR_EPSILON = 1e-6;

export function resolveBrokerInputMode(): BrokerInputMode {
  return process.env["SYNTHI_BROKER_INPUT_MODE"] === "enforce" ? "enforce" : "shadow";
}

export function brokerInputEnforced(): boolean {
  return resolveBrokerInputMode() === "enforce";
}

export async function checkBrokerInputGate(input: {
  attached: AttachedSession;
  action: string;
  scope: LeaseScope;
  lease_id?: unknown;
  based_on_frame_seq?: unknown;
  based_on_viewport?: unknown;
  now?: number;
}): Promise<BrokerInputGateError | null> {
  const fallback = brokerFallbackController.current(input.attached.sessionId);
  const route = brokerRolloutController.shouldRoute(input.attached.sessionId, "input");
  if (fallback?.mode === "input_disabled_fallback" || route.mode === "input_disabled") {
    return buildGateError("FORBIDDEN", input.action, {
      reason: "input_disabled",
      fallback_mode: fallback?.mode ?? null,
      rollout_mode: route.mode,
    });
  }

  if (!brokerInputEnforced()) return null;

  const now = input.now ?? Date.now();
  if (brokerRuntime.brokerState() === "recovering") {
    return buildGateError("BROKER_RECOVERING", input.action, {
      reason: "broker_recovering",
    });
  }
  const leaseId = typeof input.lease_id === "string" && input.lease_id.length > 0
    ? input.lease_id
    : undefined;
  const sharedLeaseGate = await requestSharedLease(input.attached, {
    op: "validate",
    lease_id: leaseId,
    scope: [input.scope],
  });
  if (sharedLeaseGate === null) {
    return buildGateError("LEASE_DENIED", input.action, {
      reason: "shared_session_lease_authority_unavailable",
      required_authority: "worker",
      lease_id: leaseId ?? null,
      scope: input.scope,
      session_id: input.attached.sessionId,
    });
  }
  if (sharedLeaseGate.ok === false) {
    const code = normalizeSharedLeaseError(sharedLeaseGate.error);
    return buildGateError(code, input.action, {
      ...sharedLeaseGate.detail,
      lease_id: leaseId ?? null,
      scope: input.scope,
      session_id: input.attached.sessionId,
    });
  }
  if (sharedLeaseGate.lease) {
    leaseRegistry.adoptSharedLease(sharedLeaseGate.lease);
  }

  const leaseGate = leaseRegistry.validateForBrokerInput(leaseId, input.scope, now, input.attached.sessionId);
  if (!leaseGate.allowed) {
    return buildGateError(leaseGate.error, input.action, {
      ...leaseGate.detail,
      current_lease: leaseGate.current,
    });
  }

  if (
    typeof input.based_on_frame_seq !== "number" ||
    !Number.isInteger(input.based_on_frame_seq) ||
    input.based_on_frame_seq < 0
  ) {
    return buildGateError("FRAME_STALE", input.action, {
      reason: "based_on_frame_seq_required",
      lease_id: leaseId,
    });
  }

  let frame;
  try {
    frame = await input.attached.frames.getFrame();
  } catch (err) {
    return buildGateError("UPSTREAM_NO_FRAMES", input.action, {
      reason: err instanceof Error ? err.message : String(err),
      lease_id: leaseId,
    });
  }

  const frameAgeMs = Math.max(0, now - frame.ts);
  if (frameAgeMs > 500) {
    return buildGateError("FRAME_STALE", input.action, {
      reason: "frame_age_exceeded",
      frame_seq: frame.seq,
      frame_age_ms: frameAgeMs,
      max_frame_age_ms: 500,
      based_on_frame_seq: input.based_on_frame_seq,
      lease_id: leaseId,
    });
  }

  const frameSeqGap = frame.seq - input.based_on_frame_seq;
  if (frameSeqGap < 0 || frameSeqGap > 1) {
    return buildGateError("FRAME_STALE", input.action, {
      reason: frameSeqGap < 0 ? "based_on_frame_seq_in_future" : "frame_seq_gap_exceeded",
      frame_seq: frame.seq,
      based_on_frame_seq: input.based_on_frame_seq,
      frame_seq_gap: frameSeqGap,
      lease_id: leaseId,
    });
  }

  const viewport = parseViewport(input.based_on_viewport);
  if (viewport === "invalid") {
    return buildGateError("FRAME_STALE", input.action, {
      reason: "based_on_viewport_invalid",
      lease_id: leaseId,
    });
  }
  if (viewport) {
    if (!validDpr(frame.dpr)) {
      return buildGateError("FRAME_STALE", input.action, {
        reason: "producer_dpr_unavailable",
        frame_viewport: { w: frame.width, h: frame.height },
        based_on_viewport: viewport,
        lease_id: leaseId,
      });
    }
    if (viewport.w !== frame.width || viewport.h !== frame.height || Math.abs(viewport.dpr - frame.dpr) > DPR_EPSILON) {
      return buildGateError("FRAME_STALE", input.action, {
        reason: "viewport_changed",
        frame_viewport: { w: frame.width, h: frame.height, dpr: frame.dpr },
        based_on_viewport: viewport,
        lease_id: leaseId,
      });
    }
  }

  return null;
}

function normalizeSharedLeaseError(error: string): Extract<BrokerErrorCode, "LEASE_REQUIRED" | "LEASE_EXPIRED" | "LEASE_DENIED" | "LEASE_PREEMPTED"> {
  if (error === "LEASE_REQUIRED" || error === "LEASE_EXPIRED" || error === "LEASE_PREEMPTED") return error;
  return "LEASE_DENIED";
}

function parseViewport(raw: unknown): InputViewport | "invalid" | null {
  if (raw === undefined) return null;
  if (!raw || typeof raw !== "object") return "invalid";
  const v = raw as RawViewport;
  if (
    typeof v.w !== "number" ||
    typeof v.h !== "number" ||
    typeof v.dpr !== "number" ||
    !Number.isFinite(v.w) ||
    !Number.isFinite(v.h) ||
    !Number.isFinite(v.dpr) ||
    v.w <= 0 ||
    v.h <= 0 ||
    v.dpr <= 0
  ) {
    return "invalid";
  }
  return { w: v.w, h: v.h, dpr: v.dpr };
}

function validDpr(dpr: unknown): dpr is number {
  return typeof dpr === "number" && Number.isFinite(dpr) && dpr > 0;
}

function buildGateError(
  code: BrokerErrorCode,
  action: string,
  detail: Record<string, unknown>
): BrokerInputGateError {
  return {
    ...detail,
    error: code,
    action,
    broker_error: brokerError(code, detail),
  };
}

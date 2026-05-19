import { locateEngine } from "../locate/index.js";
import { eventLog } from "../events/index.js";
import { session } from "../session.js";
import { checkInputGate } from "../correctness/index.js";
import {
  buttonNameToCode,
  encodeMouseButton,
  encodeMouseMove,
  encodeWheel,
  type MouseButtonName,
} from "../wire/input.js";
import { runWait } from "../wait/index.js";
import type { WaitArgs } from "../wait/index.js";
import { dispatchAckRegistry, type PendingDispatch } from "../util/dispatch_ack_registry.js";
import { leaseRegistry } from "../arbitration/lease.js";
import { inputQueueDepth } from "../correctness/input_queue_depth.js";
import { checkBrokerInputGate } from "../broker/index.js";
import {
  errorFromException,
  errorResponse,
  jsonResponse,
  type ToolResponse,
} from "./shared.js";

/**
 * Lease advisory (advisory mode): emits a loud security event in the
 * ring buffer when a lease is held and the caller doesn't match; input
 * still dispatches.
 *
 * In phase-2c `single-holder` mode the upgrade is the subsequent
 * `leaseRegistry.enforceDispatch` gate in `mouseTool` — this advisory
 * function then still fires (the security event is useful either way)
 * but the tool refuses to dispatch before reaching the wire path.
 *
 * Behaviour:
 *   - No current lease → silent (no contention possible).
 *   - Lease held + caller passes matching `lease_id` → silent.
 *   - Lease held + caller passes NO `lease_id` or a stale one →
 *     loud security event with detail.code="input_without_current_lease".
 */
function checkLeaseAndMaybeAlert(action: string, callerLeaseId?: string): void {
  const current = leaseRegistry.currentLease();
  if (!current) return;
  if (callerLeaseId === current.lease_id) return;
  eventLog.push({
    kind: "security",
    code: "rate_limit_warning",
    detail: {
      code: "input_without_current_lease",
      action,
      current_lease_id: current.lease_id,
      current_lease_owner: current.owner,
      current_lease_expires_at: current.expires_at,
      caller_lease_id: callerLeaseId ?? null,
      enforcement: "wire-only",
      note: "Phase-1 advisory. Worker-side enforcement lands in phase 2c.",
    },
  });
}

interface HandleRef {
  handle_id: string;
  reuse?: boolean;
  description?: string;
}

interface RawArgs {
  action?: unknown;
  x?: unknown;
  y?: unknown;
  toX?: unknown;
  toY?: unknown;
  deltaY?: unknown;
  button?: unknown;
  handle?: unknown;
  waitFor?: unknown;
  retry?: unknown;
  await_ack?: unknown;
  ack_timeout_ms?: unknown;
  lease_id?: unknown;
  based_on_frame_seq?: unknown;
  based_on_viewport?: unknown;
}

const VALID_ACTIONS = ["click", "move", "down", "up", "drag", "wheel", "double_click"] as const;
type MouseAction = (typeof VALID_ACTIONS)[number];

const DEFAULT_ACK_TIMEOUT_MS = 4_000;

/**
 * Allocate N pending dispatches and return their IDs + an aggregate
 * settle-all function. Each returned ID is stamped onto an outgoing
 * frame; the aggregate promise resolves when the worker echoes acks for
 * all of them (or rejects with `input_ack_timeout` if any times out).
 */
function allocateDispatches(n: number, timeoutMs: number): {
  ids: string[];
  pending: PendingDispatch[];
  awaitAll: () => Promise<Array<{ dispatch_id: string; accepted: boolean; reason?: string; elapsedMs: number }>>;
} {
  const pending: PendingDispatch[] = [];
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const p = dispatchAckRegistry.register(timeoutMs);
    pending.push(p);
    ids.push(p.id);
  }
  return {
    ids,
    pending,
    awaitAll: async () => {
      const results = await Promise.all(
        pending.map((p) =>
          p.promise.then(
            (res) => ({ dispatch_id: p.id, ...res }),
            (err: Error) => ({
              dispatch_id: p.id,
              accepted: false,
              reason: err.message,
              elapsedMs: -1,
            })
          )
        )
      );
      return results;
    },
  };
}

export async function mouseTool(args: unknown): Promise<ToolResponse> {
  const a = (args ?? {}) as RawArgs;
  const action = a.action as MouseAction | undefined;
  if (!action || !(VALID_ACTIONS as readonly string[]).includes(action)) {
    return errorResponse("invalid_args", { field: "action", allowed: VALID_ACTIONS });
  }

  const gate = checkInputGate();
  if (gate) {
    return errorResponse(gate.error, gate);
  }
  const attached = session.require();

  // Lease-gated advisory (phase-1 wire-only). Emits a loud security
  // event when a lease is held and the caller isn't matching it.
  const callerLeaseId = typeof a.lease_id === "string" ? a.lease_id : undefined;
  checkLeaseAndMaybeAlert(`mouse:${action}`, callerLeaseId);

  // Phase-2c single-holder enforcement. Opt-in via
  // SYNTHI_LEASE_MODE=single-holder; no-op in advisory mode so phase-1
  // call shapes still dispatch.
  const leaseGate = leaseRegistry.enforceDispatch(callerLeaseId);
  if (!leaseGate.allowed) {
    return errorResponse(leaseGate.error, {
      action: `mouse:${action}`,
      current_lease_id: leaseGate.current.lease_id,
      current_lease_owner: leaseGate.current.owner,
      current_lease_expires_at: leaseGate.current.expires_at,
      caller_lease_id: callerLeaseId ?? null,
    });
  }

  if (a.handle !== undefined) {
    const brokerGate = await checkBrokerInputGate({
      attached,
      action: `mouse:${action}`,
      scope: "mouse",
      lease_id: a.lease_id,
      based_on_frame_seq: a.based_on_frame_seq,
      based_on_viewport: a.based_on_viewport,
    });
    if (brokerGate) return errorResponse(brokerGate.error, brokerGate);
  }

  // B2 measurement: count inputs dispatched while a compile is in
  // progress. No-op outside the compile window.
  const button = typeof a.button === "string" ? (a.button as MouseButtonName) : "left";
  if (!["left", "right", "middle"].includes(button)) {
    return errorResponse("invalid_args", { field: "button", allowed: ["left", "right", "middle"] });
  }

  // Auto-wait pre-action.
  if (a.waitFor !== undefined) {
    const waitArgs = a.waitFor as WaitArgs & { timeoutMs?: number };
    const timeout = typeof waitArgs.timeoutMs === "number" ? waitArgs.timeoutMs : undefined;
    const outcome = await runWait(waitArgs, timeout);
    if (outcome.status === "timeout") {
      return errorResponse("wait_timeout_before_action", {
        condition: outcome.condition,
        elapsedMs: outcome.elapsedMs,
      });
    }
    if (outcome.status === "unsupported") {
      return errorResponse(`${outcome.condition}_wait_${outcome.reason}`, {
        condition: outcome.condition,
        reason: outcome.reason,
      });
    }
  }

  // Resolve coords: either explicit {x,y} or via handle → locate → bbox center.
  let x: number | undefined = typeof a.x === "number" ? a.x : undefined;
  let y: number | undefined = typeof a.y === "number" ? a.y : undefined;
  let resolvedBbox: { x: number; y: number; w: number; h: number } | undefined;
  if (a.handle !== undefined) {
    const h = a.handle as HandleRef;
    if (!h || typeof h.handle_id !== "string") {
      return errorResponse("invalid_args", { field: "handle.handle_id", expected: "string" });
    }
    let frame;
    try {
      frame = await attached.frames.getFrame();
    } catch (err) {
      return errorFromException("no_frame_yet", err);
    }
    try {
      const result = await locateEngine.resolve(
        {
          description: h.description ?? `handle:${h.handle_id}`,
          handle_id: h.handle_id,
          reuse_handle: h.reuse ?? true,
        },
        { frame: frame.data, frameDims: { w: frame.width, h: frame.height } }
      );
      resolvedBbox = result.bbox;
      if (x === undefined) x = Math.round(result.bbox.x + result.bbox.w / 2);
      if (y === undefined) y = Math.round(result.bbox.y + result.bbox.h / 2);
    } catch (err) {
      return errorFromException("locator_unresolved", err);
    }
  }

  const frameDims = attached.frames.dimensions();

  // Dispatch-ack opt-in. Default is fire-and-forget (back-compat). When
  // enabled, the MCP stamps every outgoing frame with a dispatch_id and
  // awaits the worker's `{type:"input-ack"}` echo before returning. Tool
  // rejects with `input_ack_timeout` (via the registry's 4s default) if
  // the worker doesn't ack.
  const awaitAck = a.await_ack === true;
  const ackTimeoutMs =
    typeof a.ack_timeout_ms === "number" && a.ack_timeout_ms > 0
      ? Math.floor(a.ack_timeout_ms)
      : DEFAULT_ACK_TIMEOUT_MS;
  let ackAlloc: ReturnType<typeof allocateDispatches> | null = null;
  let ackResults: Array<{ dispatch_id: string; accepted: boolean; reason?: string; elapsedMs: number }> | null = null;

  try {
    switch (action) {
      case "click":
      case "double_click":
      case "down":
      case "up":
      case "move": {
        if (x === undefined || y === undefined) {
          return errorResponse("invalid_args", { field: "x/y", expected: "numbers (or handle)" });
        }
        if (frameDims && (x < 0 || y < 0 || x >= frameDims.width || y >= frameDims.height)) {
          return errorResponse("click_out_of_bounds", {
            viewport: { w: frameDims.width, h: frameDims.height },
            requested: { x, y },
          });
        }
        const code = buttonNameToCode(button);
        const brokerGate = await checkBrokerInputGate({
          attached,
          action: `mouse:${action}`,
          scope: "mouse",
          lease_id: a.lease_id,
          based_on_frame_seq: a.based_on_frame_seq,
          based_on_viewport: a.based_on_viewport,
        });
        if (brokerGate) return errorResponse(brokerGate.error, brokerGate);
        inputQueueDepth.recordDispatch(`mouse:${action}`);
        const nFrames =
          action === "click" ? 2 :
          action === "double_click" ? 4 :
          1;
        if (awaitAck) ackAlloc = allocateDispatches(nFrames, ackTimeoutMs);
        const ids = ackAlloc?.ids ?? [];
        const frames: string[] = [];
        let idx = 0;
        const nextId = (): string | undefined => (awaitAck ? ids[idx++] : undefined);
        if (action === "click" || action === "double_click") {
          frames.push(encodeMouseButton(attached.sessionId, x, y, code, "down", nextId()));
          frames.push(encodeMouseButton(attached.sessionId, x, y, code, "up", nextId()));
          if (action === "double_click") {
            frames.push(encodeMouseButton(attached.sessionId, x, y, code, "down", nextId()));
            frames.push(encodeMouseButton(attached.sessionId, x, y, code, "up", nextId()));
          }
        } else if (action === "down") {
          frames.push(encodeMouseButton(attached.sessionId, x, y, code, "down", nextId()));
        } else if (action === "up") {
          frames.push(encodeMouseButton(attached.sessionId, x, y, code, "up", nextId()));
        } else if (action === "move") {
          frames.push(encodeMouseMove(attached.sessionId, x, y, nextId()));
        }
        await attached.channels.sendInput(frames);
        break;
      }
      case "drag": {
        if (x === undefined || y === undefined) return errorResponse("invalid_args", { field: "x/y" });
        const toX = typeof a.toX === "number" ? a.toX : undefined;
        const toY = typeof a.toY === "number" ? a.toY : undefined;
        if (toX === undefined || toY === undefined) {
          return errorResponse("invalid_args", { field: "toX/toY", expected: "numbers" });
        }
        const code = buttonNameToCode(button);
        const brokerGate = await checkBrokerInputGate({
          attached,
          action: "mouse:drag",
          scope: "mouse",
          lease_id: a.lease_id,
          based_on_frame_seq: a.based_on_frame_seq,
          based_on_viewport: a.based_on_viewport,
        });
        if (brokerGate) return errorResponse(brokerGate.error, brokerGate);
        inputQueueDepth.recordDispatch("mouse:drag");
        if (awaitAck) ackAlloc = allocateDispatches(3, ackTimeoutMs);
        const ids = ackAlloc?.ids ?? [];
        const frames: string[] = [
          encodeMouseButton(attached.sessionId, x, y, code, "down", ids[0]),
          encodeMouseMove(attached.sessionId, toX, toY, ids[1]),
          encodeMouseButton(attached.sessionId, toX, toY, code, "up", ids[2]),
        ];
        await attached.channels.sendInput(frames);
        break;
      }
      case "wheel": {
        const deltaY = typeof a.deltaY === "number" ? a.deltaY : 0;
        const brokerGate = await checkBrokerInputGate({
          attached,
          action: "mouse:wheel",
          scope: "mouse",
          lease_id: a.lease_id,
          based_on_frame_seq: a.based_on_frame_seq,
          based_on_viewport: a.based_on_viewport,
        });
        if (brokerGate) return errorResponse(brokerGate.error, brokerGate);
        inputQueueDepth.recordDispatch("mouse:wheel");
        if (awaitAck) ackAlloc = allocateDispatches(1, ackTimeoutMs);
        const id = ackAlloc?.ids[0];
        await attached.channels.sendInput([encodeWheel(attached.sessionId, deltaY, id)]);
        break;
      }
    }
    if (awaitAck && ackAlloc) {
      ackResults = await ackAlloc.awaitAll();
      const rejected = ackResults.filter((r) => !r.accepted);
      if (rejected.length > 0) {
        const timedOut = rejected.some((r) => r.reason?.startsWith("input_ack_timeout"));
        const code = timedOut ? "input_ack_timeout" : "input_rejected_by_worker";
        return errorResponse(code, {
          action,
          ack_results: ackResults,
          rejected_count: rejected.length,
        });
      }
    }
  } catch (err) {
    // Cancel any still-pending acks so the registry doesn't leak.
    if (ackAlloc) {
      for (const p of ackAlloc.pending) p.cancel();
    }
    return errorFromException("mouse_send_failed", err);
  }

  eventLog.push({
    kind: "input",
    action: `mouse:${action}`,
    payload: {
      ...(x !== undefined ? { x } : {}),
      ...(y !== undefined ? { y } : {}),
      ...(action === "drag" ? { toX: a.toX, toY: a.toY } : {}),
      button,
      ...(resolvedBbox ? { resolved_bbox: resolvedBbox } : {}),
    },
  });
  session.touch();

  return jsonResponse({
    ok: true,
    action,
    dispatched_at: Date.now(),
    ...(resolvedBbox ? { resolved_bbox: resolvedBbox } : {}),
    ...(ackResults !== null ? { ack_results: ackResults } : {}),
  });
}

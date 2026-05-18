import { eventLog } from "../events/index.js";
import { session } from "../session.js";
import { keystrokeDetector } from "../security/anomaly.js";
import { checkInputGate } from "../correctness/index.js";
import { encodeKey, encodeTypeSequence } from "../wire/input.js";
import { runWait } from "../wait/index.js";
import type { LogArgs, WaitArgs } from "../wait/index.js";
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

/** See `tools/mouse.ts::checkLeaseAndMaybeAlert` for rationale. */
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

interface RawArgs {
  action?: unknown;
  text?: unknown;
  key?: unknown;
  keys?: unknown;
  confirm?: unknown;
  waitFor?: unknown;
  await_ack?: unknown;
  ack_timeout_ms?: unknown;
  lease_id?: unknown;
  based_on_frame_seq?: unknown;
  based_on_viewport?: unknown;
}

const VALID_ACTIONS = ["type", "key", "chord"] as const;
type KeyboardAction = (typeof VALID_ACTIONS)[number];

const DEFAULT_ACK_TIMEOUT_MS = 4_000;

export async function keyboardTool(args: unknown): Promise<ToolResponse> {
  const a = (args ?? {}) as RawArgs;
  const action = a.action as KeyboardAction | undefined;
  if (!action || !(VALID_ACTIONS as readonly string[]).includes(action)) {
    return errorResponse("invalid_args", { field: "action", allowed: VALID_ACTIONS });
  }

  const gate = checkInputGate();
  if (gate) {
    return errorResponse(gate.error, gate);
  }
  const attached = session.require();

  const callerLeaseId = typeof a.lease_id === "string" ? a.lease_id : undefined;
  checkLeaseAndMaybeAlert(`keyboard:${action}`, callerLeaseId);

  // Phase-2c single-holder enforcement (see tools/mouse.ts for
  // rationale — shared gate, opt-in via SYNTHI_LEASE_MODE).
  const leaseGate = leaseRegistry.enforceDispatch(callerLeaseId);
  if (!leaseGate.allowed) {
    return errorResponse(leaseGate.error, {
      action: `keyboard:${action}`,
      current_lease_id: leaseGate.current.lease_id,
      current_lease_owner: leaseGate.current.owner,
      current_lease_expires_at: leaseGate.current.expires_at,
      caller_lease_id: callerLeaseId ?? null,
    });
  }

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
      });
    }
  }

  // Dispatch-ack opt-in. Same shape as synthi_mouse — default is
  // fire-and-forget (back-compat); when enabled, every outgoing frame
  // carries a dispatch_id and the tool awaits the worker's echoed acks
  // before returning.
  const awaitAck = a.await_ack === true;
  const ackTimeoutMs =
    typeof a.ack_timeout_ms === "number" && a.ack_timeout_ms > 0
      ? Math.floor(a.ack_timeout_ms)
      : DEFAULT_ACK_TIMEOUT_MS;
  const pending: PendingDispatch[] = [];
  const allocate = (): PendingDispatch => {
    const p = dispatchAckRegistry.register(ackTimeoutMs);
    pending.push(p);
    return p;
  };
  const nextId = (): string | undefined => (awaitAck ? allocate().id : undefined);

  let charsSent = 0;
  let recordedKeys: string[] = [];
  let ackResults: Array<{ dispatch_id: string; accepted: boolean; reason?: string; elapsedMs: number }> | null = null;
  try {
    const brokerGate = await checkBrokerInputGate({
      attached,
      action: `keyboard:${action}`,
      scope: "keyboard",
      lease_id: a.lease_id,
      based_on_frame_seq: a.based_on_frame_seq,
      based_on_viewport: a.based_on_viewport,
    });
    if (brokerGate) return errorResponse(brokerGate.error, brokerGate);
    inputQueueDepth.recordDispatch(`keyboard:${action}`);

    switch (action) {
      case "type": {
        if (typeof a.text !== "string") {
          return errorResponse("invalid_args", { field: "text", expected: "string" });
        }
        if (a.text.length > 0) {
          const supplier = awaitAck ? (): string => allocate().id : undefined;
          const frames = encodeTypeSequence(attached.sessionId, a.text, supplier);
          await attached.channels.sendInput(frames);
        }
        charsSent = a.text.length;
        recordedKeys = Array.from(a.text);
        break;
      }
      case "key": {
        if (typeof a.key !== "string" || a.key.length === 0) {
          return errorResponse("invalid_args", { field: "key", expected: "non-empty string" });
        }
        const down = encodeKey(attached.sessionId, a.key, "down", nextId());
        const up = encodeKey(attached.sessionId, a.key, "up", nextId());
        await attached.channels.sendInput([down, up]);
        charsSent = 1;
        recordedKeys = [a.key];
        break;
      }
      case "chord": {
        if (!Array.isArray(a.keys) || a.keys.some((k) => typeof k !== "string" || k.length === 0)) {
          return errorResponse("invalid_args", { field: "keys", expected: "non-empty string array" });
        }
        const keys = a.keys as string[];
        const frames: string[] = [];
        for (const k of keys) frames.push(encodeKey(attached.sessionId, k, "down", nextId()));
        for (let i = keys.length - 1; i >= 0; i--) frames.push(encodeKey(attached.sessionId, keys[i]!, "up", nextId()));
        await attached.channels.sendInput(frames);
        charsSent = keys.length;
        recordedKeys = keys;
        break;
      }
    }
    if (awaitAck && pending.length > 0) {
      ackResults = await Promise.all(
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
    for (const p of pending) p.cancel();
    return errorFromException("keyboard_send_failed", err);
  }

  // Anomaly detection on the emitted keys. Phase-1 warns only — every
  // dispatch goes through; suspicious patterns land in the event log so
  // post-run analysis can flag a runaway agent.
  const reasons: string[] = [];
  for (const k of recordedKeys) {
    const signal = keystrokeDetector.record(k);
    if (signal.suspicious) reasons.push(...signal.reasons);
  }
  if (reasons.length > 0) {
    eventLog.push({
      kind: "security",
      code: "rate_limit_warning",
      detail: { action, reasons, charsSent },
    });
  }

  eventLog.push({
    kind: "input",
    action: `keyboard:${action}`,
    payload: {
      ...(action === "type" ? { chars: charsSent } : {}),
      ...(action === "key" ? { key: a.key } : {}),
      ...(action === "chord" ? { keys: a.keys } : {}),
    },
  });
  session.touch();

  // Post-action confirm — auto-wait for a log pattern (common idiom: type a
  // command, wait for the echoed result in build-log).
  if (a.confirm !== undefined) {
    const c = a.confirm as { pattern?: unknown; timeoutMs?: unknown };
    if (typeof c.pattern !== "string") {
      return errorResponse("invalid_args", { field: "confirm.pattern", expected: "string" });
    }
    const waitArgs: LogArgs = { condition: "log", pattern: c.pattern };
    const timeoutMs = typeof c.timeoutMs === "number" ? c.timeoutMs : 5_000;
    const outcome = await runWait(waitArgs, timeoutMs);
    if (outcome.status === "timeout") {
      return errorResponse("confirm_timeout_after_action", {
        pattern: c.pattern,
        elapsedMs: outcome.elapsedMs,
      });
    }
  }

  return jsonResponse({
    ok: true,
    action,
    charsSent,
    dispatched_at: Date.now(),
    ...(ackResults !== null ? { ack_results: ackResults } : {}),
  });
}

import { session } from "../session.js";
import { buttonNameToCode, encodeKey, encodeMouseButton, encodeMouseMove, encodeTypeSequence, type MouseButtonName } from "../wire/input.js";
import { dispatchAckRegistry, type PendingDispatch } from "../util/dispatch_ack_registry.js";
import { checkBrokerInputGate } from "../broker/input_gate.js";
import { brokerError, normalizeToolCallId, recordBrokerInputTrace, verifyBrokerPostcondition } from "../broker/index.js";
import { errorResponse, jsonResponse, type ToolResponse } from "./shared.js";

interface RawArgs {
  tool_call_id?: unknown;
  lease_id?: unknown;
  based_on_frame_seq?: unknown;
  based_on_viewport?: unknown;
  action?: unknown;
  postcondition?: unknown;
  timeout_ms?: unknown;
  await_ack?: unknown;
}

type DispatchAction =
  | { tool: "synthi_mouse"; kind: "click" | "move"; x: number; y: number; button?: MouseButtonName }
  | { tool: "synthi_keyboard"; kind: "type"; text: string }
  | { tool: "synthi_keyboard"; kind: "key"; key: string };

const DEFAULT_TIMEOUT_MS = 4_000;

export async function dispatchInputTool(args: unknown): Promise<ToolResponse> {
  const receivedAt = Date.now();
  const a = (args ?? {}) as RawArgs;
  const toolCallId = normalizeToolCallId(a.tool_call_id);
  const attached = session.get();
  if (!attached) return errorResponse("SESSION_DISCONNECTED", brokerError("SESSION_DISCONNECTED") as unknown as Record<string, unknown>);
  const action = parseAction(a.action);
  if (!action) return errorResponse("invalid_args", { field: "action" });
  const scope = action.tool === "synthi_mouse" ? "mouse" : "keyboard";
  const actionName = `${scope}:${action.kind}`;
  const gate = await checkBrokerInputGate({
    attached,
    action: actionName,
    scope,
    lease_id: a.lease_id,
    based_on_frame_seq: a.based_on_frame_seq,
    based_on_viewport: a.based_on_viewport,
    now: receivedAt,
  });
  if (gate) return errorResponse(gate.error, gate);

  const timeoutMs = typeof a.timeout_ms === "number" && a.timeout_ms > 0
    ? Math.floor(a.timeout_ms)
    : DEFAULT_TIMEOUT_MS;
  const pending: PendingDispatch[] = [];
  const nextId = (): string => {
    const p = dispatchAckRegistry.register(timeoutMs);
    pending.push(p);
    return p.id;
  };
  const frames = encodeAction(attached.sessionId, action, nextId);
  const transportAck = { ack_id: `ack_${toolCallId}`, ts: Date.now() };
  try {
    await attached.channels.sendInput(frames);
  } catch (err) {
    for (const p of pending) p.cancel();
    return errorResponse("INPUT_ACK_TIMEOUT", brokerError("INPUT_ACK_TIMEOUT", {
      reason: err instanceof Error ? err.message : String(err),
    }) as unknown as Record<string, unknown>);
  }

  let browserAckedAt: number | undefined;
  const ackResults = await Promise.all(
    pending.map((p) =>
      p.promise.then(
        (res) => ({ dispatch_id: p.id, ...res }),
        (err: Error) => ({ dispatch_id: p.id, accepted: false, reason: err.message, elapsedMs: -1 })
      )
    )
  );
  browserAckedAt = Date.now();
  const rejected = ackResults.filter((r) => !r.accepted);
  if (rejected.length > 0) {
    recordBrokerInputTrace({
      tool_call_id: toolCallId,
      session_id: attached.sessionId,
      action: actionName,
      frame_seq: typeof a.based_on_frame_seq === "number" ? a.based_on_frame_seq : undefined,
      lease_id: typeof a.lease_id === "string" ? a.lease_id : undefined,
      input_ack_ids: ackResults.map((r) => r.dispatch_id),
      received_at: receivedAt,
      dispatched_at: transportAck.ts,
      browser_acked_at: browserAckedAt,
      ack_chain: {
        transport_ack: transportAck,
        browser_ack: { accepted: false, ts: browserAckedAt, dispatch_ids: ackResults.map((r) => r.dispatch_id) },
      },
      detail: { ack_results: ackResults },
    });
    return errorResponse("INPUT_ACK_TIMEOUT", brokerError("INPUT_ACK_TIMEOUT", { ack_results: ackResults }) as unknown as Record<string, unknown>);
  }

  if (a.postcondition === undefined) {
    const unverifiedAt = Date.now();
    const ackChain = {
      transport_ack: transportAck,
      browser_ack: { accepted: true, ts: browserAckedAt, dispatch_ids: ackResults.map((r) => r.dispatch_id) },
    };
    recordBrokerInputTrace({
      tool_call_id: toolCallId,
      session_id: attached.sessionId,
      action: actionName,
      frame_seq: typeof a.based_on_frame_seq === "number" ? a.based_on_frame_seq : undefined,
      lease_id: typeof a.lease_id === "string" ? a.lease_id : undefined,
      input_ack_ids: ackResults.map((r) => r.dispatch_id),
      received_at: receivedAt,
      dispatched_at: transportAck.ts,
      browser_acked_at: browserAckedAt,
      unverified_at: unverifiedAt,
      ack_chain: ackChain,
    });
    return jsonResponse({
      ok: true,
      transport_ack: transportAck,
      browser_ack: ackChain.browser_ack,
      unverified: true,
      ack_chain: ackChain,
    });
  }

  const postcondition = await verifyBrokerPostcondition(a.postcondition, timeoutMs);
  if (!postcondition.supported) {
    return errorResponse("UNSUPPORTED_POSTCONDITION_TYPE", brokerError("UNSUPPORTED_POSTCONDITION_TYPE", {
      postcondition_type: postcondition.type,
      evidence: postcondition.evidence,
    }) as unknown as Record<string, unknown>);
  }
  const verifiedAt = Date.now();
  const ackChain = {
    transport_ack: transportAck,
    browser_ack: { accepted: true, ts: browserAckedAt, dispatch_ids: ackResults.map((r) => r.dispatch_id) },
    effect_verified: { verified: postcondition.verified, ts: verifiedAt },
  };
  recordBrokerInputTrace({
    tool_call_id: toolCallId,
    session_id: attached.sessionId,
    action: actionName,
    frame_seq: typeof a.based_on_frame_seq === "number" ? a.based_on_frame_seq : undefined,
    lease_id: typeof a.lease_id === "string" ? a.lease_id : undefined,
    input_ack_ids: ackResults.map((r) => r.dispatch_id),
    received_at: receivedAt,
    dispatched_at: transportAck.ts,
    browser_acked_at: browserAckedAt,
    verified_at: verifiedAt,
    ack_chain: ackChain,
    detail: { postcondition },
  });
  if (!postcondition.verified) {
    return errorResponse("EFFECT_NOT_VERIFIED", brokerError("EFFECT_NOT_VERIFIED", {
      postcondition_type: postcondition.type,
      evidence: postcondition.evidence,
    }) as unknown as Record<string, unknown>);
  }
  return jsonResponse({
    ok: true,
    transport_ack: transportAck,
    browser_ack: ackChain.browser_ack,
    effect_verified: ackChain.effect_verified,
    ack_chain: ackChain,
  });
}

function parseAction(raw: unknown): DispatchAction | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (obj["tool"] === "synthi_mouse" && (obj["kind"] === "click" || obj["kind"] === "move")) {
    if (typeof obj["x"] !== "number" || typeof obj["y"] !== "number") return null;
    const button = obj["button"];
    if (button !== undefined && button !== "left" && button !== "middle" && button !== "right") return null;
    return {
      tool: "synthi_mouse",
      kind: obj["kind"],
      x: obj["x"],
      y: obj["y"],
      ...(button !== undefined ? { button } : {}),
    };
  }
  if (obj["tool"] === "synthi_keyboard" && obj["kind"] === "type" && typeof obj["text"] === "string") {
    return { tool: "synthi_keyboard", kind: "type", text: obj["text"] };
  }
  if (obj["tool"] === "synthi_keyboard" && obj["kind"] === "key" && typeof obj["key"] === "string") {
    return { tool: "synthi_keyboard", kind: "key", key: obj["key"] };
  }
  return null;
}

function encodeAction(sessionId: string, action: DispatchAction, nextId: () => string): string[] {
  if (action.tool === "synthi_mouse") {
    if (action.kind === "move") return [encodeMouseMove(sessionId, action.x, action.y, nextId())];
    const code = buttonNameToCode(action.button ?? "left");
    return [
      encodeMouseButton(sessionId, action.x, action.y, code, "down", nextId()),
      encodeMouseButton(sessionId, action.x, action.y, code, "up", nextId()),
    ];
  }
  if (action.kind === "type") return encodeTypeSequence(sessionId, action.text, nextId);
  return [
    encodeKey(sessionId, action.key, "down", nextId()),
    encodeKey(sessionId, action.key, "up", nextId()),
  ];
}

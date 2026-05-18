import { randomUUID } from "node:crypto";
import { eventLog } from "../events/index.js";
import { resolveLeaseOwner } from "../arbitration/lease.js";
import { brokerSloRecorder } from "./slo.js";
import { auditBrokerEvent } from "./security.js";

export interface BrokerAckChain {
  transport_ack: { ack_id: string; ts: number };
  browser_ack?: { accepted: boolean; ts: number; dispatch_ids: string[] };
  effect_verified?: { verified: boolean; ts: number };
}

export interface BrokerTraceInput {
  tool_call_id?: string;
  session_id: string;
  agent_id?: string;
  action: string;
  frame_seq?: number;
  lease_id?: string;
  input_ack_ids?: string[];
  received_at: number;
  dispatched_at: number;
  browser_acked_at?: number;
  verified_at?: number;
  unverified_at?: number;
  ack_chain?: BrokerAckChain;
  detail?: Record<string, unknown>;
}

export function normalizeToolCallId(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : `tc_${randomUUID()}`;
}

export function recordBrokerInputTrace(input: BrokerTraceInput): void {
  const browserAckAccepted = input.browser_acked_at !== undefined && input.ack_chain?.browser_ack?.accepted !== false;
  brokerSloRecorder.recordRatio("input_ack_timeout_rate", browserAckAccepted ? 0 : 1, 1, input.received_at);
  const postcondition = input.detail?.["postcondition"];
  if (postcondition && typeof postcondition === "object") {
    const p = postcondition as Record<string, unknown>;
    if (p["supported"] === true) {
      brokerSloRecorder.recordRatio(
        "input_postcondition_success_rate",
        input.ack_chain?.effect_verified?.verified === true ? 1 : 0,
        1,
        input.verified_at ?? input.unverified_at ?? input.browser_acked_at ?? input.dispatched_at
      );
    }
  }
  auditBrokerEvent({
    action: "dispatch_input",
    principal: input.agent_id ?? resolveLeaseOwner(),
    payload: {
      tool_call_id: input.tool_call_id ?? null,
      session_id: input.session_id,
      agent_id: input.agent_id ?? resolveLeaseOwner(),
      frame_seq: input.frame_seq ?? null,
      lease_id: input.lease_id ?? null,
      action: input.action,
      browser_acked: browserAckAccepted,
      verified: input.ack_chain?.effect_verified?.verified ?? null,
    },
  });
  eventLog.push({
    kind: "input",
    action: input.action,
    payload: {
      tool_call_id: input.tool_call_id ?? normalizeToolCallId(undefined),
      session_id: input.session_id,
      agent_id: input.agent_id ?? resolveLeaseOwner(),
      frame_seq: input.frame_seq ?? null,
      lease_id: input.lease_id ?? null,
      input_ack_id: input.input_ack_ids ?? [],
      received_at: input.received_at,
      dispatched_at: input.dispatched_at,
      ...(input.browser_acked_at !== undefined ? { browser_acked_at: input.browser_acked_at } : {}),
      ...(input.verified_at !== undefined ? { verified_at: input.verified_at } : {}),
      ...(input.unverified_at !== undefined ? { unverified_at: input.unverified_at } : {}),
      ...(input.ack_chain !== undefined ? { ack_chain: input.ack_chain } : {}),
      ...(input.detail !== undefined ? { detail: input.detail } : {}),
    },
  });
}

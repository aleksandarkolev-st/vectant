import { createHash } from "node:crypto";
import { brokerFallbackController, type BrokerFallbackMode } from "./fallback.js";
import { auditBrokerEvent } from "./security.js";

export type BrokerRolloutMode =
  | "direct"
  | "shadow"
  | "broker_read_only"
  | "broker_input_cutover"
  | "input_disabled";

export type BrokerCanaryStage = "internal" | "selected_external" | "general";
export type BrokerRoutedOperation = "screenshot" | "wait" | "health" | "events" | "input";

export interface BrokerRolloutState {
  session_id: string;
  mode: BrokerRolloutMode;
  stage: BrokerCanaryStage;
  reason: string;
  updated_at: number;
  updated_by: string;
}

export interface BrokerDualReadComparison {
  session_id: string;
  frame_seq: number;
  direct_hash: string;
  broker_hash: string;
  matched: boolean;
  compared_at: number;
}

export interface BrokerCompatibilityEntry {
  client_protocol_version: number;
  broker_supported: boolean;
  fallback_mode: BrokerRolloutMode;
  reason: string;
}

const READ_ONLY_OPS = new Set<BrokerRoutedOperation>(["screenshot", "wait", "health", "events"]);

export class BrokerRolloutController {
  private readonly states = new Map<string, BrokerRolloutState>();
  private readonly comparisons = new Map<string, BrokerDualReadComparison[]>();

  setSessionMode(input: {
    session_id: string;
    mode: BrokerRolloutMode;
    reason: string;
    updated_by: string;
    stage?: BrokerCanaryStage;
    now?: number;
  }): BrokerRolloutState {
    const state: BrokerRolloutState = {
      session_id: input.session_id,
      mode: input.mode,
      stage: input.stage ?? "internal",
      reason: input.reason,
      updated_at: input.now ?? Date.now(),
      updated_by: input.updated_by,
    };
    this.states.set(input.session_id, state);
    auditBrokerEvent({
      action: "rollout_mode_set",
      principal: input.updated_by,
      payload: state as unknown as Record<string, unknown>,
      ts: state.updated_at,
    });
    return { ...state };
  }

  getSessionState(sessionId: string): BrokerRolloutState {
    return this.states.get(sessionId) ?? {
      session_id: sessionId,
      mode: "direct",
      stage: "internal",
      reason: "default_direct",
      updated_at: 0,
      updated_by: "system",
    };
  }

  shouldRoute(sessionId: string, operation: BrokerRoutedOperation): {
    broker: boolean;
    shadow: boolean;
    mode: BrokerRolloutMode;
  } {
    const state = this.getSessionState(sessionId);
    if (state.mode === "shadow") return { broker: false, shadow: true, mode: state.mode };
    if (state.mode === "broker_read_only") {
      return { broker: READ_ONLY_OPS.has(operation), shadow: false, mode: state.mode };
    }
    if (state.mode === "broker_input_cutover") return { broker: true, shadow: false, mode: state.mode };
    return { broker: false, shadow: false, mode: state.mode };
  }

  killSwitch(input: {
    session_id: string;
    reason: string;
    operator_id: string;
    mode?: BrokerFallbackMode;
    now?: number;
  }): ReturnType<typeof brokerFallbackController.apply> {
    this.setSessionMode({
      session_id: input.session_id,
      mode: input.mode === "input_disabled_fallback" ? "input_disabled" : "direct",
      reason: input.reason,
      updated_by: input.operator_id,
      now: input.now,
    });
    return brokerFallbackController.apply({
      session_id: input.session_id,
      mode: input.mode ?? "direct_attach_single_agent_only",
      reason: input.reason,
      operator_id: input.operator_id,
      now: input.now,
    });
  }

  recordDualReadComparison(input: {
    session_id: string;
    frame_seq: number;
    direct: Buffer | string;
    broker: Buffer | string;
    now?: number;
  }): BrokerDualReadComparison {
    const comparison: BrokerDualReadComparison = {
      session_id: input.session_id,
      frame_seq: input.frame_seq,
      direct_hash: contentHash(input.direct),
      broker_hash: contentHash(input.broker),
      matched: contentHash(input.direct) === contentHash(input.broker),
      compared_at: input.now ?? Date.now(),
    };
    const list = this.comparisons.get(input.session_id) ?? [];
    list.push(comparison);
    while (list.length > 100) list.shift();
    this.comparisons.set(input.session_id, list);
    return { ...comparison };
  }

  dualReadHealth(sessionId: string): {
    session_id: string;
    comparisons: number;
    mismatches: number;
    parity_rate: number | null;
  } {
    const list = this.comparisons.get(sessionId) ?? [];
    const mismatches = list.filter((item) => !item.matched).length;
    return {
      session_id: sessionId,
      comparisons: list.length,
      mismatches,
      parity_rate: list.length === 0 ? null : (list.length - mismatches) / list.length,
    };
  }

  compatibility(version: number): BrokerCompatibilityEntry {
    if (!Number.isInteger(version) || version < 1) {
      return {
        client_protocol_version: version,
        broker_supported: false,
        fallback_mode: "direct",
        reason: "invalid_protocol_version",
      };
    }
    return {
      client_protocol_version: version,
      broker_supported: version >= 1,
      fallback_mode: version >= 1 ? "broker_read_only" : "direct",
      reason: version >= 1 ? "compatible" : "unsupported_protocol_version",
    };
  }

  clear(): void {
    this.states.clear();
    this.comparisons.clear();
  }
}

function contentHash(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export const brokerRolloutController = new BrokerRolloutController();

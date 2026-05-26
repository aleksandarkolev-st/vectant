import { eventLog } from "../events/index.js";
import { brokerError, type BrokerErrorPayload } from "./errors.js";
import { producerFenceRegistry } from "./producer.js";

export type BrokerFallbackMode =
  | "broker_read_only_fallback"
  | "direct_attach_single_agent_only"
  | "input_disabled_fallback"
  | "full_direct_attach";

export interface BrokerFallbackState {
  session_id: string;
  mode: BrokerFallbackMode;
  reason: string;
  applied_at: number;
  producer_epoch: number;
}

export type BrokerFallbackResult =
  | {
      ok: true;
      applied_mode: BrokerFallbackMode;
      producer_epoch: number;
      safety_checks_passed: true;
    }
  | { ok: false; error: BrokerErrorPayload; safety_checks_passed: false };

export class BrokerFallbackController {
  private readonly states = new Map<string, BrokerFallbackState>();

  apply(input: {
    session_id: string;
    mode: BrokerFallbackMode;
    reason: string;
    operator_id: string;
    now?: number;
  }): BrokerFallbackResult {
    const currentProducer = producerFenceRegistry.current(input.session_id);
    if (input.mode === "full_direct_attach" && !currentProducer?.teardown_confirmed) {
      return {
        ok: false,
        error: brokerError("FORBIDDEN", {
          reason: "producer_teardown_required",
          session_id: input.session_id,
          mode: input.mode,
        }),
        safety_checks_passed: false,
      };
    }
    const state: BrokerFallbackState = {
      session_id: input.session_id,
      mode: input.mode,
      reason: input.reason,
      applied_at: input.now ?? Date.now(),
      producer_epoch: currentProducer?.producer_epoch ?? 0,
    };
    this.states.set(input.session_id, state);
    eventLog.push({
      kind: "lifecycle",
      state: "running",
      detail: {
        broker_fallback_mode: state.mode,
        reason: state.reason,
        operator_id: input.operator_id,
        producer_epoch: state.producer_epoch,
      },
      ts: state.applied_at,
    });
    return {
      ok: true,
      applied_mode: state.mode,
      producer_epoch: state.producer_epoch,
      safety_checks_passed: true,
    };
  }

  current(sessionId: string): BrokerFallbackState | null {
    const state = this.states.get(sessionId);
    return state ? { ...state } : null;
  }

  clear(): void {
    this.states.clear();
  }
}

export const brokerFallbackController = new BrokerFallbackController();

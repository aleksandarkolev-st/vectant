import { eventLog } from "../events/index.js";
import { leaseRegistry } from "../arbitration/lease.js";
import type { BrokerState } from "./contracts.js";
import { brokerSloRecorder } from "./slo.js";

export interface BrokerRecoveryIncident {
  recovery_start_ts: number;
  broker_ready_ts?: number;
  reason: string;
}

class BrokerRuntime {
  private state: BrokerState = "ready";
  private recovery: BrokerRecoveryIncident | null = null;

  brokerState(): BrokerState {
    return this.state;
  }

  recoveryIncident(): BrokerRecoveryIncident | null {
    return this.recovery ? { ...this.recovery } : null;
  }

  enterRecovering(reason: string, now: number = Date.now()): BrokerRecoveryIncident {
    this.state = "recovering";
    this.recovery = { recovery_start_ts: now, reason };
    leaseRegistry.release();
    eventLog.push({
      kind: "lifecycle",
      state: "migrating",
      detail: {
        broker_state: "recovering",
        reason,
        leases_invalidated: true,
      },
      ts: now,
    });
    return { ...this.recovery };
  }

  markReady(now: number = Date.now()): BrokerRecoveryIncident | null {
    const incident = this.recovery;
    this.state = "ready";
    if (!incident) return null;
    this.recovery = { ...incident, broker_ready_ts: now };
    eventLog.push({
      kind: "lifecycle",
      state: "running",
      detail: {
        broker_state: "ready",
        recovery_time_ms: now - incident.recovery_start_ts,
        reason: incident.reason,
      },
      ts: now,
    });
    brokerSloRecorder.recordDuration("broker_recovery_time_p95", now - incident.recovery_start_ts, now);
    const completed = this.recovery;
    this.recovery = null;
    return completed ? { ...completed } : null;
  }

  _resetForTests(): void {
    this.state = "ready";
    this.recovery = null;
  }
}

export const brokerRuntime = new BrokerRuntime();

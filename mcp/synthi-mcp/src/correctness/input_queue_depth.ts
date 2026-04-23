/**
 * Input-queue depth tracker (ultraplan B2 — phase 0.5 measurement).
 *
 * "Real input-queue depth required for queue-and-apply under
 * realistic compile durations." The MCP doesn't queue inputs itself
 * (worker side, phase 2c) but it can observe how many input
 * dispatches happened while a compile was in progress — the same
 * window the worker would queue in.
 *
 * Counter shape:
 *   - inflight: how many dispatches are currently inside the
 *     compile→applied window (i.e. since the last
 *     structural-change-gate baseline was captured).
 *   - max_inflight_per_compile: peak depth observed during the most
 *     recent compile cycle.
 *   - histogram of peaks across cycles → fed into Prometheus + the
 *     PHASE_0_5_FINDINGS table.
 *
 * Wires to the structural-change gate's lifecycle:
 *   - `onCompileStart` → reset inflight + start counting.
 *   - `recordDispatch(action)` from mouse/keyboard tools.
 *   - `onCompileEnd` (called from session.ts on `applied`/`rejected`/etc)
 *     → record peak in the histogram, reset.
 */

import { eventLog } from "../events/index.js";

const HISTOGRAM_CAP = 256;

export interface QueueDepthSnapshot {
  inflight: number;
  max_inflight_current_cycle: number;
  cycles_observed: number;
  recent_peaks: number[];
}

class InputQueueDepth {
  private inflight = 0;
  private maxInflightCurrent = 0;
  private cyclesObserved = 0;
  private recentPeaks: number[] = [];
  private compileInProgress = false;

  onCompileStart(): void {
    if (this.compileInProgress) {
      // Observed without an intervening end — close the previous
      // cycle defensively so we don't drop the data.
      this.flushPeak();
    }
    this.compileInProgress = true;
    this.inflight = 0;
    this.maxInflightCurrent = 0;
  }

  /** Called from synthi_mouse / synthi_keyboard before dispatch. */
  recordDispatch(action: string): void {
    if (!this.compileInProgress) return;
    this.inflight += 1;
    if (this.inflight > this.maxInflightCurrent) {
      this.maxInflightCurrent = this.inflight;
    }
    eventLog.push({
      kind: "usage",
      metric: "tool_call",
      value: 1,
      detail: {
        kind: "input_during_compile",
        action,
        inflight: this.inflight,
      },
    });
  }

  onCompileEnd(): void {
    if (!this.compileInProgress) return;
    this.flushPeak();
    this.compileInProgress = false;
    this.inflight = 0;
    this.maxInflightCurrent = 0;
  }

  private flushPeak(): void {
    this.cyclesObserved += 1;
    this.recentPeaks.push(this.maxInflightCurrent);
    if (this.recentPeaks.length > HISTOGRAM_CAP) {
      this.recentPeaks.shift();
    }
    eventLog.push({
      kind: "usage",
      metric: "tool_call",
      value: this.maxInflightCurrent,
      detail: {
        kind: "input_queue_peak",
        cycles_observed: this.cyclesObserved,
        peak: this.maxInflightCurrent,
      },
    });
  }

  snapshot(): QueueDepthSnapshot {
    return {
      inflight: this.inflight,
      max_inflight_current_cycle: this.maxInflightCurrent,
      cycles_observed: this.cyclesObserved,
      recent_peaks: [...this.recentPeaks],
    };
  }

  reset(): void {
    this.inflight = 0;
    this.maxInflightCurrent = 0;
    this.cyclesObserved = 0;
    this.recentPeaks = [];
    this.compileInProgress = false;
  }
}

export const inputQueueDepth = new InputQueueDepth();

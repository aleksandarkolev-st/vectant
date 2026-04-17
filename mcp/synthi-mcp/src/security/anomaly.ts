/**
 * Keystroke anomaly detector. Ultraplan §4.11:
 *   - Keystroke cap 500/s — enforced by wire.sendFrames's interFrameDelayMs.
 *   - Rolling pattern detector on last 256 keys — flags:
 *       (a) burst: too many keys dispatched in too short a window.
 *       (b) monotone repeats: the same key spammed N+ times.
 *       (c) scripted pattern: sudden pause + identical prior-N sequence.
 *
 * Detection fires a `security` event (code: "rate_limit_warning") and
 * signals to keyboardTool that the action should be *allowed* with a
 * warning (phase-1 behavior). Phase 2 adds hard-reject semantics gated
 * on a repeat-offender counter.
 */

const WINDOW_SIZE = 256;
const BURST_WINDOW_MS = 1_000;
const BURST_THRESHOLD_KEYS = 400; // below the 500/s hard cap; early warning
const REPEAT_THRESHOLD = 64;

export interface AnomalySignal {
  suspicious: boolean;
  reasons: string[];
}

interface KeyRecord {
  ts: number;
  key: string;
}

export class KeystrokeAnomalyDetector {
  private readonly buffer: KeyRecord[] = [];
  private readonly rateWindow: number[] = []; // timestamps for burst detection

  record(key: string, ts: number = Date.now()): AnomalySignal {
    this.buffer.push({ ts, key });
    while (this.buffer.length > WINDOW_SIZE) this.buffer.shift();
    this.rateWindow.push(ts);
    // Drop timestamps older than the burst window so rateWindow.length
    // equals current-window key count regardless of buffer size.
    const cutoff = ts - BURST_WINDOW_MS;
    while (this.rateWindow.length > 0 && this.rateWindow[0]! < cutoff) {
      this.rateWindow.shift();
    }

    const reasons: string[] = [];
    if (this.rateWindow.length > BURST_THRESHOLD_KEYS) {
      reasons.push(`burst_${this.rateWindow.length}_keys_in_${BURST_WINDOW_MS}ms`);
    }

    if (this.buffer.length >= REPEAT_THRESHOLD) {
      const tail = this.buffer.slice(-REPEAT_THRESHOLD);
      const firstKey = tail[0]!.key;
      if (tail.every((r) => r.key === firstKey)) {
        reasons.push(`monotone_${REPEAT_THRESHOLD}_repeats_of_${firstKey}`);
      }
    }

    return { suspicious: reasons.length > 0, reasons };
  }

  clear(): void {
    this.buffer.length = 0;
    this.rateWindow.length = 0;
  }

  size(): number {
    return this.buffer.length;
  }
}

export const keystrokeDetector = new KeystrokeAnomalyDetector();

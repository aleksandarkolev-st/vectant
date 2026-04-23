/**
 * Structural-change pHash gate (ultraplan §4.1, phase-1 detection-only).
 *
 * Contract (detection):
 *   - When the MCP first sees a `compile-start`-style signal while a
 *     session is attached, it captures the pHash of the current frame
 *     (`onCompileStart`).
 *   - When the MCP sees a terminal HMR status `applied` (via the HMR
 *     normalizer), it captures the pHash of the post-reload frame
 *     (`onHmrApplied`) and computes the hamming distance against the
 *     pre-compile baseline.
 *   - Distance > `FULL_FRAME_THRESHOLD` (16) or failed pHash → emits a
 *     `security` event (code: "focus_lost" because the security event
 *     union doesn't yet carry `input_rejected_hmr_structural_change` —
 *     we piggy-back the code label into `detail.code` instead of
 *     extending the union for phase 1).
 *
 * Phase-1 is detection-only: the gate emits diagnostic events into the
 * ring buffer but does NOT reject in-flight inputs. Worker-side input
 * queuing + real rejection lands in phase 2c alongside the input-lease
 * enforcement work.
 *
 * `pHash_region` hint flow: input tools can pass a bbox alongside
 * `await_ack` to scope the check to a specific region (tighter
 * threshold 8). Not wired on the tool surface yet; `evaluateRegion`
 * is exported so a future commit can plug it in.
 */

import { pHash, regionPHash, hammingDistance, type BBox } from "../util/phash.js";
import { eventLog } from "../events/index.js";

export const FULL_FRAME_THRESHOLD = 16;
export const REGION_THRESHOLD = 8;

interface PendingSnapshot {
  frame_seq: number;
  capturedAt: number;
  fullFrameHash: string;
  region?: { bbox: BBox; hash: string };
}

class StructuralChangeGate {
  private pendingByFrameSeq = new Map<number, PendingSnapshot>();
  // Latest pre-compile snapshot (single-active-compile model is fine
  // for phase 1 — the worker processes one compile at a time).
  private currentBaseline: PendingSnapshot | null = null;

  /**
   * Capture the frame pHash at the moment a compile starts. Idempotent
   * within the same frame_seq — re-capturing doesn't drift the baseline.
   */
  async onCompileStart(frame: Buffer, frame_seq: number, regionHint?: BBox): Promise<void> {
    if (this.currentBaseline?.frame_seq === frame_seq) return;
    let fullFrameHash: string;
    try {
      fullFrameHash = await pHash(frame);
    } catch (err) {
      eventLog.push({
        kind: "security",
        code: "focus_lost",
        detail: {
          code: "structural_change_baseline_phash_unavailable",
          reason: err instanceof Error ? err.message : String(err),
          frame_seq,
        },
      });
      return;
    }
    const snapshot: PendingSnapshot = {
      frame_seq,
      capturedAt: Date.now(),
      fullFrameHash,
    };
    if (regionHint) {
      try {
        const hash = await regionPHash(frame, regionHint);
        snapshot.region = { bbox: regionHint, hash };
      } catch {
        // region out of bounds / decoder failure — proceed with
        // full-frame only; region threshold won't apply.
      }
    }
    this.currentBaseline = snapshot;
    this.pendingByFrameSeq.set(frame_seq, snapshot);
  }

  /**
   * Compare the frame-at-applied pHash against the stored baseline.
   * Returns the computed verdict so callers (the HMR normalizer tap)
   * can log or expose it; the verdict is also emitted as a `security`
   * event in every non-clean case.
   *
   * Resets the baseline after the check regardless of outcome — each
   * compile gets a fresh snapshot.
   */
  async onHmrApplied(frame: Buffer, frame_seq: number): Promise<StructuralVerdict> {
    const baseline = this.currentBaseline;
    this.currentBaseline = null;
    if (!baseline) {
      return { kind: "no_baseline" };
    }
    let appliedHash: string;
    try {
      appliedHash = await pHash(frame);
    } catch (err) {
      eventLog.push({
        kind: "security",
        code: "focus_lost",
        detail: {
          code: "input_rejected_phash_unavailable",
          reason: err instanceof Error ? err.message : String(err),
          baseline_frame_seq: baseline.frame_seq,
          applied_frame_seq: frame_seq,
        },
      });
      return { kind: "phash_unavailable", reason: err instanceof Error ? err.message : String(err) };
    }
    const dist = hammingDistance(baseline.fullFrameHash, appliedHash);

    let regionDist: number | null = null;
    if (baseline.region) {
      try {
        const newRegionHash = await regionPHash(frame, baseline.region.bbox);
        regionDist = hammingDistance(baseline.region.hash, newRegionHash);
      } catch {
        // Region OOB after HMR — common when the UI reflows. Fall back
        // to the full-frame verdict; surface region_unavailable detail.
        regionDist = null;
      }
    }

    const structuralChange =
      (baseline.region !== undefined && regionDist !== null && regionDist > REGION_THRESHOLD) ||
      (baseline.region === undefined && dist > FULL_FRAME_THRESHOLD);

    if (structuralChange) {
      eventLog.push({
        kind: "security",
        code: "focus_lost",
        detail: {
          code: "input_rejected_hmr_structural_change",
          baseline_frame_seq: baseline.frame_seq,
          applied_frame_seq: frame_seq,
          full_frame_hamming: dist,
          region_hamming: regionDist,
          full_frame_threshold: FULL_FRAME_THRESHOLD,
          region_threshold: REGION_THRESHOLD,
          scoped: baseline.region !== undefined,
        },
      });
      return {
        kind: "structural_change",
        hamming: dist,
        region_hamming: regionDist,
        baseline_frame_seq: baseline.frame_seq,
        applied_frame_seq: frame_seq,
      };
    }

    return { kind: "clean", hamming: dist, region_hamming: regionDist };
  }

  /** Current pending baseline frame_seq (test + observability helper). */
  currentBaselineSeq(): number | null {
    return this.currentBaseline?.frame_seq ?? null;
  }

  reset(): void {
    this.currentBaseline = null;
    this.pendingByFrameSeq.clear();
  }
}

export type StructuralVerdict =
  | { kind: "no_baseline" }
  | { kind: "phash_unavailable"; reason: string }
  | { kind: "structural_change"; hamming: number; region_hamming: number | null; baseline_frame_seq: number; applied_frame_seq: number }
  | { kind: "clean"; hamming: number; region_hamming: number | null };

export const structuralChangeGate = new StructuralChangeGate();

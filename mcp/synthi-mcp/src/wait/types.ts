import type { BBox } from "../util/phash.js";
import type { HmrTerminalStatus } from "../hmr.js";

export type WaitCondition =
  | "hmr"
  | "motion_settled"
  | "pixel"
  | "scene_change"
  | "text"
  | "log"
  | "element"
  | "source_state"
  | "audio";

export interface HmrConditionArgs {
  condition: "hmr";
}

export interface MotionSettledArgs {
  condition: "motion_settled";
  region?: BBox;
  still_for_ms?: number;
  threshold?: number;
  sample_interval_ms?: number;
}

export interface PixelArgs {
  condition: "pixel";
  x: number;
  y: number;
  expected_rgb?: [number, number, number];
  not_rgb?: [number, number, number];
  tolerance?: number;
  sample_interval_ms?: number;
}

export interface SceneChangeArgs {
  condition: "scene_change";
  region?: BBox;
  min_hamming?: number;
  sample_interval_ms?: number;
}

export interface TextArgs {
  condition: "text";
  substring: string;
  region?: BBox;
}

export interface LogArgs {
  condition: "log";
  pattern: string;
  since_seq?: number;
}

export interface ElementArgs {
  condition: "element";
  handle_id: string;
}

export interface SourceStateArgs {
  condition: "source_state";
  any_change?: boolean;
  since_seq?: number;
}

export interface AudioArgs {
  condition: "audio";
  // Event kind to wait for. Phase 2d defines two predicates that will be
  // implemented once the worker audio-tee is wired:
  //   - "above_threshold": audio peak exceeds `threshold_dbfs` for `window_ms`
  //   - "silence":         audio peak below `threshold_dbfs` for `window_ms`
  kind?: "above_threshold" | "silence";
  threshold_dbfs?: number;
  window_ms?: number;
}

export type WaitArgs =
  | HmrConditionArgs
  | MotionSettledArgs
  | PixelArgs
  | SceneChangeArgs
  | TextArgs
  | LogArgs
  | ElementArgs
  | SourceStateArgs
  | AudioArgs;

export type WaitOutcome =
  | { status: "resolved"; elapsedMs: number; condition: WaitCondition; evidence: Record<string, unknown> }
  | { status: "timeout"; elapsedMs: number; condition: WaitCondition; last_evidence?: Record<string, unknown> }
  | { status: "unsupported"; condition: WaitCondition; reason: string; required_tool_call?: Record<string, unknown> };

export interface HmrWaitResult extends Record<string, unknown> {
  status: HmrTerminalStatus;
  source: string;
}

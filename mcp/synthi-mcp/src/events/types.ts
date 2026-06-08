/**
 * Event log schema. Every ring entry is one of these tagged shapes.
 *
 * Producers: hmr normalizer, session manager, input sender, locate engine,
 * security middleware. The envelope is `{ts, seq, ...payload}` with a
 * monotonic `seq` assigned at push time.
 */

import type { BBox } from "../util/phash.js";
import type { HmrTerminalStatus } from "../hmr.js";

export interface BaseEventFields {
  seq: number;
  ts: number;
}

export interface LifecycleEvent extends BaseEventFields {
  kind: "lifecycle";
  state: SessionState;
  previous_state?: SessionState;
  detail?: Record<string, unknown>;
}

export interface HmrEvent extends BaseEventFields {
  kind: "hmr";
  status: HmrTerminalStatus | "intermediate";
  source: string;
  raw?: Record<string, unknown>;
}

export interface InputEvent extends BaseEventFields {
  kind: "input";
  action: string;
  payload: Record<string, unknown>;
}

export interface LeaseEvent extends BaseEventFields {
  kind: "lease";
  action:
    | "acquired"
    | "renewed"
    | "released"
    | "released_all"
    | "queued"
    | "preempted"
    | "force_released"
    | "batch_created";
  lease_id?: string;
  owner?: string;
  payload: Record<string, unknown>;
}

export interface FrameEvent extends BaseEventFields {
  kind: "frame";
  session_id: string;
  frame_seq: number;
  frame_ts_ms: number;
  ingest_ts_ms: number;
  viewport: {
    w: number;
    h: number;
    dpr: number;
  };
  is_keyframe: boolean;
  content_hash?: string;
}

export interface LocatorResolutionEvent extends BaseEventFields {
  kind: "locator_resolution";
  handle_id: string;
  description: string;
  resolved_via: "cached" | "region_match" | "re_resolved";
  reason: string;
  bbox: BBox;
  region_phash: string;
  hamming_distance?: number;
}

export interface ConsoleEvent extends BaseEventFields {
  kind: "console";
  level: "info" | "warn" | "error" | "debug";
  message: string;
  source: "worker_build_log" | "mcp_internal" | "signaling";
}

export interface ErrorEvent extends BaseEventFields {
  kind: "error";
  code: string;
  detail?: Record<string, unknown>;
}

export interface SecurityEvent extends BaseEventFields {
  kind: "security";
  code:
    | "rate_limit_warning"
    | "injection_suspected"
    | "wm_class_mismatch"
    | "unsafe_attach"
    | "sensitive_action_interstitial"
    | "focus_lost";
  detail?: Record<string, unknown>;
}

export interface SourceStateEvent extends BaseEventFields {
  kind: "source_state";
  last_changed_files: string[];
  content_hash?: string;
  detail?: Record<string, unknown>;
}

export interface UsageEvent extends BaseEventFields {
  kind: "usage";
  metric:
    | "tool_call"
    | "vision_inference"
    | "screenshot"
    | "egress_bytes";
  value: number;
  detail?: Record<string, unknown>;
}

export type EventLogEntry =
  | LifecycleEvent
  | HmrEvent
  | InputEvent
  | LeaseEvent
  | FrameEvent
  | LocatorResolutionEvent
  | ConsoleEvent
  | ErrorEvent
  | SecurityEvent
  | SourceStateEvent
  | UsageEvent;

export type EventKind = EventLogEntry["kind"];

/**
 * Session lifecycle enum — ultraplan §4.7 + §4.9.
 *
 * `warming`    : pod spawn / gstreamer init / guest bootstrap
 * `ready`      : warmed, no live peers
 * `running`    : at least one peer attached
 * `hibernated` : guest idle (Phase 2+ feature — documented for wire-forward compat)
 * `migrating`  : session moving to a new pod; `estimated_ready_at` in detail
 * `crashed`    : guest or worker crashed; requires `acknowledge_disruption`
 * `terminated` : session ended; handle released
 *
 * Unknown string values from the worker must be preserved as `"unknown"` in
 * the response envelope (protocol forward-compat invariant, ultraplan §4.8).
 */
export type SessionState =
  | "warming"
  | "ready"
  | "running"
  | "hibernated"
  | "migrating"
  | "crashed"
  | "terminated"
  | "unknown";

import type { FrameSnapshot } from "../frames.js";
import { eventLog } from "../events/index.js";
import { session } from "../session.js";
import {
  makeBrokerFrameEvent,
  makeBrokerHealthStatus,
  makeBrokerLifecycleEvent,
  type BrokerFrameEvent,
  type BrokerHealthStatus,
  type BrokerLifecycleEvent,
  type BrokerState,
  type BrokerViewport,
} from "./contracts.js";
import { brokerRuntime } from "./runtime.js";
import { sharedFrameCache } from "./frame_cache.js";

type FrameSourceWithInfo = {
  hasFrame: () => boolean;
  latestInfo?: () => { width: number; height: number; dpr?: number; seq: number; ts: number } | null;
};

function requireProducerDpr(dpr: unknown): number {
  if (typeof dpr !== "number" || !Number.isFinite(dpr) || dpr <= 0) {
    throw new Error("producer_dpr_unavailable");
  }
  return dpr;
}

export function recordBrokerFrameObservation(input: {
  session_id: string;
  frame: FrameSnapshot;
  dpr?: number;
  is_keyframe?: boolean;
}): BrokerFrameEvent {
  const ingestTs = Date.now();
  const dpr = requireProducerDpr(input.dpr ?? input.frame.dpr);
  const viewport: BrokerViewport = {
    w: input.frame.width,
    h: input.frame.height,
    dpr,
  };
  const entry = eventLog.push({
    kind: "frame",
    session_id: input.session_id,
    frame_seq: input.frame.seq,
    frame_ts_ms: input.frame.ts,
    ingest_ts_ms: ingestTs,
    viewport,
    is_keyframe: input.is_keyframe ?? false,
  });
  sharedFrameCache.putFrame({
    session_id: input.session_id,
    frame_seq: input.frame.seq,
    frame_ts_ms: input.frame.ts,
    ingest_ts_ms: ingestTs,
    viewport,
    data: input.frame.data,
    now: ingestTs,
  });
  return makeBrokerFrameEvent({
    event_id: entry.seq,
    session_id: input.session_id,
    frame_seq: input.frame.seq,
    frame_ts_ms: input.frame.ts,
    ingest_ts_ms: ingestTs,
    viewport,
    is_keyframe: input.is_keyframe ?? false,
  });
}

export function currentBrokerLifecycleEvent(): BrokerLifecycleEvent {
  const attached = session.get();
  return makeBrokerLifecycleEvent({
    event_id: eventLog.lastSeq(),
    session_id: attached?.sessionId ?? "unattached",
    state: session.getWireState(),
    state_ts_ms: session.getWireStateTs(),
  });
}

export function currentBrokerHealthStatus(now: number = Date.now()): BrokerHealthStatus {
  const attached = session.get();
  if (!attached) {
    return makeBrokerHealthStatus({
      session_id: "unattached",
      broker_state: "disconnected",
      upstream_connected: false,
    });
  }

  const wireState = session.getWireState();
  let brokerState: BrokerState = brokerRuntime.brokerState();
  if (brokerState === "ready" && (wireState === "migrating" || wireState === "crashed")) {
    brokerState = "recovering";
  } else if (brokerState === "ready" && wireState === "terminated") {
    brokerState = "disconnected";
  } else if (brokerState === "ready" && attached.peer.pc.connectionState !== "connected") {
    brokerState = "degraded";
  }

  const frames = attached.frames as FrameSourceWithInfo;
  const latest = typeof frames.latestInfo === "function" ? frames.latestInfo() : null;
  const firstFrameSeen = frames.hasFrame();
  const lastFrameAge = latest ? Math.max(0, now - latest.ts) : null;

  return makeBrokerHealthStatus({
    session_id: attached.sessionId,
    broker_state: brokerState,
    upstream_connected: attached.peer.pc.connectionState === "connected" && firstFrameSeen,
    last_frame_age_ms: lastFrameAge,
    rtt_ms: null,
    lag_ms: 0,
    queue_depth: 0,
    dropped_frames: 0,
  });
}

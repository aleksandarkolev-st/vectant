import type { RTCDataChannel } from "werift";
import { SignalingClient } from "./signaling.js";
import { Peer } from "./peer.js";
import { FrameSink } from "./frames.js";
import { SessionChannels } from "./channels.js";
import { eventLog } from "./events/index.js";
import type { SessionState as WireSessionState } from "./events/index.js";
import { locateEngine } from "./locate/index.js";
import { scanForInjection } from "./security/injection.js";
import { resolvePipelineBudgetMs } from "./protocol/index.js";
import { dispatchAckRegistry } from "./util/dispatch_ack_registry.js";
import { structuralChangeGate } from "./correctness/structural_change.js";
import { inputQueueDepth } from "./correctness/input_queue_depth.js";
import { humanActions } from "./escape_hatch/human_actions.js";
import { escapeHatchQueue } from "./escape_hatch/queue.js";

/**
 * MCP-local connection state. Distinct from the wire-level `SessionState`
 * that gets reported in the envelope (see `events/types.ts`): the MCP can
 * be `detached` while the wire state is `ready`/`running`.
 */
export type SessionState = "detached" | "attaching" | "attached" | "closed";

export interface AttachOptions {
  sessionId: string;
  signalingUrl: string;
  attachTimeoutMs?: number;
  /**
   * ICE servers the underlying RTCPeerConnection should use. When omitted,
   * the Peer falls back to Google STUN only — which is fine for most cloud
   * deploys (the worker has its own TURN via collab-server) but fails in
   * local docker-compose dev because the MCP runs on the host and can't
   * route to the worker's private container IPs without a TURN relay on
   * both ends. The attach tool resolves this from env + args before
   * calling in; callers that already have creds can pass them directly.
   */
  iceServers?: RTCIceServer[];
}

export interface AttachedSession {
  readonly sessionId: string;
  readonly signalingUrl: string;
  readonly signaling: SignalingClient;
  readonly peer: Peer;
  readonly frames: FrameSink;
  readonly channels: SessionChannels;
  readonly buildLogDC: RTCDataChannel;
  readonly terminalDC: RTCDataChannel;
  readonly compileDC: RTCDataChannel;
  readonly resolution: { width: number; height: number } | null;
}

/**
 * In-process singleton: one attached session per MCP subprocess (MVP scope).
 *
 * Attach flow:
 *   1. Open signaling WS, register as role=observer (multi-slot, co-exists
 *      with the real browser peer instead of evicting it).
 *   2. Start peer: add recvonly transceivers, create terminal DC, send offer.
 *   3. Await pc.connectionState === "connected".
 *   4. Await worker-initiated build-log DC open.
 *
 * Frames are not awaited at attach time — the user drives compile from the
 * browser and frames only start flowing once the worker's runner is up.
 * Tools that need a frame (screenshot, locate) surface `no_frame_yet` if
 * called before the first frame arrives.
 */
export interface FrameAdvance {
  frame_seq: number;
  ts_ms: number;
  observed_at: number;
}

/** Watch window beyond which a stale frame_advance no longer counts as "live".
 *  If the worker hasn't emitted in this long, the gate is disabled rather
 *  than blocking on a signal that will never arrive. */
export const FRAME_ADVANCE_FRESHNESS_WINDOW_MS = 10_000;

type FrameAdvanceListener = (fa: FrameAdvance) => void;

export interface WarmingProgress {
  stage: string;
  stage_progress_pct: number;
  estimated_ready_at?: number;
}

export interface FrameTimingSnapshot {
  total_frames: number;
  sample_count: number;
  interval_ms: {
    mean?: number;
    min?: number;
    p50?: number;
    p95?: number;
    p99?: number;
    max?: number;
  };
  pipeline_budget_estimate_ms: number;
  observed_at: number;
}

class SessionManager {
  private attached: AttachedSession | null = null;
  private state: SessionState = "detached";
  private attachPromise: Promise<AttachedSession> | null = null;
  private wireState: WireSessionState = "ready";
  private wireStateTs: number = Date.now();
  private wireUnsafeMode = false;
  private ackRequired: string | null = null; // null | "crash-recovered" | "full-reload-required"
  private lastCrashInfo: Record<string, unknown> | null = null;
  private attachedAt: number | null = null;
  private lastActivityAt: number = Date.now();
  private unsubscribers: Array<() => void> = [];
  private lastFrameAdvance: FrameAdvance | null = null;
  private frameAdvanceListeners = new Set<FrameAdvanceListener>();
  private presenceCounts: { humans: number; agents: number } = { humans: 0, agents: 1 };
  private warmingProgress: WarmingProgress | null = null;
  private frameTiming: FrameTimingSnapshot | null = null;

  getState(): SessionState {
    return this.state;
  }

  getWireState(): WireSessionState {
    return this.wireState;
  }

  getWireStateTs(): number {
    return this.wireStateTs;
  }

  isUnsafeMode(): boolean {
    return this.wireUnsafeMode;
  }

  /**
   * Presence counts reported by the signaling-server's `presence`
   * broadcasts. The MCP defaults to `{humans:0, agents:1}` (self)
   * until the first presence message arrives. Other peers connecting
   * or disconnecting push updates; the values never drift stale.
   */
  getPresenceCounts(): { humans: number; agents: number } {
    return { ...this.presenceCounts };
  }

  setPresenceCounts(counts: { humans: number; agents: number }): void {
    this.presenceCounts = {
      humans: Math.max(0, Math.floor(counts.humans)),
      agents: Math.max(0, Math.floor(counts.agents)),
    };
  }

  /**
   * Warming-progress from the worker's lifecycle messages. `null` when
   * the session isn't in `warming` or the worker hasn't reported a
   * stage yet. Consumed by the synthi_attach envelope and synthi_health.
   */
  getWarmingProgress(): WarmingProgress | null {
    return this.warmingProgress ? { ...this.warmingProgress } : null;
  }

  /**
   * Latest worker-emitted frame-timing snapshot. Populated by the
   * `{type:"frame-timing"}` handler on the build-log tap. `null` when
   * no snapshot has arrived (worker hasn't sampled yet, or the worker
   * is older than the F4 instrumentation).
   */
  getFrameTimingSnapshot(): FrameTimingSnapshot | null {
    return this.frameTiming ? { ...this.frameTiming } : null;
  }

  setFrameTimingSnapshot(snap: Omit<FrameTimingSnapshot, "observed_at">): void {
    this.frameTiming = { ...snap, observed_at: Date.now() };
  }

  setWarmingProgress(progress: WarmingProgress | null): void {
    if (progress === null) {
      this.warmingProgress = null;
      return;
    }
    this.warmingProgress = {
      stage: progress.stage,
      stage_progress_pct: Math.max(0, Math.min(100, Math.floor(progress.stage_progress_pct))),
      ...(progress.estimated_ready_at !== undefined
        ? { estimated_ready_at: progress.estimated_ready_at }
        : {}),
    };
  }

  getAttachedAt(): number | null {
    return this.attachedAt;
  }

  getLastActivityAt(): number {
    return this.lastActivityAt;
  }

  touch(): void {
    this.lastActivityAt = Date.now();
  }

  setWireState(state: WireSessionState, detail?: Record<string, unknown>): void {
    if (state === this.wireState) return;
    const previous = this.wireState;
    this.wireState = state;
    this.wireStateTs = Date.now();
    eventLog.push({
      kind: "lifecycle",
      state,
      previous_state: previous,
      ...(detail !== undefined ? { detail } : {}),
    });
  }

  markUnsafeMode(): void {
    if (this.wireUnsafeMode) return;
    this.wireUnsafeMode = true;
    eventLog.push({
      kind: "security",
      code: "unsafe_attach",
    });
  }

  markDisruption(kind: "crash-recovered" | "full-reload-required", info: Record<string, unknown>): void {
    this.ackRequired = kind;
    this.lastCrashInfo = { kind, ...info, ts: Date.now() };
  }

  disruptionPending(): string | null {
    return this.ackRequired;
  }

  crashInfo(): Record<string, unknown> | null {
    return this.lastCrashInfo;
  }

  clearDisruption(): string | null {
    const cleared = this.ackRequired;
    this.ackRequired = null;
    return cleared;
  }

  // ---------------------------------------------------------------------
  // Frame-advance gate (§4.4)
  //
  // Worker emits `{type:"frame-advance", frame_seq, ts_ms}` on build-log
  // alongside every RTP write. Tracking the most recent one lets
  // `wait({condition:"hmr"})` stall the final resolution until a post-reload
  // frame has actually been sent, so the next screenshot is guaranteed to
  // reflect the applied change. Until a frame-advance is observed, the
  // gate is disabled and wait_hmr behaves as before.
  // ---------------------------------------------------------------------

  setFrameAdvance(frame_seq: number, ts_ms: number, now: number = Date.now()): void {
    const fa: FrameAdvance = { frame_seq, ts_ms, observed_at: now };
    this.lastFrameAdvance = fa;
    for (const l of this.frameAdvanceListeners) {
      try {
        l(fa);
      } catch {
        // listeners must not break the advance path
      }
    }
  }

  getFrameAdvance(): FrameAdvance | null {
    return this.lastFrameAdvance;
  }

  onFrameAdvance(cb: FrameAdvanceListener): () => void {
    this.frameAdvanceListeners.add(cb);
    return (): void => {
      this.frameAdvanceListeners.delete(cb);
    };
  }

  pipelineBudgetMs(): number {
    return resolvePipelineBudgetMs();
  }

  frameSeqGateEnabled(now: number = Date.now()): boolean {
    if (!this.lastFrameAdvance) return false;
    return now - this.lastFrameAdvance.observed_at < FRAME_ADVANCE_FRESHNESS_WINDOW_MS;
  }

  /**
   * Block until the latest frame_advance has a `ts_ms >= minTsMs`, up to
   * `timeoutMs`. Returns the final advance, or `null` if the timeout elapsed
   * or the gate is disabled (no recent advances observed).
   *
   * Gate-disabled returns null immediately rather than racing — callers
   * treat null as "we can't prove the post-reload frame landed; proceed
   * anyway".
   */
  async awaitFrameAdvanceAtOrAfter(
    minTsMs: number,
    timeoutMs: number
  ): Promise<FrameAdvance | null> {
    if (!this.frameSeqGateEnabled()) return null;
    if (this.lastFrameAdvance && this.lastFrameAdvance.ts_ms >= minTsMs) {
      return this.lastFrameAdvance;
    }
    return new Promise<FrameAdvance | null>((resolve) => {
      let settled = false;
      const settle = (value: FrameAdvance | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsub();
        resolve(value);
      };
      const unsub = this.onFrameAdvance((fa) => {
        if (fa.ts_ms >= minTsMs) settle(fa);
      });
      const timer = setTimeout(() => settle(null), timeoutMs);
    });
  }

  get(): AttachedSession | null {
    return this.attached;
  }

  require(): AttachedSession {
    if (!this.attached || this.state !== "attached") {
      throw new Error("not_attached");
    }
    return this.attached;
  }

  async attach(opts: AttachOptions): Promise<AttachedSession> {
    if (this.state === "attached" && this.attached) {
      return this.attached;
    }
    if (this.state === "attaching" && this.attachPromise) {
      return this.attachPromise;
    }

    this.state = "attaching";
    this.attachPromise = this.doAttach(opts);
    try {
      const result = await this.attachPromise;
      return result;
    } catch (err) {
      this.state = "detached";
      this.attachPromise = null;
      throw err;
    }
  }

  private async doAttach(opts: AttachOptions): Promise<AttachedSession> {
    const attachTimeoutMs = opts.attachTimeoutMs ?? 60_000;
    const dbg = (m: string): void => {
      const ts = new Date().toISOString().slice(11, 23);
      process.stderr.write(`[mcp ${ts}] session: ${m}\n`);
    };
    dbg(`attach start sid=${opts.sessionId} signaling=${opts.signalingUrl} timeout=${attachTimeoutMs}ms`);

    // Phase-4 role selection. Defaults to `observer` for Path-A local dev
    // (zero-auth, MCP shares the browser slot). Flip to `mcp-agent` via
    // SYNTHI_MCP_ROLE when the signaling-server is running scoped agent
    // auth + TURN minting — in that mode we also forward SYNTHI_AGENT_TOKEN
    // on register so the server can bind us to a session + subject.
    const envRole = process.env["SYNTHI_MCP_ROLE"];
    const role = envRole === "mcp-agent" ? "mcp-agent" : "observer";
    const agentToken = process.env["SYNTHI_AGENT_TOKEN"];
    const signaling = new SignalingClient({
      url: opts.signalingUrl,
      sessionId: opts.sessionId,
      role,
      connectTimeoutMs: 10_000,
      clientVersion: "synthi-mcp/0.1.0",
      supportedProtocols: [1],
      ...(agentToken ? { agentToken } : {}),
    });
    // Listen for {type:"presence"} broadcasts from the signaling-server.
    // These arrive on register + disconnect of any peer in the session,
    // so attached_humans / attached_agents reflect real peer state
    // instead of a hardcoded fallback.
    const unsubPresence = signaling.onMessage((msg) => {
      if (msg.type !== "presence") return;
      const humans = typeof msg["attached_humans"] === "number" ? (msg["attached_humans"] as number) : undefined;
      const agents = typeof msg["attached_agents"] === "number" ? (msg["attached_agents"] as number) : undefined;
      if (humans !== undefined && agents !== undefined) {
        this.setPresenceCounts({ humans, agents });
      }
    });
    this.unsubscribers.push(unsubPresence);
    await signaling.connect();
    dbg(`signaling connected`);

    const peerOpts: { signaling: SignalingClient; connectTimeoutMs: number; iceServers?: RTCIceServer[] } = {
      signaling,
      connectTimeoutMs: attachTimeoutMs,
    };
    // Phase-4: if the server minted TURN credentials on the `registered`
    // ack, splice them in front of any caller-supplied iceServers so
    // relay candidates are tried first. Caller overrides still win when
    // SYNTHI_MCP_ICE_POLICY=all is forced downstream.
    const issuedTurn = signaling.turn();
    const mergedIceServers: RTCIceServer[] = [];
    if (issuedTurn) {
      mergedIceServers.push({
        urls: issuedTurn.urls,
        username: issuedTurn.username,
        credential: issuedTurn.credential,
      });
      dbg(`turn: using issued credentials (expires ${new Date(issuedTurn.expires_at * 1000).toISOString()})`);
    }
    if (opts.iceServers !== undefined) {
      mergedIceServers.push(...opts.iceServers);
    }
    if (mergedIceServers.length > 0) {
      peerOpts.iceServers = mergedIceServers;
    }
    const peer = new Peer(peerOpts);
    await peer.start();
    dbg(`peer.start() returned; awaiting connected + DCs`);

    const dcWaiter = (label: string, p: Promise<unknown>): Promise<unknown> =>
      p.then((v) => { dbg(`ready.${label} resolved`); return v; },
             (e) => { dbg(`ready.${label} rejected: ${(e as Error).message}`); throw e; });
    // Wait for the peer connection to reach connected + build-log + terminal + compile.
    const [, buildLogDC, terminalDC, compileDC] = await Promise.all([
      dcWaiter("connected", peer.ready.connected),
      dcWaiter("buildLogDC", peer.ready.buildLogDC),
      dcWaiter("terminalDC", peer.ready.terminalDC),
      dcWaiter("compileDC", peer.ready.compileDC),
    ]) as [void, RTCDataChannel, RTCDataChannel, RTCDataChannel];

    const videoTrack = await peer.ready.videoTrack;
    const frames = new FrameSink(videoTrack);

    const channels = new SessionChannels(terminalDC, buildLogDC, compileDC);

    const attached: AttachedSession = {
      sessionId: opts.sessionId,
      signalingUrl: opts.signalingUrl,
      signaling,
      peer,
      frames,
      channels,
      buildLogDC,
      terminalDC,
      compileDC,
      resolution: frames.dimensions(),
    };
    this.attached = attached;
    this.state = "attached";
    this.attachedAt = Date.now();
    this.lastActivityAt = this.attachedAt;
    this.setWireState("running");

    // Wire event-log taps.
    const unsubHmr = channels.hmr.onMessage((msg) => {
      const status = typeof msg["status"] === "string" ? (msg["status"] as string) : undefined;
      const evType = typeof msg["event"] === "string" ? (msg["event"] as string) : undefined;
      const msgType = typeof msg["type"] === "string" ? (msg["type"] as string) : undefined;
      const label = status ?? evType ?? msgType ?? "unknown";

      // Frame advance: `{type:"frame-advance", frame_seq, ts_ms}`. Worker
      // emits one alongside every RTP write; we keep only the latest for
      // the gate in `wait({condition:"hmr"})`. Never pushed to the event
      // log — one per frame would drown everything else in the ring.
      if (msgType === "frame-advance") {
        const fs = typeof msg["frame_seq"] === "number" ? (msg["frame_seq"] as number) : undefined;
        const tsMs = typeof msg["ts_ms"] === "number" ? (msg["ts_ms"] as number) : undefined;
        if (fs !== undefined && tsMs !== undefined) {
          this.setFrameAdvance(fs, tsMs);
        }
        return;
      }

      // Worker-emitted lifecycle transitions. Shape:
      //   {type:"lifecycle", state:"warming"|"ready"|"running"|..., warming_progress?:{stage, stage_progress_pct, estimated_ready_at?}}
      // Drive `setWireState` so `synthi_attach` + `synthi_health`
      // envelopes surface the real worker state + warming progress.
      if (msgType === "lifecycle") {
        const rawState = typeof msg["state"] === "string" ? (msg["state"] as string) : "unknown";
        const KNOWN_STATES = [
          "warming", "ready", "running", "hibernated",
          "migrating", "crashed", "terminated",
        ] as const;
        const mapped = (KNOWN_STATES as readonly string[]).includes(rawState)
          ? (rawState as typeof KNOWN_STATES[number])
          : "unknown";
        const warming = msg["warming_progress"] as Record<string, unknown> | undefined;
        if (warming && typeof warming === "object") {
          this.setWarmingProgress({
            stage: typeof warming["stage"] === "string" ? (warming["stage"] as string) : "unknown",
            stage_progress_pct: typeof warming["stage_progress_pct"] === "number"
              ? (warming["stage_progress_pct"] as number)
              : 0,
            ...(typeof warming["estimated_ready_at"] === "number"
              ? { estimated_ready_at: warming["estimated_ready_at"] as number }
              : {}),
          });
        } else {
          this.setWarmingProgress(null);
        }
        this.setWireState(mapped, warming ? { warming_progress: warming } : undefined);
        return;
      }

      // Worker-emitted security events (e.g. WM_CLASS spoof). Shape:
      //   {type:"security", code:string, detail:{...}}
      // We mirror them into the MCP event log so synthi_get_event_log +
      // the synthi://preview/events resource surface them immediately.
      // Phase 1 is detection-only: the worker still dispatches input,
      // the agent decides what to do.
      if (msgType === "security") {
        const code = typeof msg["code"] === "string" ? (msg["code"] as string) : "unknown";
        const detail = msg["detail"] as Record<string, unknown> | undefined;
        const ALLOWED_CODES = [
          "wm_class_mismatch",
          "unsafe_attach",
          "injection_suspected",
          "rate_limit_warning",
          "focus_lost",
          "sensitive_action_interstitial",
        ] as const;
        const mapped = (ALLOWED_CODES as readonly string[]).includes(code)
          ? (code as typeof ALLOWED_CODES[number])
          : "focus_lost";
        eventLog.push({
          kind: "security",
          code: mapped,
          ...(detail !== undefined ? { detail } : {}),
        });
        return;
      }

      // Worker-emitted frame-timing snapshot (F4 VFR + F2 pipeline-
      // budget recal cadence). Shape:
      //   {type:"frame-timing", total_frames, sample_count,
      //    interval_ms:{mean,min,p50,p95,p99,max},
      //    pipeline_budget_estimate_ms}
      // Recorded as a usage event so PHASE_0_5_FINDINGS.md can be
      // backfilled from event-log queries. Also tracked on the session
      // so synthi_health / synthi_get_usage can surface the latest
      // snapshot synchronously.
      if (msgType === "frame-timing") {
        const interval = msg["interval_ms"] as Record<string, unknown> | undefined;
        const sampleCount = typeof msg["sample_count"] === "number" ? (msg["sample_count"] as number) : 0;
        const totalFrames = typeof msg["total_frames"] === "number" ? (msg["total_frames"] as number) : 0;
        const budget = typeof msg["pipeline_budget_estimate_ms"] === "number"
          ? (msg["pipeline_budget_estimate_ms"] as number)
          : 0;
        this.setFrameTimingSnapshot({
          total_frames: totalFrames,
          sample_count: sampleCount,
          interval_ms: (interval as { mean?: number; min?: number; p50?: number; p95?: number; p99?: number; max?: number }) ?? {},
          pipeline_budget_estimate_ms: budget,
        });
        eventLog.push({
          kind: "usage",
          metric: "tool_call",
          value: 1,
          detail: {
            kind: "frame_timing",
            total_frames: totalFrames,
            sample_count: sampleCount,
            ...(interval !== undefined ? { interval_ms: interval } : {}),
            pipeline_budget_estimate_ms: budget,
          },
        });
        return;
      }

      // Worker-emitted human-action event. Shape:
      //   {type:"human-action", sessionId, source:"human", kind, peer_id, ts_ms, detail}
      // Worker stamps this on every gui-event whose origin peer is
      // registered with PeerRole::Browser. The MCP ring buffer feeds
      // `synthi_recent_human_actions` so agents can branch on whether
      // a human has been driving the session concurrently.
      if (msgType === "human-action") {
        const rawKind = typeof msg["kind"] === "string" ? (msg["kind"] as string) : "other";
        // Map wire kind to the schema-constrained enum expected by the
        // humanActions ring. The worker emits "mouse" | "key" |
        // "stop-runner" | ... today; collapse anything non-mouse /
        // non-keyboard into "other".
        let mapped: "mouse" | "keyboard" | "other";
        if (rawKind === "mouse") mapped = "mouse";
        else if (rawKind === "key" || rawKind === "keyboard") mapped = "keyboard";
        else mapped = "other";
        const peerId = typeof msg["peer_id"] === "string" ? (msg["peer_id"] as string) : undefined;
        const ts = typeof msg["ts_ms"] === "number" ? (msg["ts_ms"] as number) : Date.now();
        const detail = msg["detail"] as Record<string, unknown> | undefined;
        humanActions.record({
          kind: mapped,
          ts,
          ...(peerId !== undefined ? { source_peer_id: peerId } : {}),
          ...(detail !== undefined ? { detail } : {}),
        });
        // Also mirror into the event log as an `input` event with
        // source-attribution, so event-log consumers see it without
        // having to query the ring separately.
        eventLog.push({
          kind: "input",
          action: "human:" + mapped,
          payload: {
            kind: mapped,
            ...(peerId !== undefined ? { peer_id: peerId } : {}),
            source: "human",
          },
        });
        return;
      }

      // Worker-emitted guest-registered event (ultraplan §Security v4
      // pre-work #5-#6). Shape:
      //   {type:"guest-registered", root_pid, binary_path, binary_fingerprint, ...}
      // Recorded as a console event for observability; tools query the
      // synthi://preview/events stream to see when a new guest comes up.
      if (msgType === "guest-registered") {
        eventLog.push({
          kind: "console",
          level: "info",
          message: `[guest_registered] pid=${msg["root_pid"]} binary=${msg["binary_path"]}`,
          source: "worker_build_log",
        });
        return;
      }

      // Input ack: `{type:"input-ack", dispatch_id, accepted, reason?}`.
      // Worker echoes one per input event that carried a dispatch_id.
      // Resolve the DispatchAckRegistry so any caller awaiting the ack
      // (phase-1 infra; tool-layer opt-in follow-up) unblocks.
      if (msgType === "input-ack") {
        const did = typeof msg["dispatch_id"] === "string" ? (msg["dispatch_id"] as string) : undefined;
        const accepted = typeof msg["accepted"] === "boolean" ? (msg["accepted"] as boolean) : undefined;
        if (did !== undefined && accepted !== undefined) {
          const reason = typeof msg["reason"] === "string" ? (msg["reason"] as string) : undefined;
          const payload: { dispatch_id: string; accepted: boolean; reason?: string } = { dispatch_id: did, accepted };
          if (reason !== undefined) payload.reason = reason;
          dispatchAckRegistry.resolveAck(payload);
          eventLog.push({
            kind: "input",
            action: "ack",
            payload: { dispatch_id: did, accepted, ...(reason !== undefined ? { reason } : {}) },
          });
        }
        return;
      }

      // Structural-change pHash gate (ultraplan §4.1). Capture a
      // baseline pHash on compile-start; evaluate against post-reload
      // frame on `applied`. Phase 1 is detection-only — we emit a
      // security event; no input queue flush yet (phase 2c).
      const isCompileStart =
        (msgType === "compile-start") ||
        (msgType === "hmr-status" && status === "reload-planned") ||
        (status === "Enqueued") ||
        (evType === "Enqueued");
      if (isCompileStart) {
        // Open the input-queue-depth window — every dispatch from the
        // mouse/keyboard tools until the next applied/rejected/etc
        // counts toward the peak.
        inputQueueDepth.onCompileStart();
        // Snapshot current frame without blocking the tap. The gate
        // emits its own error event if the snapshot fails.
        const frameSink = attached.frames;
        const snapshotFrame = async (): Promise<void> => {
          try {
            const frame = await frameSink.getFrame();
            await structuralChangeGate.onCompileStart(frame.data, frame.seq);
          } catch {
            // No frame yet — gate will no-op on the applied check
            // because there's no baseline to compare against.
          }
        };
        // Fire-and-forget; errors are captured inside
        void snapshotFrame();
      }

      // Only tap terminal events to the log — intermediate ones flood the
      // ring. Classification happens in the normalizer; we mirror a short
      // label for observability without re-parsing.
      const isTerminal = status === "applied" || status === "rejected" ||
        status === "compile-error" || status === "full-reload-required" ||
        status === "state-migrated" || evType === "Promoted" || evType === "RolledBack" ||
        evType === "Discarded";
      eventLog.push({
        kind: "hmr",
        status: isTerminal ? (label as "applied") : "intermediate",
        source: msgType ?? "build-log",
        raw: msg,
      });

      // Structural-change verdict on every `applied` / `Promoted` —
      // compute the post-reload pHash and compare to the baseline
      // captured at compile-start.
      if (status === "applied" || evType === "Promoted") {
        // Close the queue-depth window — record peak in histogram.
        inputQueueDepth.onCompileEnd();
        const frameSink = attached.frames;
        const pipelineBudget = this.pipelineBudgetMs();
        void (async (): Promise<void> => {
          try {
            // Wait for a post-reload frame with the gate's pipeline
            // budget so we don't sample the stale pre-reload frame.
            await new Promise((r) => setTimeout(r, pipelineBudget));
            const frame = await frameSink.getFrame();
            await structuralChangeGate.onHmrApplied(frame.data, frame.seq);
          } catch {
            // Absent frame sink is non-fatal; the gate already emits
            // `input_rejected_phash_unavailable` when the snapshot
            // fails. For "no frame at all" we simply skip the check.
          }
        })();
      }
      // Close the window on terminal-but-not-applied statuses too,
      // otherwise inflight bleeds into the next cycle.
      if (
        status === "rejected" ||
        status === "compile-error" ||
        status === "full-reload-required" ||
        evType === "RolledBack" ||
        evType === "Discarded"
      ) {
        inputQueueDepth.onCompileEnd();
      }

      // Injection-heuristic pre-screen: any free-text field in the wire
      // might be a prompt-injection vector since the preview content
      // renders in our LLM's context.
      const textFields = [msg["message"], msg["reason"], msg["stdout"], msg["stderr"]];
      for (const f of textFields) {
        if (typeof f === "string") {
          const matches = scanForInjection(f);
          if (matches.length > 0) {
            eventLog.push({
              kind: "security",
              code: "injection_suspected",
              detail: { matches, source: "build-log" },
            });
          }
        }
      }
    });
    this.unsubscribers.push(unsubHmr);

    const unsubLocator = locateEngine.onResolution((ev) => {
      eventLog.push({
        kind: "locator_resolution",
        handle_id: ev.handle_id,
        description: ev.description,
        resolved_via: ev.resolved_via,
        reason: ev.reason,
        bbox: ev.bbox,
        region_phash: ev.region_phash,
        ...(ev.hamming_distance !== undefined ? { hamming_distance: ev.hamming_distance } : {}),
      });
    });
    this.unsubscribers.push(unsubLocator);

    return attached;
  }

  async close(): Promise<void> {
    if (this.state === "closed") return;
    this.state = "closed";
    this.setWireState("terminated");
    // Phase-3: fail any pending escape-hatch entries deterministically so
    // blocked agents get `escape_hatch_canceled` instead of hanging on a
    // queue with no consumer.
    escapeHatchQueue.cancelAll("session_detach");
    for (const unsub of this.unsubscribers) {
      try {
        unsub();
      } catch {
        // ignored
      }
    }
    this.unsubscribers = [];
    if (this.attached) {
      try {
        this.attached.channels.dispose();
      } catch {
        // ignored
      }
      try {
        this.attached.frames.stop();
      } catch {
        // ignored
      }
      try {
        await this.attached.peer.close();
      } catch {
        // ignored
      }
      try {
        await this.attached.signaling.close();
      } catch {
        // ignored
      }
      this.attached = null;
    }
    this.attachPromise = null;
  }

  /** Reset to a fresh state — used between tests. */
  _resetForTests(): void {
    this.attached = null;
    this.attachPromise = null;
    this.state = "detached";
    this.wireState = "ready";
    this.wireStateTs = Date.now();
    this.wireUnsafeMode = false;
    this.ackRequired = null;
    this.lastCrashInfo = null;
    this.attachedAt = null;
    this.lastActivityAt = Date.now();
    this.lastFrameAdvance = null;
    this.frameAdvanceListeners.clear();
    this.presenceCounts = { humans: 0, agents: 1 };
    for (const unsub of this.unsubscribers) {
      try { unsub(); } catch { /* ignored */ }
    }
    this.unsubscribers = [];
  }
}

export const session = new SessionManager();

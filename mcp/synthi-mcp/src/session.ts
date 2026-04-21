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

    const signaling = new SignalingClient({
      url: opts.signalingUrl,
      sessionId: opts.sessionId,
      role: "observer",
      connectTimeoutMs: 10_000,
      clientVersion: "synthi-mcp/0.1.0",
      supportedProtocols: [1],
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
    if (opts.iceServers !== undefined) {
      peerOpts.iceServers = opts.iceServers;
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

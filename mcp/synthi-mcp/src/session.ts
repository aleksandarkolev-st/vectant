import type wrtc from "@roamhq/wrtc";
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
  firstFrameTimeoutMs?: number;
}

export interface AttachedSession {
  readonly sessionId: string;
  readonly signalingUrl: string;
  readonly signaling: SignalingClient;
  readonly peer: Peer;
  readonly frames: FrameSink;
  readonly channels: SessionChannels;
  readonly buildLogDC: wrtc.RTCDataChannel;
  readonly terminalDC: wrtc.RTCDataChannel;
  readonly compileDC: wrtc.RTCDataChannel;
  readonly resolution: { width: number; height: number };
}

/**
 * In-process singleton: one attached session per MCP subprocess (MVP scope).
 *
 * Attach flow:
 *   1. Open signaling WS, register as role=browser.
 *   2. Start peer: add recvonly transceivers, create terminal DC, send offer.
 *   3. Await pc.connectionState === "connected".
 *   4. Await worker-initiated build-log DC open.
 *   5. Await first video frame — attach's "ready" signal.
 *
 * All four signals must fire before attach resolves. Any one failing aborts.
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
    const attachTimeoutMs = opts.attachTimeoutMs ?? 30_000;
    const firstFrameTimeoutMs = opts.firstFrameTimeoutMs ?? 15_000;

    const signaling = new SignalingClient({
      url: opts.signalingUrl,
      sessionId: opts.sessionId,
      role: "browser",
      connectTimeoutMs: 10_000,
      clientVersion: "synthi-mcp/0.1.0",
      supportedProtocols: [1],
    });
    await signaling.connect();

    const peer = new Peer({ signaling, connectTimeoutMs: attachTimeoutMs });
    await peer.start();

    // Wait for the peer connection to reach connected + build-log + terminal + compile.
    const [, buildLogDC, terminalDC, compileDC] = await Promise.all([
      peer.ready.connected,
      peer.ready.buildLogDC,
      peer.ready.terminalDC,
      peer.ready.compileDC,
    ]);

    const videoTrack = await peer.ready.videoTrack;
    const frames = new FrameSink(videoTrack);
    await frames.waitForFirstFrame(firstFrameTimeoutMs);

    const dims = frames.dimensions();
    if (!dims) {
      throw new Error("no_frame_after_wait");
    }

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
      resolution: dims,
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
    for (const unsub of this.unsubscribers) {
      try { unsub(); } catch { /* ignored */ }
    }
    this.unsubscribers = [];
  }
}

export const session = new SessionManager();

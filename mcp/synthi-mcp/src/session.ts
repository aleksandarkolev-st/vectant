import type wrtc from "@roamhq/wrtc";
import { SignalingClient } from "./signaling.js";
import { Peer } from "./peer.js";
import { FrameSink } from "./frames.js";
import { SessionChannels } from "./channels.js";
import { eventLog } from "./events/index.js";
import type { SessionState as WireSessionState } from "./events/index.js";
import { locateEngine } from "./locate/index.js";
import { scanForInjection } from "./security/injection.js";

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
    });
    await signaling.connect();

    const peer = new Peer({ signaling, connectTimeoutMs: attachTimeoutMs });
    await peer.start();

    // Wait for the peer connection to reach connected + build-log + terminal.
    const [, buildLogDC, terminalDC] = await Promise.all([
      peer.ready.connected,
      peer.ready.buildLogDC,
      peer.ready.terminalDC,
    ]);

    const videoTrack = await peer.ready.videoTrack;
    const frames = new FrameSink(videoTrack);
    await frames.waitForFirstFrame(firstFrameTimeoutMs);

    const dims = frames.dimensions();
    if (!dims) {
      throw new Error("no_frame_after_wait");
    }

    const channels = new SessionChannels(terminalDC, buildLogDC);

    const attached: AttachedSession = {
      sessionId: opts.sessionId,
      signalingUrl: opts.signalingUrl,
      signaling,
      peer,
      frames,
      channels,
      buildLogDC,
      terminalDC,
      resolution: dims,
    };
    this.attached = attached;
    this.state = "attached";
    this.attachedAt = Date.now();
    this.lastActivityAt = this.attachedAt;
    this.setWireState("running");

    // Wire event-log taps.
    const unsubHmr = channels.hmr.onMessage((msg) => {
      // Only tap terminal events to the log — intermediate ones flood the
      // ring. Classification happens in the normalizer; we mirror a short
      // label for observability without re-parsing.
      const status = typeof msg["status"] === "string" ? (msg["status"] as string) : undefined;
      const evType = typeof msg["event"] === "string" ? (msg["event"] as string) : undefined;
      const msgType = typeof msg["type"] === "string" ? (msg["type"] as string) : undefined;
      const label = status ?? evType ?? msgType ?? "unknown";
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
    for (const unsub of this.unsubscribers) {
      try { unsub(); } catch { /* ignored */ }
    }
    this.unsubscribers = [];
  }
}

export const session = new SessionManager();

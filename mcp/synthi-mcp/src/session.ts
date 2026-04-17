import type wrtc from "@roamhq/wrtc";
import { SignalingClient } from "./signaling.js";
import { Peer } from "./peer.js";
import { FrameSink } from "./frames.js";
import { SessionChannels } from "./channels.js";

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

  getState(): SessionState {
    return this.state;
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
    return attached;
  }

  async close(): Promise<void> {
    if (this.state === "closed") return;
    this.state = "closed";
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
}

export const session = new SessionManager();

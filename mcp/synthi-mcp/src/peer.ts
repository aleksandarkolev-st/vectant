import wrtc from "@roamhq/wrtc";
import type { SignalingClient, SignalingMessage } from "./signaling.js";

const {
  RTCPeerConnection,
  RTCSessionDescription,
  RTCIceCandidate,
} = wrtc;

export type DataChannelLabel = "build-log" | "terminal" | "compile" | "emulator-input" | "file-sync";

export interface PeerOptions {
  signaling: SignalingClient;
  iceServers?: RTCIceServer[];
  offerRetryMs?: number;
  connectTimeoutMs?: number;
}

export interface PeerReadyState {
  /** Resolves when `pc.connectionState === "connected"`. */
  connected: Promise<void>;
  /** Resolves with the first received video MediaStreamTrack. */
  videoTrack: Promise<wrtc.MediaStreamTrack>;
  /** Resolves with the worker-created `build-log` DC once it opens. */
  buildLogDC: Promise<wrtc.RTCDataChannel>;
  /** Resolves with the MCP-created `terminal` DC once it opens. */
  terminalDC: Promise<wrtc.RTCDataChannel>;
  /** Resolves with the MCP-created `compile` DC once it opens.
   *  Needed for `synthi_compile` to dispatch CompileRequest payloads. */
  compileDC: Promise<wrtc.RTCDataChannel>;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (err: Error) => void;
  settled: boolean;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const d: Deferred<T> = {
    promise,
    settled: false,
    resolve: (v) => {
      if (d.settled) return;
      d.settled = true;
      resolve(v);
    },
    reject: (e) => {
      if (d.settled) return;
      d.settled = true;
      reject(e);
    },
  };
  return d;
}

/**
 * Wraps @roamhq/wrtc `RTCPeerConnection` with the Synthi signaling protocol.
 *
 * Mimics `synthi/src/services/compilerClient.js:884-946` for offer creation
 * and data-channel setup. The MCP registers as an `observer` peer (co-exists
 * with the real browser) but still creates the offer, creates the `terminal`
 * data channel, receives `build-log` from the worker via `ondatachannel`,
 * and receives video via `ontrack`.
 */
export class Peer {
  readonly pc: wrtc.RTCPeerConnection;
  readonly ready: PeerReadyState;

  private readonly signaling: SignalingClient;
  private readonly offerRetryMs: number;
  private readonly connectedD = deferred<void>();
  private readonly videoTrackD = deferred<wrtc.MediaStreamTrack>();
  private readonly buildLogDcD = deferred<wrtc.RTCDataChannel>();
  private readonly terminalDcD = deferred<wrtc.RTCDataChannel>();
  private readonly compileDcD = deferred<wrtc.RTCDataChannel>();
  private offerRetryTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private remoteDescriptionSet = false;

  constructor(opts: PeerOptions) {
    this.signaling = opts.signaling;
    this.offerRetryMs = opts.offerRetryMs ?? 2_000;

    const iceServers = opts.iceServers ?? [{ urls: "stun:stun.l.google.com:19302" }];
    this.pc = new RTCPeerConnection({ iceServers });

    this.ready = {
      connected: this.connectedD.promise,
      videoTrack: this.videoTrackD.promise,
      buildLogDC: this.buildLogDcD.promise,
      terminalDC: this.terminalDcD.promise,
      compileDC: this.compileDcD.promise,
    };

    this.wirePeerEvents();
    this.wireSignalingEvents();

    const connectTimeoutMs = opts.connectTimeoutMs ?? 30_000;
    setTimeout(() => {
      if (!this.connectedD.settled) {
        this.connectedD.reject(new Error(`peer_connect_timeout after ${connectTimeoutMs}ms`));
      }
    }, connectTimeoutMs);
  }

  private wirePeerEvents(): void {
    this.pc.addEventListener("connectionstatechange", () => {
      const state = this.pc.connectionState;
      if (state === "connected") {
        this.connectedD.resolve();
      } else if (state === "failed" || state === "closed") {
        this.connectedD.reject(new Error(`peer_connection_${state}`));
      }
    });

    this.pc.addEventListener("icecandidate", (event: unknown) => {
      const candidate = (event as { candidate: RTCIceCandidate | null }).candidate;
      if (candidate === null) return;
      try {
        this.signaling.send({
          type: "candidate",
          candidate: candidate.toJSON(),
        });
      } catch {
        // signaling may be closed; ignore
      }
    });

    this.pc.addEventListener("track", (event: unknown) => {
      const track = (event as { track: wrtc.MediaStreamTrack }).track;
      if (track.kind === "video") {
        this.videoTrackD.resolve(track);
      }
    });

    this.pc.addEventListener("datachannel", (event: unknown) => {
      const dc = (event as { channel: wrtc.RTCDataChannel }).channel;
      if (dc.label === "build-log") {
        if (dc.readyState === "open") {
          this.buildLogDcD.resolve(dc);
        } else {
          const onOpen = (): void => {
            dc.removeEventListener("open", onOpen);
            this.buildLogDcD.resolve(dc);
          };
          dc.addEventListener("open", onOpen);
        }
      }
    });
  }

  private wireSignalingEvents(): void {
    this.signaling.onMessage((msg: SignalingMessage) => {
      if (msg.type === "answer") {
        void this.handleAnswer(msg);
      } else if (msg.type === "candidate") {
        void this.handleCandidate(msg);
      }
    });

    this.signaling.onClose(() => {
      if (!this.connectedD.settled) {
        this.connectedD.reject(new Error("signaling_closed_before_connect"));
      }
    });
  }

  private async handleAnswer(msg: SignalingMessage): Promise<void> {
    const sdp = msg.sdp;
    if (typeof sdp !== "string") return;
    try {
      await this.pc.setRemoteDescription(new RTCSessionDescription({ type: "answer", sdp }));
      this.remoteDescriptionSet = true;
      this.stopOfferRetry();
      for (const candidateInit of this.pendingCandidates) {
        try {
          await this.pc.addIceCandidate(new RTCIceCandidate(candidateInit));
        } catch {
          // ignored — candidate may no longer apply
        }
      }
      this.pendingCandidates = [];
    } catch (err) {
      if (!this.connectedD.settled) {
        this.connectedD.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  private async handleCandidate(msg: SignalingMessage): Promise<void> {
    const candidate = msg.candidate as RTCIceCandidateInit | undefined;
    if (!candidate) return;
    if (!this.remoteDescriptionSet) {
      this.pendingCandidates.push(candidate);
      return;
    }
    try {
      await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch {
      // ignored — trickle race
    }
  }

  private stopOfferRetry(): void {
    if (this.offerRetryTimer) {
      clearInterval(this.offerRetryTimer);
      this.offerRetryTimer = null;
    }
  }

  /**
   * Set up transceivers + terminal DC, generate offer, send it. Retries the
   * offer every `offerRetryMs` until an answer lands (matches
   * `compilerClient.js:962-978`).
   */
  async start(): Promise<void> {
    // recvonly transceivers — without these, worker's m=video/audio won't arrive.
    this.pc.addTransceiver("video", { direction: "recvonly" });
    this.pc.addTransceiver("audio", { direction: "recvonly" });

    // Order mirrors `compilerClient.js:905-911` — compile first, terminal
    // second. WebRTC DC IDs are auto-assigned in creation order so matching
    // the browser's sequence is the lowest-risk default (worker dispatches
    // on label, not id, but uniform ordering keeps debugging sane).
    const compileDC = this.pc.createDataChannel("compile", { ordered: true });
    if (compileDC.readyState === "open") {
      this.compileDcD.resolve(compileDC);
    } else {
      compileDC.addEventListener("open", () => this.compileDcD.resolve(compileDC));
    }

    const terminalDC = this.pc.createDataChannel("terminal", { ordered: true });
    if (terminalDC.readyState === "open") {
      this.terminalDcD.resolve(terminalDC);
    } else {
      terminalDC.addEventListener("open", () => this.terminalDcD.resolve(terminalDC));
    }

    const offer = await this.pc.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: true,
    });
    await this.pc.setLocalDescription(offer);

    const offerPayload: SignalingMessage = {
      type: "offer",
      sdp: offer.sdp,
      sdp_type: offer.type,
    };
    this.signaling.send(offerPayload);

    // Offer retry: if worker is still spinning up, the offer may need to be
    // resent once the worker registers. Mirrors compilerClient.js.
    this.offerRetryTimer = setInterval(() => {
      if (this.closed) {
        this.stopOfferRetry();
        return;
      }
      if (this.pc.signalingState === "have-local-offer" && this.signaling.isOpen()) {
        try {
          this.signaling.send(offerPayload);
        } catch {
          // ignored
        }
      } else {
        this.stopOfferRetry();
      }
    }, this.offerRetryMs);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stopOfferRetry();
    try {
      this.pc.close();
    } catch {
      // ignored
    }
  }
}

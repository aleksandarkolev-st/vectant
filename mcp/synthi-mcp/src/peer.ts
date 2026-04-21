import {
  RTCPeerConnection,
  RTCIceCandidate,
  type MediaStreamTrack,
  type RTCDataChannel,
  type RTCIceCandidateInit,
  useOPUS,
  useVP8,
} from "werift";
import type { SignalingClient, SignalingMessage } from "./signaling.js";

function dbg(msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  process.stderr.write(`[mcp ${ts}] ${msg}\n`);
}

/** Parse the `typ <host|srflx|prflx|relay>` field out of an SDP candidate. */
function candidateType(candidate: string | undefined | null): string | null {
  if (!candidate) return null;
  const m = /\btyp\s+(host|srflx|prflx|relay)\b/i.exec(candidate);
  return m ? m[1]!.toLowerCase() : null;
}

/** Coerce DOM-lib RTCIceCandidateInit (allows null) into werift's shape
 *  (string | undefined only). */
function normalizeCandidateInit(c: RTCIceCandidateInit): {
  candidate: string;
  sdpMid?: string;
  sdpMLineIndex?: number;
  usernameFragment?: string;
} {
  return {
    candidate: c.candidate ?? "",
    ...(c.sdpMid != null ? { sdpMid: c.sdpMid } : {}),
    ...(c.sdpMLineIndex != null ? { sdpMLineIndex: c.sdpMLineIndex } : {}),
    ...(c.usernameFragment != null ? { usernameFragment: c.usernameFragment } : {}),
  };
}

export type DataChannelLabel = "build-log" | "terminal" | "compile" | "emulator-input" | "file-sync";

export interface PeerOptions {
  signaling: SignalingClient;
  iceServers?: RTCIceServer[];
  offerRetryMs?: number;
  connectTimeoutMs?: number;
  /**
   * ICE candidate filter policy. Defaults to "relay" when any TURN URL is
   * present in iceServers, otherwise "all". Relay-only strips host and
   * server-reflexive candidates so ICE can't nominate a flaky host↔host
   * pair (e.g. MCP's VMware/Hyper-V adapter ↔ worker's docker-bridge IP)
   * which may pass connectivity checks but drop packets after a few
   * seconds. Override with env SYNTHI_MCP_ICE_POLICY=all|relay.
   */
  iceTransportPolicy?: "all" | "relay";
}

export interface PeerReadyState {
  /** Resolves when `pc.connectionState === "connected"`. */
  connected: Promise<void>;
  /** Resolves with the first received video MediaStreamTrack. */
  videoTrack: Promise<MediaStreamTrack>;
  /** Resolves with the worker-created `build-log` DC once it opens. */
  buildLogDC: Promise<RTCDataChannel>;
  /** Resolves with the MCP-created `terminal` DC once it opens. */
  terminalDC: Promise<RTCDataChannel>;
  /** Resolves with the MCP-created `compile` DC once it opens.
   *  Needed for `synthi_compile` to dispatch CompileRequest payloads. */
  compileDC: Promise<RTCDataChannel>;
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
 * Wraps werift `RTCPeerConnection` with the Synthi signaling protocol.
 *
 * The MCP registers as an `observer` peer (co-exists with the real browser),
 * creates the offer, creates the `compile` + `terminal` data channels,
 * receives `build-log` from the worker via `onDataChannel`, and receives
 * H264 video via `onTrack`. werift ships pure TypeScript H264 RTP support;
 * `FrameSink` decodes the stream via ffmpeg.
 */
export class Peer {
  readonly pc: RTCPeerConnection;
  readonly ready: PeerReadyState;

  private readonly signaling: SignalingClient;
  private readonly offerRetryMs: number;
  private readonly iceTransportPolicy: "all" | "relay";
  private readonly connectedD = deferred<void>();
  private readonly videoTrackD = deferred<MediaStreamTrack>();
  private readonly buildLogDcD = deferred<RTCDataChannel>();
  private readonly terminalDcD = deferred<RTCDataChannel>();
  private readonly compileDcD = deferred<RTCDataChannel>();
  private offerRetryTimer: ReturnType<typeof setInterval> | null = null;
  private offerPayload: SignalingMessage | null = null;
  private closed = false;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private remoteDescriptionSet = false;

  constructor(opts: PeerOptions) {
    this.signaling = opts.signaling;
    this.offerRetryMs = opts.offerRetryMs ?? 2_000;

    const iceServers = opts.iceServers ?? [{ urls: "stun:stun.l.google.com:19302" }];
    // DOM lib's RTCIceServer.urls allows string | string[]; werift wants a
    // single string. Flatten here so callers can pass either shape.
    const weriftIceServers = iceServers.flatMap((s) => {
      const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
      return urls.map((u) => ({
        urls: u,
        username: s.username,
        credential: typeof s.credential === "string" ? s.credential : undefined,
      }));
    });
    const hasTurn = weriftIceServers.some((s) => /^turns?:/i.test(s.urls));
    const envPolicy = (process.env.SYNTHI_MCP_ICE_POLICY || "").toLowerCase();
    const iceTransportPolicy: "all" | "relay" =
      opts.iceTransportPolicy
      ?? (envPolicy === "relay" || envPolicy === "all" ? (envPolicy as "all" | "relay") : undefined)
      ?? (hasTurn ? "relay" : "all");
    this.iceTransportPolicy = iceTransportPolicy;
    dbg(`peer: new RTCPeerConnection iceServers=${JSON.stringify(weriftIceServers.map((s) => ({ urls: s.urls, hasCred: !!s.credential })))} policy=${iceTransportPolicy}`);
    this.pc = new RTCPeerConnection({
      iceServers: weriftIceServers,
      iceTransportPolicy,
      // Worker's GStreamer pipeline emits VP8 RTP (see worker main.rs —
      // `per_peer_video` is a VP8 TrackLocalStaticRTP). Pin the MCP offer
      // to VP8+Opus so codec intersection is non-empty and the worker's
      // sender can start. H264 path was explored first, but the worker
      // team already swapped to VP8 to dodge the libwebrtc-Node H264
      // licensing gap — so VP8 is the right match end-to-end.
      codecs: {
        video: [useVP8()],
        audio: [useOPUS()],
      },
    });

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
    this.pc.connectionStateChange.subscribe((state) => {
      dbg(`peer: connectionState=${state}`);
      if (state === "connected") {
        this.connectedD.resolve();
      } else if (state === "failed" || state === "closed") {
        this.connectedD.reject(new Error(`peer_connection_${state}`));
      }
    });

    this.pc.iceConnectionStateChange.subscribe((state) => {
      dbg(`peer: iceConnectionState=${state}`);
    });
    this.pc.iceGatheringStateChange.subscribe((state) => {
      dbg(`peer: iceGatheringState=${state}`);
    });
    this.pc.signalingStateChange.subscribe((state) => {
      dbg(`peer: signalingState=${state}`);
    });

    this.pc.onIceCandidate.subscribe((candidate) => {
      if (!candidate) {
        dbg(`peer: local ICE gathering complete`);
        return;
      }
      const candStr = candidate.candidate ?? "";
      const ctype = candidateType(candStr);
      // werift still *gathers* host/srflx candidates even with
      // iceTransportPolicy=relay — it only filters pairing, not emission.
      // Suppress non-relay locals at the signaling boundary so the worker
      // never sees them and can't nominate a flaky host↔host pair.
      if (this.iceTransportPolicy === "relay" && ctype !== "relay") {
        dbg(`peer: local ICE candidate (filtered, policy=relay, typ=${ctype}) ${candStr.slice(0, 80)}`);
        return;
      }
      dbg(`peer: local ICE candidate ${candStr.slice(0, 80)}`);
      try {
        this.signaling.send({
          type: "candidate",
          candidate: candidate.toJSON(),
        });
      } catch {
        // signaling may be closed; ignore
      }
    });

    this.pc.onTrack.subscribe((track) => {
      dbg(`peer: ontrack kind=${track.kind} id=${track.id ?? track.uuid}`);
      if (track.kind === "video") {
        this.videoTrackD.resolve(track);
      }
    });

    this.pc.onDataChannel.subscribe((dc) => {
      dbg(`peer: ondatachannel label=${dc.label} readyState=${dc.readyState}`);
      if (dc.label === "build-log") {
        if (dc.readyState === "open") {
          this.buildLogDcD.resolve(dc);
        } else {
          const sub = dc.stateChange.subscribe((s) => {
            if (s === "open") {
              sub.unSubscribe();
              this.buildLogDcD.resolve(dc);
            }
          });
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
      dbg(`peer: setRemoteDescription(answer) sdp_len=${sdp.length}`);
      await this.pc.setRemoteDescription({ type: "answer", sdp });
      this.remoteDescriptionSet = true;
      this.stopOfferRetry();
      dbg(`peer: answer applied, flushing ${this.pendingCandidates.length} pending candidate(s)`);
      for (const candidateInit of this.pendingCandidates) {
        try {
          await this.pc.addIceCandidate(new RTCIceCandidate(normalizeCandidateInit(candidateInit)));
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
    const ctype = candidateType(candidate.candidate);
    // Symmetric to outgoing filter: when we're relay-only, also refuse the
    // worker's host/srflx candidates. Worker's host is its docker-internal
    // 172.18.0.x which may or may not even be routable from the MCP host.
    if (this.iceTransportPolicy === "relay" && ctype !== "relay") {
      dbg(`signaling: drop remote candidate (policy=relay, typ=${ctype}) ${(candidate.candidate ?? "").slice(0, 80)}`);
      return;
    }
    if (!this.remoteDescriptionSet) {
      this.pendingCandidates.push(candidate);
      return;
    }
    try {
      await this.pc.addIceCandidate(new RTCIceCandidate(normalizeCandidateInit(candidate)));
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
   * Set up transceivers + DCs, generate offer, send it. Retries the offer
   * every `offerRetryMs` until an answer lands (matches
   * `compilerClient.js:962-978`).
   */
  async start(): Promise<void> {
    // recvonly transceivers — without these, worker's m=video/audio won't arrive.
    this.pc.addTransceiver("video", { direction: "recvonly" });
    this.pc.addTransceiver("audio", { direction: "recvonly" });

    // Order mirrors `compilerClient.js:905-911` — compile first, terminal
    // second. Worker dispatches on label, not id, but uniform ordering
    // keeps debugging sane.
    const compileDC = this.pc.createDataChannel("compile", { ordered: true });
    if (compileDC.readyState === "open") {
      this.compileDcD.resolve(compileDC);
    } else {
      const sub = compileDC.stateChange.subscribe((s) => {
        if (s === "open") {
          sub.unSubscribe();
          this.compileDcD.resolve(compileDC);
        }
      });
    }

    const terminalDC = this.pc.createDataChannel("terminal", { ordered: true });
    if (terminalDC.readyState === "open") {
      this.terminalDcD.resolve(terminalDC);
    } else {
      const sub = terminalDC.stateChange.subscribe((s) => {
        if (s === "open") {
          sub.unSubscribe();
          this.terminalDcD.resolve(terminalDC);
        }
      });
    }

    const offer = await this.pc.createOffer();
    dbg(`peer: createOffer done sdp_len=${offer.sdp?.length ?? 0}`);
    await this.pc.setLocalDescription(offer);
    dbg(`peer: setLocalDescription(offer) done; sending offer via signaling`);

    this.offerPayload = {
      type: "offer",
      sdp: offer.sdp,
      sdp_type: offer.type,
    };
    this.signaling.send(this.offerPayload);

    // Offer retry: if worker is still spinning up, the offer may need to be
    // resent once the worker registers.
    this.offerRetryTimer = setInterval(() => {
      if (this.closed || !this.offerPayload) {
        this.stopOfferRetry();
        return;
      }
      if (this.pc.signalingState === "have-local-offer" && this.signaling.isOpen()) {
        try {
          this.signaling.send(this.offerPayload);
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
      await this.pc.close();
    } catch {
      // ignored
    }
  }
}

import WebSocket from "ws";

export type SignalingRole = "browser" | "worker" | "observer";

export interface SignalingMessage {
  type: string;
  [key: string]: unknown;
}

export interface SignalingClientOptions {
  url: string;
  sessionId: string;
  role?: SignalingRole;
  connectTimeoutMs?: number;
  /**
   * Optional client version string (e.g., "synthi-mcp/0.1.0"). Purely
   * informational — server logs it for operator observability but
   * doesn't route on it.
   */
  clientVersion?: string;
  /**
   * Protocol versions this MCP can speak. Server picks the highest
   * mutually-supported version and echoes it on the `registered` reply.
   * Omit to accept whatever the server defaults to (v1 today).
   */
  supportedProtocols?: number[];
}

export type SignalingMessageHandler = (msg: SignalingMessage) => void;
export type SignalingCloseHandler = (info: { code: number; reason: string }) => void;

/**
 * Thin WebSocket wrapper over the Synthi signaling-server protocol.
 *
 * Protocol (matches `backend/synthi-webrtc-compiler/signaling-server/src/main.rs:265-302`):
 *   → register: {type:"register", role, session_id}
 *   → offer:    {type:"offer", sdp, sdp_type:"offer"}
 *   ← answer:   {type:"answer", sdp, sdp_type:"answer"}
 *   ↔ candidate:{type:"candidate", candidate}
 */
export class SignalingClient {
  private ws: WebSocket | null = null;
  private closed = false;
  private messageHandlers: SignalingMessageHandler[] = [];
  private closeHandler: SignalingCloseHandler | null = null;
  /**
   * Per-connection peer identifier minted by the signaling-server on
   * register and echoed back in the `registered` ack. Forward-compat
   * with G3 Phase B (per-peer PC routing in the worker); not used for
   * routing today.
   */
  private assignedPeerId: string | null = null;

  constructor(private readonly opts: SignalingClientOptions) {}

  /** Returns the server-assigned peer_id, or `null` if the `registered`
   *  ack hasn't arrived yet. */
  peerId(): string | null {
    return this.assignedPeerId;
  }

  /**
   * Register a message handler. Multiple handlers can coexist — each is
   * called in registration order for every incoming message. Returns an
   * unsubscribe fn so callers can scope listeners to a lifetime.
   */
  onMessage(handler: SignalingMessageHandler): () => void {
    this.messageHandlers.push(handler);
    return (): void => {
      this.messageHandlers = this.messageHandlers.filter((h) => h !== handler);
    };
  }

  onClose(handler: SignalingCloseHandler): void {
    this.closeHandler = handler;
  }

  async connect(): Promise<void> {
    if (this.closed) throw new Error("signaling_closed");
    if (this.ws) throw new Error("signaling_already_connected");

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(this.opts.url);
      this.ws = ws;

      const timeoutMs = this.opts.connectTimeoutMs ?? 10_000;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {
          // ignored
        }
        reject(new Error(`signaling_connect_timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      ws.on("open", () => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        const registerMsg: SignalingMessage = {
          type: "register",
          role: this.opts.role ?? "browser",
          session_id: this.opts.sessionId,
        };
        if (this.opts.clientVersion) {
          registerMsg["client_version"] = this.opts.clientVersion;
        }
        if (this.opts.supportedProtocols && this.opts.supportedProtocols.length > 0) {
          registerMsg["supported_protocols"] = this.opts.supportedProtocols;
        }
        try {
          ws.send(JSON.stringify(registerMsg));
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        resolve();
      });

      ws.on("error", (err) => {
        clearTimeout(timer);
        if (settled) {
          return;
        }
        settled = true;
        reject(err);
      });

      ws.on("message", (data) => {
        const text = typeof data === "string" ? data : data.toString("utf8");
        let parsed: SignalingMessage;
        try {
          parsed = JSON.parse(text) as SignalingMessage;
        } catch {
          return;
        }
        if (!parsed || typeof parsed.type !== "string") return;
        // Capture the server-assigned peer_id on the `registered` ack.
        // Done BEFORE user handlers so anyone reading `peerId()` in
        // response to that message sees the fresh value.
        if (parsed.type === "registered" && typeof parsed["peer_id"] === "string") {
          this.assignedPeerId = parsed["peer_id"] as string;
        }
        if (this.messageHandlers.length === 0) return;
        for (const h of this.messageHandlers) {
          try {
            h(parsed);
          } catch {
            // handlers must not break the receive loop
          }
        }
      });

      ws.on("close", (code, reason) => {
        if (this.closeHandler) {
          this.closeHandler({ code, reason: reason.toString("utf8") });
        }
      });
    });
  }

  send(message: SignalingMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("signaling_not_open");
    }
    // Stamp our assigned peer_id on outgoing routable messages
    // (offer/answer/candidate). The signaling-server rewrites it to the
    // sender's peer_id anyway, but including it makes client-side logs /
    // tests unambiguous when inspecting the wire. We don't clobber a
    // peer_id the caller set explicitly — that's used by the worker-side
    // test harness to target a specific peer.
    const routable =
      message.type === "offer" ||
      message.type === "answer" ||
      message.type === "candidate";
    const payload =
      routable && this.assignedPeerId !== null && message["peer_id"] === undefined
        ? { ...message, peer_id: this.assignedPeerId }
        : message;
    this.ws.send(JSON.stringify(payload));
  }

  isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignored
      }
      this.ws = null;
    }
  }
}

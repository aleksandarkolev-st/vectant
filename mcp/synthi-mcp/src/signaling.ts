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
  private messageHandler: SignalingMessageHandler | null = null;
  private closeHandler: SignalingCloseHandler | null = null;

  constructor(private readonly opts: SignalingClientOptions) {}

  onMessage(handler: SignalingMessageHandler): void {
    this.messageHandler = handler;
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
        if (!this.messageHandler) return;
        const text = typeof data === "string" ? data : data.toString("utf8");
        let parsed: SignalingMessage;
        try {
          parsed = JSON.parse(text) as SignalingMessage;
        } catch {
          return;
        }
        if (parsed && typeof parsed.type === "string") {
          this.messageHandler(parsed);
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
    this.ws.send(JSON.stringify(message));
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

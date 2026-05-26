import type { RTCDataChannel } from "werift";
import { HmrNormalizer } from "./hmr.js";
import { sendFrames, type SendOptions } from "./wire/input.js";
import { randomUUID } from "node:crypto";

const DEFAULT_COMPILE_CHUNK_BYTES = 48_000;

function compileChunkMaxBytes(): number {
  const raw = process.env.SYNTHI_MCP_COMPILE_CHUNK_BYTES;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_COMPILE_CHUNK_BYTES;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`invalid_compile_chunk_bytes:${raw}`);
  }
  return Math.floor(parsed);
}

function serializedChunkBytes(
  chunkId: string,
  seq: number,
  total: number,
  data: string,
): number {
  return Buffer.byteLength(
    JSON.stringify({
      type: "compile-request-chunk",
      chunk_id: chunkId,
      seq,
      total,
      encoding: "base64",
      data,
    }),
    "utf8",
  );
}

function chunkDataCharsForLimit(
  encodedLength: number,
  chunkId: string,
  maxBytes: number,
): {
  chunkChars: number;
  total: number;
} {
  let total = 1;
  for (let attempts = 0; attempts < 8; attempts += 1) {
    const overheadBytes = serializedChunkBytes(
      chunkId,
      Math.max(0, total - 1),
      total,
      "",
    );
    const chunkChars = maxBytes - overheadBytes;
    if (chunkChars < 1) {
      throw new Error(`compile_chunk_bytes_too_small:${maxBytes}`);
    }
    const nextTotal = Math.ceil(encodedLength / chunkChars);
    if (nextTotal === total) {
      return { chunkChars, total };
    }
    total = nextTotal;
  }
  throw new Error(`compile_chunk_bytes_unstable:${maxBytes}`);
}

/**
 * Thin wrapper around a session's data channels.
 *
 * - `build-log` (worker-created, arrives via `ondatachannel` on the MCP PC):
 *   wrapped by HmrNormalizer for terminal-event detection.
 * - `terminal` (MCP-created, outgoing): used for `gui-event` input frames.
 * - `compile` (MCP-created, outgoing): used by `synthi_compile` for
 *   CompileRequest payloads. Worker replies (status / events) flow back on
 *   `build-log`, which the HMR normalizer already consumes.
 *
 * Ordering note (matches `compilerClient.js:905-915`): the MCP creates
 * `terminal` and `compile` before the offer is sent; `build-log` arrives
 * later as part of the worker's SDP answer processing. All three are open
 * before `synthi_attach` resolves.
 */
export class SessionChannels {
  readonly hmr: HmrNormalizer;

  constructor(
    private readonly terminalDC: RTCDataChannel,
    buildLogDC: RTCDataChannel,
    private readonly compileDC: RTCDataChannel,
  ) {
    this.hmr = new HmrNormalizer(buildLogDC);
  }

  async sendInput(frames: string[], opts?: SendOptions): Promise<void> {
    return sendFrames(this.terminalDC, frames, opts);
  }

  async requestInputLease(payload: Record<string, unknown>, timeoutMs: number = 4_000): Promise<Record<string, unknown>> {
    if (this.terminalDC.readyState !== "open") {
      throw new Error(`terminal_dc_not_open (state=${this.terminalDC.readyState})`);
    }
    const requestId = typeof payload["request_id"] === "string" && payload["request_id"].length > 0
      ? payload["request_id"]
      : `lease_req_${randomUUID()}`;
    const request = { ...payload, type: "input-lease", request_id: requestId };
    const waiter = new Promise<Record<string, unknown>>((resolve, reject) => {
      let unsub = (): void => {};
      const timer = setTimeout(() => {
        unsub();
        reject(new Error("input_lease_response_timeout"));
      }, timeoutMs);
      if (timer.unref) timer.unref();
      unsub = this.hmr.onMessage((msg) => {
        if (msg["type"] !== "input-lease-result") return;
        if (msg["request_id"] !== requestId) return;
        clearTimeout(timer);
        unsub();
        resolve(msg);
      });
    });
    this.terminalDC.send(JSON.stringify(request));
    return waiter;
  }

  /**
   * Send a single CompileRequest (or cancel-build / cancel-mobile-job)
   * payload on the `compile` data channel. Fires-and-forgets — observability
   * is via `build-log` events (wrapped by `HmrNormalizer`). Throws a
   * short-circuit if the channel isn't ready so the tool handler can
   * surface `compile_channel_not_open` instead of timing out.
   */
  async sendCompileRequest(payload: Record<string, unknown>): Promise<void> {
    if (this.compileDC.readyState !== "open") {
      throw new Error(`compile_channel_not_open:${this.compileDC.readyState}`);
    }
    const body = JSON.stringify(payload);
    const maxBytes = compileChunkMaxBytes();
    if (Buffer.byteLength(body, "utf8") <= maxBytes) {
      this.compileDC.send(body);
      return;
    }

    const encoded = Buffer.from(body, "utf8").toString("base64");
    const chunkId = `compile-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const { chunkChars, total } = chunkDataCharsForLimit(
      encoded.length,
      chunkId,
      maxBytes,
    );
    for (let seq = 0; seq < total; seq += 1) {
      const data = encoded.slice(seq * chunkChars, (seq + 1) * chunkChars);
      const frame = JSON.stringify({
        type: "compile-request-chunk",
        chunk_id: chunkId,
        seq,
        total,
        encoding: "base64",
        data,
      });
      this.compileDC.send(frame);
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }

  compileChannelReadyState(): "connecting" | "open" | "closing" | "closed" {
    return this.compileDC.readyState as
      | "connecting"
      | "open"
      | "closing"
      | "closed";
  }

  dispose(): void {
    this.hmr.dispose();
  }
}

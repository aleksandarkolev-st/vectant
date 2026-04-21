import type { RTCDataChannel } from "werift";
import { HmrNormalizer } from "./hmr.js";
import { sendFrames, type SendOptions } from "./wire/input.js";

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
    private readonly compileDC: RTCDataChannel
  ) {
    this.hmr = new HmrNormalizer(buildLogDC);
  }

  async sendInput(frames: string[], opts?: SendOptions): Promise<void> {
    return sendFrames(this.terminalDC, frames, opts);
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
    this.compileDC.send(JSON.stringify(payload));
  }

  compileChannelReadyState(): "connecting" | "open" | "closing" | "closed" {
    return this.compileDC.readyState as "connecting" | "open" | "closing" | "closed";
  }

  dispose(): void {
    this.hmr.dispose();
  }
}

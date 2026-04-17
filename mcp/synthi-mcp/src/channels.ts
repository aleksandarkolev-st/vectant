import type wrtc from "@roamhq/wrtc";
import { HmrNormalizer } from "./hmr.js";
import { sendFrames, type SendOptions } from "./wire/input.js";

/**
 * Thin wrapper around a session's data channels.
 *
 * - `build-log` (worker-created, arrives via `ondatachannel` on the MCP PC):
 *   wrapped by HmrNormalizer for terminal-event detection.
 * - `terminal` (MCP-created, outgoing): used for `gui-event` input frames.
 *
 * Ordering note (matches `compilerClient.js:905-915`): the MCP creates
 * `terminal` before the offer is sent; `build-log` arrives later as part of
 * the worker's SDP answer processing. Both are open before `synthi_attach`
 * resolves.
 */
export class SessionChannels {
  readonly hmr: HmrNormalizer;

  constructor(
    private readonly terminalDC: wrtc.RTCDataChannel,
    buildLogDC: wrtc.RTCDataChannel
  ) {
    this.hmr = new HmrNormalizer(buildLogDC);
  }

  async sendInput(frames: string[], opts?: SendOptions): Promise<void> {
    return sendFrames(this.terminalDC, frames, opts);
  }

  dispose(): void {
    this.hmr.dispose();
  }
}

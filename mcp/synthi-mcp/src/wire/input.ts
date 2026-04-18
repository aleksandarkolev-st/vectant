import type wrtc from "@roamhq/wrtc";

/**
 * Input wire format for the Synthi preview's `terminal` data channel.
 *
 * Verified against:
 *   - `synthi/src/app/workspace/[slug]/page.jsx:510-522` (outer envelope)
 *   - `synthi/src/components/DraggableVideoWidget.jsx:119-148` (inner event)
 *   - `backend/synthi-webrtc-compiler/worker/src/main.rs:1690-1805` (parser)
 *
 * Envelope: `{type:"gui-event", sessionId, event:<inner>}`.
 * Button codes follow X11/SDL convention: 1=left, 2=middle, 3=right.
 */

export type MouseButtonName = "left" | "right" | "middle";

export interface GuiMouseMove {
  type: "mouse";
  action: "move";
  x: number;
  y: number;
}

export interface GuiMouseButton {
  type: "mouse";
  action: "down" | "up";
  x: number;
  y: number;
  button: number;
}

export interface GuiMouseWheel {
  type: "mouse";
  action: "wheel";
  deltaY: number;
}

export interface GuiKey {
  type: "key";
  action: "down" | "up";
  key: string;
}

export type GuiInnerEvent = GuiMouseMove | GuiMouseButton | GuiMouseWheel | GuiKey;

export interface GuiEventEnvelope {
  type: "gui-event";
  sessionId: string;
  /**
   * Optional correlator. When set, the worker echoes
   * `{type:"input-ack", dispatch_id, accepted, reason?}` on the
   * build-log DC. Callers who want ack-based backpressure supply a
   * unique id (uuid/random) and await via DispatchAckRegistry.
   */
  dispatch_id?: string;
  event: GuiInnerEvent;
}

export function buttonNameToCode(name: MouseButtonName | undefined): number {
  switch (name) {
    case "middle":
      return 2;
    case "right":
      return 3;
    case "left":
    case undefined:
    default:
      return 1;
  }
}

function envelope(sessionId: string, event: GuiInnerEvent, dispatchId?: string): string {
  const env: GuiEventEnvelope = { type: "gui-event", sessionId, event };
  if (dispatchId !== undefined) env.dispatch_id = dispatchId;
  return JSON.stringify(env);
}

export function encodeMouseMove(
  sessionId: string,
  x: number,
  y: number,
  dispatchId?: string
): string {
  return envelope(sessionId, { type: "mouse", action: "move", x, y }, dispatchId);
}

export function encodeMouseButton(
  sessionId: string,
  x: number,
  y: number,
  button: number,
  action: "down" | "up",
  dispatchId?: string
): string {
  return envelope(sessionId, { type: "mouse", action, x, y, button }, dispatchId);
}

export function encodeWheel(sessionId: string, deltaY: number, dispatchId?: string): string {
  return envelope(sessionId, { type: "mouse", action: "wheel", deltaY }, dispatchId);
}

export function encodeKey(
  sessionId: string,
  key: string,
  action: "down" | "up",
  dispatchId?: string
): string {
  return envelope(sessionId, { type: "key", action, key }, dispatchId);
}

/**
 * A synthi_click expands to a mouse-down + mouse-up pair at the same point.
 * Returns a two-element array of JSON frames.
 *
 * `dispatchIds` — optional `[downId, upId]` pair correlates each half of
 * the click with an ack. Provide either both or neither.
 */
export function encodeClickPair(
  sessionId: string,
  x: number,
  y: number,
  button: MouseButtonName = "left",
  dispatchIds?: [string, string]
): [string, string] {
  const code = buttonNameToCode(button);
  return [
    encodeMouseButton(sessionId, x, y, code, "down", dispatchIds?.[0]),
    encodeMouseButton(sessionId, x, y, code, "up", dispatchIds?.[1]),
  ];
}

/**
 * synthi_type expands text into a down+up sequence per character. Each
 * character is sent as `ev.key` (matches the browser's DOM convention at
 * `DraggableVideoWidget.jsx:143-147`). The worker translates via
 * `js_key_to_sdl_keycode(key)` in `main.rs:1781`.
 *
 * When `dispatchIdSupplier` is provided, each emitted frame carries a
 * fresh dispatch_id produced by the supplier (typically
 * `() => randomUUID()`). Callers tracking per-key acks can correlate
 * them via the returned parallel array in `dispatchIdSupplierIds`.
 */
export function encodeTypeSequence(
  sessionId: string,
  text: string,
  dispatchIdSupplier?: () => string
): string[] {
  const out: string[] = [];
  for (const ch of text) {
    const downId = dispatchIdSupplier?.();
    const upId = dispatchIdSupplier?.();
    out.push(encodeKey(sessionId, ch, "down", downId));
    out.push(encodeKey(sessionId, ch, "up", upId));
  }
  return out;
}

export interface SendOptions {
  /**
   * Minimum delay between consecutive frames in ms. MVP caps at 500 keys/sec,
   * so a default 2ms gap keeps us well inside the budget.
   */
  interFrameDelayMs?: number;
}

/**
 * Send a batch of JSON frames over the `terminal` data channel, respecting
 * the MVP rate cap (default 2ms between frames).
 */
export async function sendFrames(
  dc: wrtc.RTCDataChannel,
  frames: string[],
  opts: SendOptions = {}
): Promise<void> {
  if (dc.readyState !== "open") {
    throw new Error(`terminal_dc_not_open (state=${dc.readyState})`);
  }
  const gap = opts.interFrameDelayMs ?? 2;
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    if (frame !== undefined) {
      dc.send(frame);
    }
    if (i < frames.length - 1 && gap > 0) {
      await new Promise((resolve) => setTimeout(resolve, gap));
    }
  }
}

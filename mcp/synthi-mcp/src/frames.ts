import wrtc from "@roamhq/wrtc";
import sharp from "sharp";

const { RTCVideoSink, i420ToRgba } = wrtc.nonstandard;

export interface FrameSnapshot {
  /** PNG bytes. */
  data: Buffer;
  /** Frame width in pixels. */
  width: number;
  /** Frame height in pixels. */
  height: number;
  /** Monotonic timestamp (ms) at which the latest frame was received. */
  ts: number;
  /** Monotonic counter of frames received since attach. */
  seq: number;
}

interface LatestI420 {
  width: number;
  height: number;
  data: Uint8Array;
  seq: number;
  ts: number;
}

/**
 * Subscribes to a video MediaStreamTrack, stores the most recent I420 frame,
 * and converts to PNG on demand.
 *
 * Worker-side encoder defaults are VP8 1080×1920 @ 30fps (see
 * `backend/synthi-webrtc-compiler/worker/src/android/webrtc/video_pipeline.rs:80-83`).
 * `@roamhq/wrtc`'s `RTCVideoSink` delivers decoded frames in I420 planar format;
 * we copy the frame buffer (the native buffer is reused across events), convert
 * to RGBA via the binding's `i420ToRgba`, then PNG-encode via sharp.
 */
export class FrameSink {
  private readonly sink: wrtc.nonstandard.RTCVideoSink;
  private latest: LatestI420 | null = null;
  private seq = 0;
  private firstFrameAt: number | null = null;
  private stopped = false;

  constructor(track: wrtc.MediaStreamTrack) {
    this.sink = new RTCVideoSink(track);
    this.sink.onframe = (event: unknown) => {
      if (this.stopped) return;
      const frame = (event as { frame: { width: number; height: number; data: Uint8Array } }).frame;
      const copy = new Uint8Array(frame.data.byteLength);
      copy.set(frame.data);
      this.seq += 1;
      const now = Date.now();
      if (this.firstFrameAt === null) this.firstFrameAt = now;
      this.latest = {
        width: frame.width,
        height: frame.height,
        data: copy,
        seq: this.seq,
        ts: now,
      };
    };
  }

  /** Resolves when at least one frame has been received, or rejects on timeout. */
  async waitForFirstFrame(timeoutMs = 10_000): Promise<void> {
    if (this.latest !== null) return;
    const start = Date.now();
    while (this.latest === null) {
      if (this.stopped) throw new Error("frame_sink_stopped");
      if (Date.now() - start > timeoutMs) {
        throw new Error(`no_frame_yet after ${timeoutMs}ms`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  hasFrame(): boolean {
    return this.latest !== null;
  }

  dimensions(): { width: number; height: number } | null {
    if (!this.latest) return null;
    return { width: this.latest.width, height: this.latest.height };
  }

  /** Encode the most recent frame as PNG. Throws if no frame has arrived yet. */
  async getFrame(): Promise<FrameSnapshot> {
    const latest = this.latest;
    if (!latest) throw new Error("no_frame_yet");

    const rgbaData = new Uint8ClampedArray(latest.width * latest.height * 4);
    const i420Frame = { width: latest.width, height: latest.height, data: latest.data };
    const rgbaFrame = { width: latest.width, height: latest.height, data: rgbaData as unknown as Uint8Array };
    i420ToRgba(i420Frame, rgbaFrame);

    const png = await sharp(Buffer.from(rgbaData.buffer), {
      raw: { width: latest.width, height: latest.height, channels: 4 },
    })
      .png({ compressionLevel: 6, adaptiveFiltering: false })
      .toBuffer();

    return {
      data: png,
      width: latest.width,
      height: latest.height,
      ts: latest.ts,
      seq: latest.seq,
    };
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    try {
      this.sink.stop();
    } catch {
      // ignored
    }
  }
}

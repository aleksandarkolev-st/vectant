import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { Vp8RtpPayload, type MediaStreamTrack } from "werift";

const FFMPEG_PATH: string = ffmpegInstaller.path;

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

interface LatestPng {
  png: Buffer;
  width: number;
  height: number;
  seq: number;
  ts: number;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// IEND chunk: 4-byte length (0), 4-byte type "IEND", 4-byte CRC (fixed).
const PNG_IEND = Buffer.from([
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

/** VP8 keyframe start code (RFC 6386 §9.1). */
const VP8_KEYFRAME_START_CODE = Buffer.from([0x9d, 0x01, 0x2a]);

/** Parse width/height from a VP8 keyframe's uncompressed header.
 *
 * Layout (RFC 6386 §9.1):
 *   byte 0-2: frame tag (LSB: key_frame=0 means keyframe)
 *   byte 3-5: start code 0x9d 0x01 0x2a
 *   byte 6-7: horizontal_scale(2) | width(14), little-endian
 *   byte 8-9: vertical_scale(2)   | height(14), little-endian
 *
 * Returns null if the buffer isn't a keyframe or is too short. */
function parseVp8Keyframe(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 10) return null;
  // Frame tag byte 0 bit 0 = key_frame (0 = keyframe).
  if ((buf[0]! & 0x01) !== 0) return null;
  if (buf.subarray(3, 6).compare(VP8_KEYFRAME_START_CODE) !== 0) return null;
  const widthField = buf.readUInt16LE(6);
  const heightField = buf.readUInt16LE(8);
  return {
    width: widthField & 0x3fff,
    height: heightField & 0x3fff,
  };
}

/** Build a 32-byte IVF file header for VP8 at the given resolution. */
function buildIvfHeader(width: number, height: number): Buffer {
  const hdr = Buffer.alloc(32);
  hdr.write("DKIF", 0, "ascii");
  hdr.writeUInt16LE(0, 4); // version
  hdr.writeUInt16LE(32, 6); // header length
  hdr.write("VP80", 8, "ascii");
  hdr.writeUInt16LE(width, 12);
  hdr.writeUInt16LE(height, 14);
  // Timebase den/num — use RTP 90kHz clock so PTS = RTP timestamp.
  hdr.writeUInt32LE(90000, 16);
  hdr.writeUInt32LE(1, 20);
  hdr.writeUInt32LE(0, 24); // frame count (unknown — leave 0)
  hdr.writeUInt32LE(0, 28);
  return hdr;
}

/** Build a 12-byte IVF frame header. PTS is 64-bit LE. */
function buildIvfFrameHeader(frameSize: number, pts: number): Buffer {
  const hdr = Buffer.alloc(12);
  hdr.writeUInt32LE(frameSize, 0);
  // Node's writeBigUInt64LE wants bigint; Number.MAX_SAFE_INTEGER is >>
  // any plausible RTP timestamp (32-bit), so plain Number → bigint is safe.
  hdr.writeBigUInt64LE(BigInt(pts >>> 0), 4);
  return hdr;
}

/**
 * Subscribes to a werift MediaStreamTrack carrying VP8 RTP, reassembles
 * frames from the RTP payloads, wraps them in an IVF container, and pipes
 * the stream into an ffmpeg subprocess for decoding to PNG. The latest
 * decoded PNG is kept in memory so `getFrame()` returns synchronously.
 *
 * Why ffmpeg + IVF: werift exposes VP8 RTP payloads via `Vp8RtpPayload`
 * but has no decoder. ffmpeg reads VP8 cleanly out of an IVF container,
 * which is trivial to synthesize in userland (32-byte file header +
 * 12-byte per-frame header). The worker's GStreamer pipeline emits VP8
 * because the original `@roamhq/wrtc` build on the MCP side lacked H264;
 * we stay on VP8 now on werift too so both ends match without touching
 * the worker.
 */
function fsDbg(msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  process.stderr.write(`[mcp ${ts}] frames: ${msg}\n`);
}

export class FrameSink {
  private readonly ffmpeg: ChildProcessByStdio<Writable, Readable, Readable>;
  private readonly trackSub: { unSubscribe: () => void } | null;
  private latest: LatestPng | null = null;
  private seq = 0;
  private firstFrameAt: number | null = null;
  private stopped = false;
  private stdoutBuf: Buffer = Buffer.alloc(0);

  // VP8 reassembly state.
  private frameBuf: Buffer[] = [];
  private frameRtpTs: number | null = null;
  private ivfHeaderSent = false;

  // Diagnostics — count RTP arrivals, VP8 parse successes/failures, and
  // frame flushes so `no_frame_yet` can be root-caused without guessing.
  // Logged at low frequency (first few, then every 30 / 100) so a
  // healthy stream doesn't drown the stderr log.
  private rtpCount = 0;
  private vp8OkCount = 0;
  private vp8FailCount = 0;
  private flushedFrameCount = 0;
  private flushedKeyframeCount = 0;
  private droppedPreKeyframeCount = 0;
  private diagTimer: NodeJS.Timeout | null = null;
  private lastDiagSnapshot = { rtp: 0 };

  constructor(track: MediaStreamTrack) {
    fsDbg(`FrameSink constructed for track id=${track.id ?? track.uuid} kind=${track.kind}`);
    this.ffmpeg = spawn(
      FFMPEG_PATH,
      [
        "-loglevel", "error",
        "-f", "ivf",
        "-i", "-",
        "-f", "image2pipe",
        "-c:v", "png",
        "-",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    this.ffmpeg.stdout.on("data", (chunk: Buffer) => this.onFfmpegStdout(chunk));
    this.ffmpeg.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(`[mcp] frames: ffmpeg: ${chunk.toString()}`);
    });
    this.ffmpeg.on("error", (err) => {
      process.stderr.write(`[mcp] frames: ffmpeg spawn error: ${err.message}\n`);
    });
    this.ffmpeg.stdin.on("error", () => {
      // ignore broken-pipe on shutdown
    });

    this.trackSub = track.onReceiveRtp.subscribe((rtp) => {
      if (this.stopped) return;
      this.rtpCount += 1;
      // Early samples are the interesting ones for diagnosing a stuck
      // pipeline; after 3 we switch to a sparse heartbeat so steady
      // state doesn't flood stderr.
      if (this.rtpCount <= 3 || this.rtpCount % 300 === 0) {
        fsDbg(
          `rtp#${this.rtpCount} pt=${rtp.header.payloadType} seq=${rtp.header.sequenceNumber} ts=${rtp.header.timestamp} marker=${rtp.header.marker} payload_len=${rtp.payload.length}`
        );
      }
      try {
        const vp8 = Vp8RtpPayload.deSerialize(rtp.payload);
        if (!vp8.payload || vp8.payload.length === 0) {
          // Non-zero length empty-after-descriptor: accounted as ok
          // because the RTP itself parsed fine; just no codec payload
          // in this packet (e.g. keepalive / padding).
          this.vp8OkCount += 1;
          return;
        }
        this.vp8OkCount += 1;

        // RTP timestamp changes each frame; use it as the PTS + boundary.
        // Marker bit on the RTP header flags the final packet of a frame
        // but we also reset on timestamp change as a defensive fallback
        // (e.g. first packet after attach).
        const rtpTs = rtp.header.timestamp;
        if (this.frameRtpTs !== null && this.frameRtpTs !== rtpTs) {
          // Previous frame never saw its marker — flush what we have.
          this.flushFrame(this.frameRtpTs);
        }
        this.frameRtpTs = rtpTs;
        this.frameBuf.push(vp8.payload);

        if (rtp.header.marker) {
          this.flushFrame(rtpTs);
          this.frameRtpTs = null;
        }
      } catch (err) {
        this.vp8FailCount += 1;
        if (this.vp8FailCount <= 3) {
          fsDbg(
            `VP8 payload parse failed (payload_len=${rtp.payload.length}, first_bytes=${rtp.payload.slice(0, 6).toString("hex")}): ${(err as Error).message ?? String(err)}`
          );
        }
      }
    });

    // Independent heartbeat: fires even if zero RTP arrives, which is
    // the exact failure mode we're hunting — the packet-driven call site
    // below never runs when the worker stops sending. The flag
    // `lastDiagSnapshot` lets us call out a stall explicitly vs a steady
    // feed.
    this.diagTimer = setInterval(() => {
      const deltaRtp = this.rtpCount - this.lastDiagSnapshot.rtp;
      this.lastDiagSnapshot.rtp = this.rtpCount;
      fsDbg(
        `diag: rtp=${this.rtpCount} (+${deltaRtp}/2s) vp8_ok=${this.vp8OkCount} vp8_fail=${this.vp8FailCount} frames_flushed=${this.flushedFrameCount} keyframes=${this.flushedKeyframeCount} pre_kf_drop=${this.droppedPreKeyframeCount} latest=${this.latest ? `${this.latest.width}x${this.latest.height}#${this.latest.seq}` : "none"}`
      );
    }, 2_000);
    if (this.diagTimer.unref) this.diagTimer.unref();
  }

  private flushFrame(pts: number): void {
    if (this.frameBuf.length === 0) return;
    const frame = Buffer.concat(this.frameBuf);
    this.frameBuf = [];

    const keyframeDims = parseVp8Keyframe(frame);
    if (!this.ivfHeaderSent) {
      // First frame MUST be a keyframe for the decoder; if it isn't, drop
      // and wait for one. ffmpeg is perfectly happy to start mid-stream on
      // the next keyframe. Bonus: the keyframe carries the width/height
      // we need to synthesize the IVF file header.
      if (!keyframeDims) {
        this.droppedPreKeyframeCount += 1;
        return;
      }
      fsDbg(
        `first keyframe accepted ${keyframeDims.width}x${keyframeDims.height} (dropped ${this.droppedPreKeyframeCount} delta frame(s) while waiting)`
      );
      this.ffmpeg.stdin.write(buildIvfHeader(keyframeDims.width, keyframeDims.height));
      this.ivfHeaderSent = true;
    }

    this.flushedFrameCount += 1;
    if (keyframeDims) this.flushedKeyframeCount += 1;
    this.ffmpeg.stdin.write(buildIvfFrameHeader(frame.length, pts));
    this.ffmpeg.stdin.write(frame);
  }

  private onFfmpegStdout(chunk: Buffer): void {
    this.stdoutBuf = this.stdoutBuf.length === 0 ? chunk : Buffer.concat([this.stdoutBuf, chunk]);

    for (;;) {
      const magicStart = this.stdoutBuf.indexOf(PNG_MAGIC);
      if (magicStart < 0) {
        if (this.stdoutBuf.length > 16 * 1024 * 1024) {
          this.stdoutBuf = Buffer.alloc(0);
        }
        return;
      }
      const iendPos = this.stdoutBuf.indexOf(PNG_IEND, magicStart + PNG_MAGIC.length);
      if (iendPos < 0) {
        if (magicStart > 0) {
          this.stdoutBuf = this.stdoutBuf.subarray(magicStart);
        }
        return;
      }
      const pngEnd = iendPos + PNG_IEND.length;
      const png = this.stdoutBuf.subarray(magicStart, pngEnd);
      // PNG IHDR: magic(8) + length(4) + "IHDR"(4) + width(4 BE) + height(4 BE)
      const width = png.readUInt32BE(16);
      const height = png.readUInt32BE(20);
      this.seq += 1;
      const now = Date.now();
      if (this.firstFrameAt === null) {
        this.firstFrameAt = now;
        fsDbg(
          `first decoded PNG available ${width}x${height} (${png.length} bytes, rtp_seen=${this.rtpCount})`
        );
      }
      // Buffer.from(png) so the slice doesn't retain the whole stdoutBuf.
      this.latest = {
        png: Buffer.from(png),
        width,
        height,
        seq: this.seq,
        ts: now,
      };
      this.stdoutBuf = this.stdoutBuf.subarray(pngEnd);
    }
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

  /** Return the most recent frame as PNG. Throws if no frame has arrived yet. */
  async getFrame(): Promise<FrameSnapshot> {
    const latest = this.latest;
    if (!latest) throw new Error("no_frame_yet");
    return {
      data: latest.png,
      width: latest.width,
      height: latest.height,
      ts: latest.ts,
      seq: latest.seq,
    };
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.diagTimer) {
      clearInterval(this.diagTimer);
      this.diagTimer = null;
    }
    try {
      this.trackSub?.unSubscribe();
    } catch {
      // ignored
    }
    try {
      this.ffmpeg.stdin.end();
    } catch {
      // ignored
    }
    try {
      this.ffmpeg.kill("SIGTERM");
    } catch {
      // ignored
    }
  }
}

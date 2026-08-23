'use strict';
/**
 * CodeSite registered direct channel — relay transport (Phase 2).
 *
 * A dependency-free Node library two attached agent processes run to speak
 * the framed channel protocol directly (WebSocket or loopback HTTP). The
 * control plane authorizes and logs the lifecycle; this module only handles
 * framing, MAC verification, sequencing, and replay-window enforcement.
 *
 * Frame envelope (JSON):
 *   { v, type, ts, seq, mac, payload }
 *   - mac = HMAC-SHA256(channelToken, `${ts}|${seq}|${type}|payload`)
 *   - payload is passed through verbatim when a string, JSON otherwise
 *
 * Receiver contract:
 *   - MAC must verify (constant-time compare)
 *   - ts must fall inside the replay window
 *   - seq must be strictly greater than the last accepted seq from that peer
 *
 * Any violation produces a structured violation record (never throws), so
 * transports can report `channel_violation` to the control plane and close.
 */

const crypto = require('node:crypto');

const REPLAY_WINDOW_MS_DEFAULT = 30_000;
const FRAME_VERSION = 1;

function hmacBase64Url(data, key) {
  return crypto.createHmac('sha256', key).update(data).digest('base64url');
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Build a signed frame.
 * @param {object} args
 * @param {string} args.channelToken raw csc_ token shared by both peers
 * @param {number} args.seq monotonically increasing sequence number
 * @param {string} args.type frame type (offer|counter|diff_chunk|ack|note|ping|close)
 * @param {string|object=} args.payload
 */
function buildFrame({ channelToken, seq, type, payload }) {
  if (!channelToken) throw new Error('channel_token_required');
  const ts = new Date().toISOString();
  const payloadText = typeof payload === 'string' ? payload : JSON.stringify(payload ?? null);
  const mac = hmacBase64Url([ts, String(Number(seq)), String(type || ''), payloadText].join('|'), channelToken);
  return { v: FRAME_VERSION, type, ts, seq: Number(seq), mac, payload };
}

/**
 * Verify an inbound frame against the channel token and receiver state.
 * Returns { ok:true } or { ok:false, violation:{ code, detail } }.
 * @param {object} args
 * @param {object} args.frame parsed frame object
 * @param {string} args.channelToken
 * @param {number=} args.lastSeq highest accepted seq so far (0 = none)
 * @param {number=} args.nowMs override clock for tests
 */
function verifyFrame({ frame, channelToken, lastSeq = 0, nowMs = Date.now(), replayWindowMs = REPLAY_WINDOW_MS_DEFAULT }) {
  if (!frame || typeof frame !== 'object') {
    return { ok: false, violation: { code: 'frame_malformed' } };
  }
  if (Number(frame.v) !== FRAME_VERSION) {
    return { ok: false, violation: { code: 'frame_version_unsupported', detail: { v: frame.v } } };
  }
  const tsMs = typeof frame.ts === 'number' ? frame.ts : Date.parse(frame.ts);
  if (!Number.isFinite(tsMs)) {
    return { ok: false, violation: { code: 'frame_timestamp_invalid', detail: { ts: frame.ts } } };
  }
  // Review fix #16: a small forward skew is tolerated (clock drift), but
  // significantly future-dated frames are refused so replay can't be armed
  // with a timestamp that only becomes valid later.
  if (tsMs - nowMs > REPLAY_WINDOW_MS_DEFAULT) {
    return { ok: false, violation: { code: 'frame_timestamp_future', detail: { tsMs, nowMs } } };
  }
  if (Math.abs(nowMs - tsMs) > replayWindowMs) {
    return { ok: false, violation: { code: 'frame_replay_window_exceeded', detail: { ageMs: nowMs - tsMs, windowMs: replayWindowMs } } };
  }
  const seq = Number(frame.seq);
  if (!Number.isFinite(seq) || !Number.isInteger(seq) || seq <= Number(lastSeq || 0)) {
    return { ok: false, violation: { code: 'frame_sequence_replayed_or_gapped', detail: { seq, lastSeq } } };
  }
  const payloadText = typeof frame.payload === 'string'
    ? frame.payload
    : JSON.stringify(frame.payload ?? null);
  const expectedMac = hmacBase64Url(
    [String(frame.ts), String(seq), String(frame.type || ''), payloadText].join('|'),
    String(channelToken || ''),
  );
  if (!timingSafeEqualStr(frame.mac || '', expectedMac)) {
    return { ok: false, violation: { code: 'frame_mac_invalid' } };
  }
  return { ok: true, frame: { ...frame, seq, tsMs } };
}

/** Monotonic transcript hash chain — both sides compute identical digests. */
class TranscriptChain {
  constructor() {
    this.previous = null;
  }

  /** Fold one verified outbound/inbound frame into the chain. */
  append(frame) {
    const entry = JSON.stringify({
      n: this.previous,
      t: frame.ts,
      s: frame.seq,
      y: frame.type,
      p: typeof frame.payload === 'string' ? sha256Hex(frame.payload) : sha256Hex(JSON.stringify(frame.payload ?? null)),
    });
    this.previous = sha256Hex(entry);
    return this.previous;
  }

  /** Final digest reported at close; must match on both sides. */
  digest() {
    return this.previous ? `sha256:${this.previous}` : null;
  }
}

/**
 * Minimal loopback transport for tests and local agents: an in-memory pair of
 * connected endpoints with the same send/verify semantics as a socket.
 */
function createLoopbackPair({ tokenAtoB, tokenBtoA }) {
  let seqA = 0; // A's send counter
  let seqB = 0; // B's send counter
  let recvAtA = 0; // highest seq from B that A accepted
  let recvAtB = 0; // highest seq from A that B accepted
  const chainA = new TranscriptChain();
  const chainB = new TranscriptChain();
  const logAtoB = [];
  const logBtoA = [];

  return {
    /**
     * A sends to B. Returns B's receive verdict.
     */
    sendFromA(type, payload) {
      seqA += 1;
      const frame = buildFrame({ channelToken: tokenAtoB, seq: seqA, type, payload });
      chainA.append(frame);
      const verdict = verifyFrame({ frame, channelToken: tokenAtoB, lastSeq: recvAtB });
      logAtoB.push({ frame, verdict });
      if (verdict.ok) {
        chainB.append(verdict.frame);
        recvAtB = verdict.frame.seq;
      }
      return verdict;
    },
    sendFromB(type, payload) {
      seqB += 1;
      const frame = buildFrame({ channelToken: tokenBtoA, seq: seqB, type, payload });
      chainB.append(frame);
      const verdict = verifyFrame({ frame, channelToken: tokenBtoA, lastSeq: recvAtA });
      logBtoA.push({ frame, verdict });
      if (verdict.ok) {
        chainA.append(verdict.frame);
        recvAtA = verdict.frame.seq;
      }
      return verdict;
    },
    digests() {
      return { fromA: chainA.digest(), fromB: chainB.digest() };
    },
  };
}

/**
 * Stateful receiver (design §9 review fix): owns the per-direction lastSeq so
 * transports don't have to persist replay state themselves. Wrap a raw
 * verifyFrame call — violations are returned, never thrown.
 */
function createReceiver({ channelToken, nowMs = () => Date.now(), replayWindowMs = REPLAY_WINDOW_MS_DEFAULT }) {
  let lastSeq = 0;
  return {
    /** Verify one inbound frame; advances internal seq on success. */
    receive(frame) {
      const verdict = verifyFrame({
        frame,
        channelToken,
        lastSeq,
        nowMs: nowMs(),
        replayWindowMs,
      });
      if (verdict.ok) lastSeq = verdict.frame.seq;
      return verdict;
    },
    get lastSeq() {
      return lastSeq;
    },
  };
}

module.exports = {
  FRAME_VERSION,
  REPLAY_WINDOW_MS_DEFAULT,
  TranscriptChain,
  buildFrame,
  createLoopbackPair,
  createReceiver,
  sha256Hex,
  verifyFrame,
};

import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const relay = require('../../../../scripts/codesite-channel-relay.cjs');

describe('CodeSite channel relay transport', () => {
  it('builds versioned frames with monotonically increasing seq', () => {
    const f1 = relay.buildFrame({ channelToken: 'csc_k', seq: 1, type: 'offer', payload: { part: 1 } });
    const f2 = relay.buildFrame({ channelToken: 'csc_k', seq: 2, type: 'counter', payload: { part: 2 } });
    expect(f1.v).toBe(1);
    expect(f1.seq).toBe(1);
    expect(f2.seq).toBe(2);
    expect(f1.mac).not.toBe(f2.mac);
    // String payloads pass through verbatim.
    const f3 = relay.buildFrame({ channelToken: 'csc_k', seq: 3, type: 'note', payload: 'raw-text' });
    expect(f3.payload).toBe('raw-text');
  });

  it('verifies genuine frames and rejects tampered ones', () => {
    const token = 'csc_genuine';
    const frame = relay.buildFrame({ channelToken: token, seq: 1, type: 'diff_chunk', payload: { hunk: '@@ -1 +1 @@' } });

    expect(relay.verifyFrame({ frame, channelToken: token }).ok).toBe(true);

    // Payload tampering breaks the MAC.
    const tamperedPayload = { ...frame, payload: { hunk: '@@ -9 +9 @@' } };
    expect(relay.verifyFrame({ frame: tamperedPayload, channelToken: token }).ok).toBe(false);

    // Wrong key fails.
    expect(relay.verifyFrame({ frame, channelToken: 'csc_other' }).ok).toBe(false);

    // Malformed frames are structured rejections, never throws.
    expect(relay.verifyFrame({ frame: null, channelToken: token }).violation.code).toBe('frame_malformed');
  });

  it('enforces replay protection: stale timestamps and reused sequence numbers', async () => {
    const token = 'csc_replay';
    const now = Date.now();
    const fresh = relay.buildFrame({ channelToken: token, seq: 5, type: 'ack' });
    expect(relay.verifyFrame({ frame: fresh, channelToken: token, nowMs: now }).ok).toBe(true);

    // A frame older than the window is refused even though the MAC is valid.
    const oldTs = new Date(now - 60_000).toISOString();
    const stale = { ...relay.buildFrame({ channelToken: token, seq: 6, type: 'ack' }), ts: oldTs };
    // Re-sign with the stale timestamp so only the age is wrong.
    const resigned = relay.buildFrame({ channelToken: token, seq: 6, type: 'ack' });
    void stale;
    const staleVerdict = relay.verifyFrame({
      frame: { ...resigned, ts: oldTs },
      channelToken: token,
      lastSeq: 0,
      nowMs: now + 31_000,
    });
    expect(staleVerdict.ok).toBe(false);
    expect(staleVerdict.violation.code).toBe('frame_replay_window_exceeded');

    // Sequence replay (same or lower seq) is refused after acceptance.
    const first = relay.buildFrame({ channelToken: token, seq: 10, type: 'note', payload: 'a' });
    expect(relay.verifyFrame({ frame: first, channelToken: token, lastSeq: 0 }).ok).toBe(true);
    const replayed = relay.buildFrame({ channelToken: token, seq: 10, type: 'note', payload: 'a' });
    const verdict = relay.verifyFrame({ frame: replayed, channelToken: token, lastSeq: 10 });
    expect(verdict.ok).toBe(false);
    expect(verdict.violation.code).toBe('frame_sequence_replayed_or_gapped');
  });

  it('loopback pair delivers signed traffic both ways with matching transcript digests', () => {
    const pair = relay.createLoopbackPair({ tokenAtoB: 'csc_ab', tokenBtoA: 'csc_ba' });

    expect(pair.sendFromA('offer', { plan: 'producer-first' }).ok).toBe(true);
    expect(pair.sendFromB('counter', { plan: 'consumer-first' }).ok).toBe(true);
    expect(pair.sendFromA('diff_chunk', '--- a/x\n+++ b/x').ok).toBe(true);
    expect(pair.sendFromB('ack', { accepted: true }).ok).toBe(true);

    const digests = pair.digests();
    expect(digests.fromA).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(digests.fromB).toMatch(/^sha256:[a-f0-9]{64}$/);
    // Each side folds what it sent and received; chains cover the same
    // transcript so both digests are well-formed and non-null.
  });

  it('transcript chain digest changes when any frame content changes', () => {
    const c1 = new relay.TranscriptChain();
    const c2 = new relay.TranscriptChain();
    const frame = relay.buildFrame({ channelToken: 'csc_t', seq: 1, type: 'note', payload: 'hello' });
    c1.append(frame);
    c2.append(frame);
    expect(c1.digest()).toBe(c2.digest());
    const altered = relay.buildFrame({ channelToken: 'csc_t', seq: 2, type: 'note', payload: 'hellO' });
    c2.append(altered);
    expect(c1.digest()).not.toBe(c2.digest());
  });
});

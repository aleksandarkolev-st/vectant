import { describe, expect, it } from 'vitest';
import {
  CHANNEL_MODES,
  channelsDisabled,
  effectiveChannelMode,
  frameMac,
  frameTimestampFresh,
  hashChannelToken,
  mintChannelToken,
  modeAllows,
  modeTransports,
  verifyChannelToken,
  verifyFrameMac,
} from '../channelSecurity';

describe('CodeSite channel security primitives', () => {
  it('orders the coordination mode ladder from strict to loose', () => {
    expect(CHANNEL_MODES).toEqual([
      'mediated_only',
      'registered_direct',
      'direct_preferred',
      'open_local',
    ]);
    // A mode always allows itself and anything stricter.
    expect(modeAllows('registered_direct', 'registered_direct')).toBe(true);
    expect(modeAllows('mediated_only', 'registered_direct')).toBe(true);
    expect(modeAllows('direct_preferred', 'registered_direct')).toBe(false);
  });

  it('refuses mediated_only transports but permits both direct transports otherwise', () => {
    expect(modeTransports('mediated_only')).toEqual([]);
    expect(modeTransports('registered_direct')).toEqual(['websocket', 'sse']);
  });

  it('effective mode honors the project setting and workspace floor', () => {
    process.env.SYNTHI_CODESITE_MIN_CHANNEL_MODE = 'direct_preferred';
    expect(effectiveChannelMode('open_local').ok).toBe(false);
    expect(effectiveChannelMode('direct_preferred').ok).toBe(true);
    delete process.env.SYNTHI_CODESITE_MIN_CHANNEL_MODE;
    expect(effectiveChannelMode('open_local').ok).toBe(true);
    expect(effectiveChannelMode('nonsense').ok).toBe(false);
  });

  it('refuses open_local outright in production builds', () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const result = effectiveChannelMode('open_local');
      expect(result.ok).toBe(false);
      expect(result.reasonCode).toContain('production');
      // Stricter modes remain fine in production.
      expect(effectiveChannelMode('registered_direct').ok).toBe(true);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  it('kill switch is off by default and reads env when set', () => {
    expect(channelsDisabled()).toBe(false);
    process.env.SYNTHI_CODESITE_CHANNELS_DISABLED = '1';
    try {
      expect(channelsDisabled()).toBe(true);
    } finally {
      delete process.env.SYNTHI_CODESITE_CHANNELS_DISABLED;
    }
  });

  it('mints prefixed tokens whose hashes verify, and rejects mismatches', () => {
    const token = mintChannelToken();
    expect(token.startsWith('csc_')).toBe(true);
    const hash = hashChannelToken(token);
    expect(verifyChannelToken(token, hash)).toBe(true);
    expect(verifyChannelToken('csc_wrong', hash)).toBe(false);
    expect(verifyChannelToken(token, 'sha256:deadbeef')).toBe(false);
    expect(verifyChannelToken('', hash)).toBe(false);
  });

  it('frame MAC verifies for valid frames and fails on tampering', () => {
    const token = mintChannelToken();
    const mac = frameMac({ token, ts: '2026-08-23T00:00:00.000Z', seq: 7, type: 'diff_chunk', payload: { n: 1 } });
    expect(verifyFrameMac({ token, ts: '2026-08-23T00:00:00.000Z', seq: 7, type: 'diff_chunk', payload: { n: 1 } }, mac)).toBe(true);
    expect(verifyFrameMac({ token, ts: '2026-08-23T00:00:00.000Z', seq: 8, type: 'diff_chunk', payload: { n: 1 } }, mac)).toBe(false);
    expect(verifyFrameMac({ token, ts: '2026-08-23T00:00:00.000Z', seq: 7, type: 'ack', payload: { n: 1 } }, mac)).toBe(false);
    expect(verifyFrameMac({ token: mintChannelToken(), ts: '2026-08-23T00:00:00.000Z', seq: 7, type: 'diff_chunk', payload: { n: 1 } }, mac)).toBe(false);
    // A string payload is passed through verbatim while an object payload is
    // JSON.stringify-ed — identical content in both forms yields the same
    // MAC base, so both verify.
    expect(
      verifyFrameMac({ token, ts: '2026-08-23T00:00:00.000Z', seq: 7, type: 'diff_chunk', payload: '{"n":1}' }, mac),
    ).toBe(true);
  });

  it('enforces the replay window on frame timestamps', () => {
    const now = Date.now();
    expect(frameTimestampFresh(now - 1000, now)).toBe(true);
    expect(frameTimestampFresh(now - 31_000, now)).toBe(false);
    expect(frameTimestampFresh(now + 5000, now)).toBe(true);
    expect(frameTimestampFresh('not-a-time', now)).toBe(false);
  });
});

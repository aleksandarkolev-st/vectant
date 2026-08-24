import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';

/**
 * Registered direct channels — security primitives.
 *
 * See docs/REGISTERED_DIRECT_CHANNELS_DESIGN.md and
 * docs/CHANNEL_MODES_TRADEOFFS.md.
 *
 * - Channel tokens (`csc_...`) are minted once at channel acceptance,
 *   delivered only inside the authenticated API response, and stored as a
 *   SHA-256 hash. They expire with the channel (maxDurationMs, hard cap).
 * - Every transport frame carries ts + seq + HMAC-SHA256 over
 *   `ts|seq|type|payload` keyed with the raw channel token. Receivers verify
 *   the MAC and enforce a replay window on (ts, seq).
 * - Coordination modes form an ordered ladder from most secure/slowest
 *   (mediated_only) to fastest/loosest (open_local). A mode is permitted iff
 *   it is at or below the project's selected mode AND at or below the
 *   workspace floor env when set. open_local is refused outright in
 *   production builds regardless of configuration (hard gate).
 */

export const CHANNEL_MODES = Object.freeze([
  'mediated_only',
  'registered_direct',
  'direct_preferred',
  'open_local',
]);

const CHANNEL_MODE_RANK = new Map(CHANNEL_MODES.map((mode, index) => [mode, index]));

export const CHANNEL_TRANSPORTS = Object.freeze(['websocket', 'sse']);

export const CHANNEL_TOKEN_PREFIX = 'csc_';
export const CHANNEL_MAX_DURATION_MS_DEFAULT = 30 * 60 * 1000;
export const CHANNEL_MAX_DURATION_MS_CAP = 30 * 60 * 1000;
export const CHANNEL_REPLAY_WINDOW_MS = 30 * 1000;
export const CHANNEL_GRANT_WINDOW_MS = 5 * 60 * 1000;
export const CHANNEL_MAX_ACTIVE_PER_SESSION_DEFAULT = 3;

export function channelsDisabled() {
  return ['1', 'true', 'yes'].includes(
    String(process.env.SYNTHI_CODESITE_CHANNELS_DISABLED || '').trim().toLowerCase(),
  );
}

function modeRank(mode) {
  return CHANNEL_MODE_RANK.has(mode) ? CHANNEL_MODE_RANK.get(mode) : -1;
}

/** True if the requested mode is within the allowed ladder position. */
export function modeAllows(requestedMode, requiredModeFloor) {
  const requestedRank = modeRank(requestedMode);
  const floorRank = modeRank(requiredModeFloor);
  if (requestedRank < 0 || floorRank < 0) return false;
  // Lower rank index = more restrictive. Allowed when requested is at least
  // as strict as the floor (rank <= floor rank).
  return requestedRank <= floorRank;
}

/**
 * Resolve the effective coordination mode for a channel request:
 * the project's own mode further constrained by the workspace floor env.
 * Returns { ok, mode?, reasonCode? } — fail-closed on unknown values.
 */
export function effectiveChannelMode(projectMode) {
  const production = process.env.NODE_ENV === 'production';
  const floorRaw = String(process.env.SYNTHI_CODESITE_MIN_CHANNEL_MODE || '').trim().toLowerCase();
  let candidate = String(projectMode || '').trim().toLowerCase();
  if (!CHANNEL_MODE_RANK.has(candidate)) {
    return { ok: false, reasonCode: 'codesite_channel_mode_invalid' };
  }
  if (candidate === 'open_local' && production) {
    return { ok: false, reasonCode: 'codesite_channel_mode_open_local_production_refused' };
  }
  if (floorRaw) {
    if (!CHANNEL_MODE_RANK.has(floorRaw)) {
      return { ok: false, reasonCode: 'codesite_channel_mode_floor_invalid' };
    }
    if (!modeAllows(candidate, floorRaw)) {
      return { ok: false, reasonCode: 'codesite_channel_mode_below_workspace_floor', detail: { floor: floorRaw } };
    }
  }
  return { ok: true, mode: candidate };
}

/** Which transports a given mode permits. mediated_only permits none. */
export function modeTransports(mode) {
  if (mode === 'mediated_only') return [];
  return [...CHANNEL_TRANSPORTS];
}

function maxActivePerSession() {
  const raw = Number(process.env.SYNTHI_CODESITE_MAX_ACTIVE_CHANNELS);
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return CHANNEL_MAX_ACTIVE_PER_SESSION_DEFAULT;
}

export function channelMaxDurationMs(requestedMs) {
  const value = Number.isFinite(Number(requestedMs)) ? Number(requestedMs) : CHANNEL_MAX_DURATION_MS_DEFAULT;
  if (value <= 0) return CHANNEL_MAX_DURATION_MS_DEFAULT;
  return Math.min(value, CHANNEL_MAX_DURATION_MS_CAP);
}

export function mintChannelToken() {
  return CHANNEL_TOKEN_PREFIX + randomBytes(24).toString('base64url');
}

export function hashChannelToken(token) {
  return `sha256:${createHash('sha256').update(String(token || ''), 'utf8').digest('hex')}`;
}

export function verifyChannelToken(token, tokenHash) {
  if (!token || !tokenHash) return false;
  const expected = Buffer.from(hashChannelToken(token));
  const actual = Buffer.from(String(tokenHash));
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/** HMAC-SHA256 over `ts|seq|type|payload` keyed with the raw channel token. */
export function frameMac({ token, ts, seq, type, payload }) {
  const base = [
    String(ts),
    String(Number(seq)),
    String(type || ''),
    typeof payload === 'string' ? payload : JSON.stringify(payload ?? null),
  ].join('|');
  return createHmac('sha256', String(token)).update(base).digest('hex');
}

export function verifyFrameMac({ token, ts, seq, type, payload }, mac) {
  if (!token || !mac) return false;
  const expected = Buffer.from(frameMac({ token, ts, seq, type, payload }));
  const actual = Buffer.from(String(mac));
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/** Replay-window check for an inbound frame timestamp (ISO or epoch ms). */
export function frameTimestampFresh(ts, nowMs = Date.now(), windowMs = CHANNEL_REPLAY_WINDOW_MS) {
  const value = typeof ts === 'number' ? ts : Date.parse(ts);
  if (!Number.isFinite(value)) return false;
  return Math.abs(nowMs - value) <= windowMs;
}

import { NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';

/**
 * GET /api/turn-credentials
 *
 * Returns short-lived TURN credentials from Cloudflare Calls.
 * The browser calls this before each WebRTC connect() so ICE
 * always has valid relay candidates.
 *
 * Env vars required:
 *   CLOUDFLARE_TURN_TOKEN_ID  — Cloudflare TURN token ID
 *   CLOUDFLARE_TURN_API_TOKEN — Cloudflare TURN API token (secret)
 *   TURN_CREDENTIAL_TTL       — credential lifetime in seconds (default 86400 = 24h)
 */

const CF_TOKEN_ID  = process.env.CLOUDFLARE_TURN_TOKEN_ID  || '';
const CF_API_TOKEN = process.env.CLOUDFLARE_TURN_API_TOKEN || '';
const TTL          = Number(process.env.TURN_CREDENTIAL_TTL) || 86400;

// ── In-memory cache to avoid hitting Cloudflare on every connect ────────────
// Credentials are refreshed when less than 20% of TTL remains.
let cached = null;          // { iceServers, expiresAt }
const REFRESH_MARGIN = 0.2; // refresh when 80% of TTL elapsed

function isCacheValid() {
  if (!cached) return false;
  const remaining = cached.expiresAt - Date.now();
  return remaining > TTL * 1000 * REFRESH_MARGIN;
}

async function fetchCloudflareCredentials() {
  // https://developers.cloudflare.com/calls/turn/generate-credentials/
  const res = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${CF_TOKEN_ID}/credentials/generate`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CF_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ttl: TTL }),
    },
  );

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Cloudflare TURN API ${res.status}: ${text}`);
  }

  const data = await res.json();

  // Cloudflare returns { iceServers: { urls: [...], username, credential } }
  const cf = data.iceServers;
  const iceServers = [
    // Always include a plain STUN entry for direct connectivity (lowest latency).
    { urls: ['stun:stun.cloudflare.com:3478'] },
    // TURN relay — used when STUN fails (symmetric NAT / corporate firewalls).
    {
      urls: Array.isArray(cf.urls) ? cf.urls : [cf.urls],
      username: cf.username,
      credential: cf.credential,
    },
  ];

  cached = { iceServers, expiresAt: Date.now() + TTL * 1000 };
  return iceServers;
}

export async function GET(req) {
  // Auth gate — only logged-in users may obtain TURN creds.
  const authSecret = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET;
  if (!authSecret) {
    return NextResponse.json({ error: 'Auth secret is not configured' }, { status: 500 });
  }
  const token = await getToken({ req, secret: authSecret });
  if (!token) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  // Fail gracefully when Cloudflare is not configured yet.
  if (!CF_TOKEN_ID || !CF_API_TOKEN) {
    const localUrl  = process.env.LOCAL_TURN_URL;
    const localUser = process.env.LOCAL_TURN_USERNAME;
    const localCred = process.env.LOCAL_TURN_CREDENTIAL;
    if (localUrl && localUser && localCred) {
      return NextResponse.json({
        iceServers: [
          { urls: ['stun:stun.l.google.com:19302'] },
          { urls: [localUrl], username: localUser, credential: localCred },
        ],
      });
    }
    return NextResponse.json({
      iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
      _fallback: true,
    });
  }

  try {
    const iceServers = isCacheValid() ? cached.iceServers : await fetchCloudflareCredentials();
    return NextResponse.json({ iceServers });
  } catch (e) {
    console.error('[TURN] Credential fetch failed:', e.message);
    // Degrade to STUN-only so the user isn't completely blocked.
    return NextResponse.json({
      iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
      _fallback: true,
      _error: e.message,
    });
  }
}

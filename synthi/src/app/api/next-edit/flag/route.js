import { NextResponse } from 'next/server';

// NEP server-side kill switch (Phase 3).
//
// Ops can flip NEP off for ALL sessions without touching client state.
// The client polls this endpoint with a short cache (60 s) and gates
// fireNep() on the response.
//
// Disable via env vars on the frontend:
//   NEP_FLAG_DISABLED=1                   — global kill
//   NEP_FLAG_DISABLED_REASON="..."        — message surfaced in telemetry
//
// Could later be replaced with a real feature-flag service (LaunchDarkly,
// Statsig, GrowthBook). For now this is a single env-driven gate that's
// easy to flip without redeploys (set in the runtime env, restart the
// frontend pod).
//
// Server-side kill is independent of the client-side rolling-window kill
// in nepTelemetry.js — they're complementary:
//   - client kill: this BROWSER's accept-rate is bad (local degradation)
//   - server kill: ops noticed a fleet-wide regression and pulled the lever

export async function GET() {
  const disabled = process.env.NEP_FLAG_DISABLED === '1' ||
                   process.env.NEP_FLAG_DISABLED === 'true';
  const reason = disabled
    ? (process.env.NEP_FLAG_DISABLED_REASON || 'NEP_FLAG_DISABLED=1')
    : null;
  return NextResponse.json({
    enabled: !disabled,
    reason,
    // 60-second client-side cache hint. Long enough that we don't pound
    // the route on every keystroke; short enough that ops flipping the
    // env var sees effect within a minute fleet-wide.
    cache_ttl_seconds: 60,
    server_ts: Date.now(),
  }, {
    headers: {
      'Cache-Control': 'public, max-age=60, stale-while-revalidate=120',
    },
  });
}

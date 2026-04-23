import { requireLive } from "./common.js";

/**
 * E4 — Vision cost budget reality check.
 *
 * From `AGENT_MCP_ULTRAPLAN.md:1362`:
 *   "30-minute Claude Code loop on counter_sdl2; record vision_inference_count
 *   + vision_cost_usd_estimate per 10-minute window; extrapolate hourly
 *   projection at p50 / p95.
 *     p50 > $4/hr → raise default (ceiling(p95 + 25% headroom)).
 *     p50 < $1.50/hr → lower default.
 *     $1.50 ≤ p50 ≤ $4 → confirm $5 default; document p95 tail in README."
 *
 * This experiment is **live-only** by definition — it depends on Claude
 * Code's real invocation rate against an instrumented claude_api backend.
 * Phase 0.5 ships the harness as a stub so the shape of the measurement
 * is in the tree before the backend lands in phase 1.
 *
 * To run once phase 1 claude_api is live:
 *   1. docker-compose up -d
 *   2. export ANTHROPIC_API_KEY=...
 *   3. export SPIKE_MODE=live
 *   4. npm run spike:E4 -- --duration-minutes=30
 *
 * The live driver should:
 *   - Create a counter_sdl2 session.
 *   - Pipe a Claude Code loop at the session that edits, verifies, and
 *     waits — at least 5 edit-HMR-screenshot-verify cycles with locator
 *     usage mixed in.
 *   - Poll synthi_get_usage every 60 s (phase-1 tool) for
 *     vision_inference_count + vision_cost_usd_estimate.
 *   - Emit 10-minute windows; project hourly p50/p95.
 *
 * Output shape for the findings doc:
 *   {
 *     durationMinutes: 30,
 *     windows: [{ windowIndex, inferences, costUsd }, ...],
 *     hourlyProjection: { p50, p95 },
 *     verdict: "raise" | "lower" | "confirm",
 *     proposedDefaultUsd: number,
 *   }
 */

export interface E4RunOpts {
  durationMinutes?: number;
  windowMinutes?: number;
}

export interface E4Result {
  mode: "live-stub";
  durationMinutes: number;
  windowMinutes: number;
  note: string;
}

export async function runE4(opts: E4RunOpts = {}): Promise<E4Result> {
  requireLive("E4");
  const durationMinutes = opts.durationMinutes ?? 30;
  const windowMinutes = opts.windowMinutes ?? 10;
  return {
    mode: "live-stub",
    durationMinutes,
    windowMinutes,
    note: "E4 driver is wired in phase 1 after synthi_get_usage + claude_api backend ship. See tests/spike/E4_cost_budget.ts header for the protocol.",
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  (async (): Promise<void> => {
    try {
      const result = await runE4();
      console.log(JSON.stringify({ experiment: "E4", ...result }, null, 2));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(JSON.stringify({ experiment: "E4", status: "skipped", reason: message }, null, 2));
    }
  })();
}

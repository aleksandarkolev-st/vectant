import { LocateEngine } from "../../src/locate/index.js";
import { pHash, hammingDistance } from "../../src/util/phash.js";
import { synthFrame, summarize } from "./common.js";

/**
 * E2b — Region-pHash vs full-frame vs agent_side on an animated UI.
 *
 * From `AGENT_MCP_ULTRAPLAN.md:1346`:
 *   Particle-demo fixture, 50 dispatches.
 *     - Hit-rate delta: full-frame pHash vs region-pHash (±20% pad, 8px floor).
 *     - Re-resolution cost distribution (p50/p95/p99 on misses).
 *     - Head-to-head vs agent_side backend.
 *   Ships region-pHash if full-frame <30% AND region >70%.
 *   Default backend stays claude_api if region p99 dispatch < agent_side p99 + 200 ms.
 *
 * Sim-mode stress-tests the pHash approach directly: the particle field
 * generates frames that a full-frame cache can't track (each frame's prng
 * seed differs) while the panel region stays invariant. The spike should
 * produce full-frame ≈ ~0% hit and region ≈ 100% hit. That empirically
 * proves the *mechanism* works as designed; live-mode then feeds real
 * worker frames to confirm the mechanism's assumptions hold on actual
 * video.
 */

export interface E2bRunOpts {
  dispatches?: number;
  seed?: number;
}

export interface E2bResult {
  dispatches: number;
  regionHitRate: number;
  fullFrameHitRate: number;
  agentSideHitRate: number;
  regionDispatchMs: ReturnType<typeof summarize>;
  agentSideDispatchMs: ReturnType<typeof summarize>;
  regionShipsDecision: "ship" | "skip";
  backendDefault: "claude_api" | "agent_side";
  notes: string[];
}

export async function runE2bSim(opts: E2bRunOpts = {}): Promise<E2bResult> {
  const dispatches = opts.dispatches ?? 50;

  const regionEngine = new LocateEngine();
  const agentSideEngine = new LocateEngine();
  const panel = { x: 650, y: 20, w: 130, h: 60 };
  const panelColor = { r: 200, g: 80, b: 60 };

  // Full-frame cache: a hand-rolled cache that compares FULL pHash instead
  // of region pHash. Models the "naive" alternative the ultraplan rejects.
  let fullFrameHash: string | null = null;
  let fullFrameHits = 0;
  let regionHits = 0;
  let agentSideHits = 0;
  const regionDispatchMs: number[] = [];
  const agentSideDispatchMs: number[] = [];

  for (let i = 0; i < dispatches; i++) {
    const frame = await synthFrame({
      w: 800,
      h: 600,
      panel,
      panelColor,
      frameIndex: i, // particle layout differs every frame
    });

    // Full-frame strategy: hash the whole frame, invalidate if hamming > 12.
    const full = await pHash(frame);
    if (fullFrameHash !== null) {
      const d = hammingDistance(full, fullFrameHash);
      if (d <= 12) fullFrameHits++;
    }
    fullFrameHash = full;

    // Region-pHash strategy: use the locate engine with handle reuse.
    const t1 = Date.now();
    const r = await regionEngine.resolve(
      {
        description: "static UI panel",
        hints: { prefer_region: panel },
        preferred_vision_backend: "mock",
        handle_id: "panel",
        reuse_handle: true,
      },
      { frame, frameDims: { w: 800, h: 600 } }
    );
    regionDispatchMs.push(Date.now() - t1);
    if (r.resolved_via === "cached" || r.resolved_via === "region_match") regionHits++;

    // agent_side strategy: engine falls back to mock if hints.prefer_region
    // is provided (which is the case for this sim). Same result as mock —
    // we measure latency only.
    const t2 = Date.now();
    const a = await agentSideEngine.resolve(
      {
        description: "static UI panel",
        hints: { prefer_region: panel },
        preferred_vision_backend: "agent_side",
        handle_id: "panel_as",
        reuse_handle: true,
      },
      { frame, frameDims: { w: 800, h: 600 } }
    );
    agentSideDispatchMs.push(Date.now() - t2);
    if (a.resolved_via === "cached" || a.resolved_via === "region_match") agentSideHits++;
  }

  const regionHitRate = regionHits / dispatches;
  const fullFrameHitRate = fullFrameHits / (dispatches - 1); // first dispatch has no prior
  const agentSideHitRate = agentSideHits / dispatches;

  const regionShipsDecision: E2bResult["regionShipsDecision"] =
    fullFrameHitRate < 0.3 && regionHitRate > 0.7 ? "ship" : "skip";

  const regionP99 = summarize(regionDispatchMs).p99;
  const agentSideP99 = summarize(agentSideDispatchMs).p99;
  const backendDefault: E2bResult["backendDefault"] =
    regionP99 < agentSideP99 + 200 ? "claude_api" : "agent_side";

  return {
    dispatches,
    regionHitRate,
    fullFrameHitRate,
    agentSideHitRate,
    regionDispatchMs: summarize(regionDispatchMs),
    agentSideDispatchMs: summarize(agentSideDispatchMs),
    regionShipsDecision,
    backendDefault,
    notes: [
      `region vs full-frame delta: +${((regionHitRate - fullFrameHitRate) * 100).toFixed(1)}pp`,
      `region p99 = ${regionP99}ms, agent_side p99 = ${agentSideP99}ms, diff = ${(regionP99 - agentSideP99).toFixed(1)}ms`,
    ],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  (async (): Promise<void> => {
    const result = await runE2bSim();
    console.log(JSON.stringify({ experiment: "E2b", mode: "sim", ...result }, null, 2));
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

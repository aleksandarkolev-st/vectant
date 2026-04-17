import { LocateEngine } from "../../src/locate/index.js";
import { synthSolidFrame, summarize } from "./common.js";

/**
 * E2 — Locator cache hit rate on a static UI under edit cycles.
 *
 * From `AGENT_MCP_ULTRAPLAN.md:1340`:
 *   "50 realistic edit cycles on counter_sdl2 (HMR after each edit; agent
 *   dispatches synthi_mouse({handle}) before + after). Track (cached +
 *   region_match) / total. <30% → falsify the cache design. >70% → commit.
 *   30–70% → tune TTL / pHash threshold / padding."
 *
 * Sim-mode constructs synthetic frames that look like the counter fixture
 * between edits: (counter=k) → (counter=k+1). Background RGB differs
 * (matches counter/main.cpp's derivation), but the bbox of the "counter
 * display element" is identical across edits. Cache should hit on the
 * "before next edit" dispatch; miss + re-resolve on the "after edit"
 * dispatch (hamming > threshold).
 *
 * Per cycle: 2 dispatches (before + after HMR). 50 cycles → 100 dispatches.
 */

export interface E2RunOpts {
  cycles?: number;
  /** Bbox of the element we're tracking, in the synth frame. */
  elementBbox?: { x: number; y: number; w: number; h: number };
  seed?: number;
}

export interface E2Result {
  cycles: number;
  totalDispatches: number;
  cachedOrMatched: number;
  reResolved: number;
  hitRate: number;
  verdict: "falsify" | "commit" | "tune";
  hint: string;
  resolvedViaHistogram: Record<string, number>;
  perDispatchMs: ReturnType<typeof summarize>;
}

function counterColor(c: number): { r: number; g: number; b: number } {
  return {
    r: (c * 17) & 0xff,
    g: (c * 53) & 0xff,
    b: (c * 97) & 0xff,
  };
}

export async function runE2Sim(opts: E2RunOpts = {}): Promise<E2Result> {
  const cycles = opts.cycles ?? 50;
  const bbox = opts.elementBbox ?? { x: 300, y: 200, w: 100, h: 80 };
  const engine = new LocateEngine();

  const histogram: Record<string, number> = {
    cached: 0,
    region_match: 0,
    re_resolved: 0,
  };
  const latencies: number[] = [];
  let cachedOrMatched = 0;
  let reResolved = 0;

  for (let i = 0; i < cycles; i++) {
    const frameBefore = await synthSolidFrame(800, 600, counterColor(i));
    const t1 = Date.now();
    const r1 = await engine.resolve(
      {
        description: "counter display element",
        hints: { prefer_region: bbox },
        preferred_vision_backend: "mock",
        handle_id: "counter_el",
        reuse_handle: true,
      },
      { frame: frameBefore, frameDims: { w: 800, h: 600 } }
    );
    latencies.push(Date.now() - t1);
    histogram[r1.resolved_via]++;
    if (r1.resolved_via === "cached" || r1.resolved_via === "region_match") cachedOrMatched++;
    else reResolved++;

    // Simulate an edit: counter++ → background shifts. The element bbox is
    // identical, but its region-pHash changes because the background within
    // the padded region is different. The cache should flag drift on the
    // next dispatch and re-resolve.
    const frameAfter = await synthSolidFrame(800, 600, counterColor(i + 1));
    const t2 = Date.now();
    const r2 = await engine.resolve(
      {
        description: "counter display element",
        hints: { prefer_region: bbox },
        preferred_vision_backend: "mock",
        handle_id: "counter_el",
        reuse_handle: true,
      },
      { frame: frameAfter, frameDims: { w: 800, h: 600 } }
    );
    latencies.push(Date.now() - t2);
    histogram[r2.resolved_via]++;
    if (r2.resolved_via === "cached" || r2.resolved_via === "region_match") cachedOrMatched++;
    else reResolved++;
  }

  const total = cycles * 2;
  const hitRate = cachedOrMatched / total;
  let verdict: E2Result["verdict"];
  let hint: string;
  if (hitRate < 0.3) {
    verdict = "falsify";
    hint = "Cache buys <30% hits; ship synthi_locate as stateless-per-call.";
  } else if (hitRate > 0.7) {
    verdict = "commit";
    hint = "Cache pays its complexity; ship as planned with v4.1 semantics.";
  } else {
    verdict = "tune";
    hint = "Experiment with TTL / padding / drift threshold; report tuned version in PHASE_0_5_FINDINGS.md.";
  }
  return {
    cycles,
    totalDispatches: total,
    cachedOrMatched,
    reResolved,
    hitRate,
    verdict,
    hint,
    resolvedViaHistogram: histogram,
    perDispatchMs: summarize(latencies),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  (async (): Promise<void> => {
    const result = await runE2Sim();
    console.log(JSON.stringify({ experiment: "E2", mode: "sim", ...result }, null, 2));
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

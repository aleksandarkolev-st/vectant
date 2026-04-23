import { LocateEngine } from "../../src/locate/index.js";
import { synthSolidFrame, summarize } from "./common.js";

/**
 * E3 — claude_api p99 under load.
 *
 * From `AGENT_MCP_ULTRAPLAN.md:1355`:
 *   "10 parallel synthi_locate calls × 10 iterations = 100 measurements
 *   under realistic contention (counter_sdl2, not particle-demo).
 *   p99 > 5s → falsify claude_api default, flip to agent_side.
 *   p99 < 2.5s → confirm default.
 *   2.5-5s → claude_api default + README recommendation for agent_side."
 *
 * Sim-mode: claude_api is a stub today (phase-1 impl gated on this
 * measurement), so sim-mode reports the MCP-layer orchestration cost
 * only — roughly the floor above which real claude_api p99 will sit.
 * Live-mode: plug in a real Anthropic API call; this harness gives a
 * reproducible driver.
 */

export interface E3RunOpts {
  concurrency?: number;
  iterations?: number;
  backend?: "mock" | "agent_side" | "claude_api";
  seed?: number;
}

export interface E3Result {
  concurrency: number;
  iterations: number;
  totalDispatches: number;
  backend: string;
  latencyMs: ReturnType<typeof summarize>;
  verdict: "confirm" | "falsify" | "marginal";
  hint: string;
}

export async function runE3Sim(opts: E3RunOpts = {}): Promise<E3Result> {
  const concurrency = opts.concurrency ?? 10;
  const iterations = opts.iterations ?? 10;
  const backend = opts.backend ?? "mock";
  const engine = new LocateEngine();
  const bbox = { x: 300, y: 200, w: 100, h: 80 };
  const latencies: number[] = [];

  for (let iter = 0; iter < iterations; iter++) {
    const frame = await synthSolidFrame(800, 600, { r: iter * 3, g: iter * 5, b: iter * 7 });

    const parallel = Array.from({ length: concurrency }, (_, i) => (async (): Promise<number> => {
      const t0 = Date.now();
      try {
        await engine.resolve(
          {
            description: `counter digit ${i}`,
            hints: { prefer_region: bbox },
            preferred_vision_backend: backend,
            handle_id: `counter_${i}`,
            reuse_handle: false,
          },
          { frame, frameDims: { w: 800, h: 600 } }
        );
      } catch {
        // claude_api_not_implemented today — still a valid data point (the
        // error path's latency floor).
      }
      return Date.now() - t0;
    })());

    const times = await Promise.all(parallel);
    for (const t of times) latencies.push(t);
  }

  const latencyMs = summarize(latencies);
  let verdict: E3Result["verdict"];
  let hint: string;
  if (latencyMs.p99 > 5000) {
    verdict = "falsify";
    hint = "Flip default vision backend to agent_side in phase 1.";
  } else if (latencyMs.p99 < 2500) {
    verdict = "confirm";
    hint = "Keep claude_api as default.";
  } else {
    verdict = "marginal";
    hint = "claude_api default with README recommendation: set preferred_vision_backend: 'agent_side' for interactive loops.";
  }

  return {
    concurrency,
    iterations,
    totalDispatches: latencies.length,
    backend,
    latencyMs,
    verdict,
    hint,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  (async (): Promise<void> => {
    const result = await runE3Sim();
    console.log(JSON.stringify({ experiment: "E3", mode: "sim", ...result }, null, 2));
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

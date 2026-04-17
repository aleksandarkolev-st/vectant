import { classifyHmrMessage } from "../../src/hmr.js";
import { SyntheticHmrBus, summarize } from "./common.js";

/**
 * E1 — Frame-seq gate necessity.
 *
 * From `AGENT_MCP_ULTRAPLAN.md:1334`:
 *   "100 wait_hmr cycles on counter_sdl2 @ 60fps without the frame-seq
 *   gate. After each wait, immediately screenshot; compare against known
 *   post-HMR pixel signature. ≤2 stale screenshots → falsify the gate;
 *   ≥10 stale → commit; 3–9 marginal."
 *
 * Sim-mode simulates the race window. Each cycle:
 *   1. Injects an HMR terminal message (applied/state-migrated) after a
 *      random "compile delay".
 *   2. Ticks a virtual clock; checks whether the "frame currently delivered
 *      by the encoder" has a `ts_cap >= t_hmr + pipeline_budget_ms`.
 *   3. If the frame's ts_cap < t_hmr, the screenshot is STALE — this is
 *      the condition the frame-seq gate exists to prevent.
 *
 * Stale rate depends on pipeline_budget_ms vs frame cadence. The harness
 * sweeps cadence (30 vs 60 fps) and budget so live-run tuning has a
 * reference curve.
 */

export interface E1RunOpts {
  cycles?: number;
  fps?: number;
  pipelineBudgetMs?: number;
  /** Post-applied jitter window: actual frame cadence is fps with N(0, jitter). */
  jitterMs?: number;
  /** Random seed for reproducibility. */
  seed?: number;
}

export interface E1Result {
  cycles: number;
  stale: number;
  staleRate: number;
  elapsedMs: ReturnType<typeof summarize>;
  verdict: "falsify" | "commit" | "marginal";
  hint: string;
}

function prng(seed: number): () => number {
  let state = (seed * 2654435769) >>> 0;
  return (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

export async function runE1Sim(opts: E1RunOpts = {}): Promise<E1Result> {
  const cycles = opts.cycles ?? 100;
  const fps = opts.fps ?? 60;
  const pipelineBudgetMs = opts.pipelineBudgetMs ?? 80;
  const jitterMs = opts.jitterMs ?? 4;
  const seed = opts.seed ?? 42;

  const rand = prng(seed);
  const bus = new SyntheticHmrBus();
  const elapsedSamples: number[] = [];
  let stale = 0;

  for (let i = 0; i < cycles; i++) {
    // Simulate realistic compile latency: 30 ms (Tier 0) to 800 ms (Tier 1/2).
    const compileDelayMs = 30 + rand() * 770;
    const applyTs = Date.now() + compileDelayMs;

    const waitStart = Date.now();
    const terminal = await new Promise<{ status: string; elapsedMs: number }>((resolve) => {
      const unsub = bus.subscribe((msg) => {
        const cls = classifyHmrMessage(msg);
        if (!cls) return;
        unsub();
        resolve({ status: cls.status, elapsedMs: Date.now() - waitStart });
      });
      // Emit the terminal event after the compile delay.
      bus.emitAfter(compileDelayMs, { event: "Promoted", data: { preview_id: "sim", generation: i } });
    });

    elapsedSamples.push(terminal.elapsedMs);

    // At "wait_hmr returned" moment, what frame would the encoder deliver?
    // Frame cadence: one frame per 1000/fps ms ± jitter. The "current" frame
    // was captured at the most recent fps-boundary before wait_hmr resolved.
    const frameIntervalMs = 1000 / fps;
    const jitter = (rand() - 0.5) * 2 * jitterMs;
    const currentFrameTsCap = Date.now() - (Date.now() % frameIntervalMs) + jitter;

    // Is the delivered frame fresh enough to reflect the HMR change?
    // Without the frame-seq gate, wait_hmr returns on the status alone; the
    // frame may be from before the HMR applied.
    const freshThreshold = applyTs + pipelineBudgetMs;
    if (currentFrameTsCap < freshThreshold) {
      stale++;
    }
  }

  const staleRate = stale / cycles;
  let verdict: E1Result["verdict"];
  let hint: string;
  if (stale <= 2) {
    verdict = "falsify";
    hint = "Drop the frame-seq gate. Phase 1 ships wait_hmr as status-only.";
  } else if (stale >= 10) {
    verdict = "commit";
    hint = "Ship the encoder-timestamp gate. Phase 1 adds {type:'frame-advance', frame_seq, ts_ms} on build-log.";
  } else {
    verdict = "marginal";
    hint = "Commit the gate but add E1b: re-run at 30fps and under VFR content before phase 1 closes.";
  }
  return {
    cycles,
    stale,
    staleRate,
    elapsedMs: summarize(elapsedSamples),
    verdict,
    hint,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  (async (): Promise<void> => {
    const result = await runE1Sim();
    console.log(JSON.stringify({ experiment: "E1", mode: "sim", ...result }, null, 2));
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

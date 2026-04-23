import { runE1Sim } from "./E1_frame_seq.js";
import { runE2Sim } from "./E2_locator_cache.js";
import { runE2bSim } from "./E2b_region_phash.js";
import { runE3Sim } from "./E3_p99_load.js";
import { runE4 } from "./E4_cost_budget.js";
import { currentMode } from "./common.js";

/**
 * Orchestrator: runs E1/E2/E2b/E3 in sim mode + E4 in live-stub mode.
 * Prints a single JSON document to stdout so tests/spike/README.md can show
 *
 *   npm run spike:all > findings.json
 *
 * and the user drops the sections into PHASE_0_5_FINDINGS.md.
 */

async function main(): Promise<void> {
  const mode = currentMode();
  const output: Record<string, unknown> = {
    mode,
    generated_at: new Date().toISOString(),
  };

  const e1 = await runE1Sim();
  output["E1"] = e1;

  const e2 = await runE2Sim();
  output["E2"] = e2;

  const e2b = await runE2bSim();
  output["E2b"] = e2b;

  const e3 = await runE3Sim();
  output["E3"] = e3;

  try {
    const e4 = await runE4();
    output["E4"] = e4;
  } catch (err) {
    output["E4"] = {
      status: "skipped",
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  console.log(JSON.stringify(output, null, 2));
}

main().catch((err) => {
  console.error("[spike] orchestrator failed:", err);
  process.exit(1);
});

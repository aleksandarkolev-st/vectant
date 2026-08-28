import { describe, expect, it } from "vitest";
import { orchestrateReplay, type ReplayOrchestrationDeps } from "../../src/embodied/replay.js";
import type { CompetencyLicense } from "../../src/embodied/governance.js";
import type { SessionHandle, TraceFragmentLike } from "../../src/embodied/substrate.js";

const LICENSE: CompetencyLicense = {
  license_id: "lic",
  competency_id: "comp.x",
  substrate_scope: ["terminal"],
  realm_scopes: [{ realm_kind: "workspace", realm_id: "w1" }],
  entrustment: "E3_sandboxed_action",
  issued_at_ms: 0,
  expires_at_ms: Number.MAX_SAFE_INTEGER,
};

const HANDLE = {
  handle_id: "h",
  environment: {},
  realm: { realm_kind: "workspace", realm_id: "w1" },
} as unknown as SessionHandle;

const FRAGMENT: TraceFragmentLike = {
  trace_id: "t",
  steps: [{ event: 1 }, { event: 2 }, { event: 3 }],
};

function depsFrom(
  stepResults: Array<{ ok: boolean; classifier_trunk?: string }>,
  retryStep?: ReplayOrchestrationDeps["retryStep"],
): ReplayOrchestrationDeps {
  return {
    replay: async () => ({
      ok: stepResults.every((step) => step.ok),
      step_results: stepResults.map((step, index) => ({ step_index: index, ...step })),
    }),
    ...(retryStep ? { retryStep } : {}),
  };
}

const INPUT_BASE = {
  licenses: [LICENSE],
  competency_id: "comp.x",
  substrate_kind: "terminal",
  realm: HANDLE.realm,
  required_level: "E2_supervised" as const,
  now: 100,
  fragment: FRAGMENT,
  handle: HANDLE,
  explain: (stepIndex: number, trunk?: string) => `plain words for step ${stepIndex + 1} (${trunk})`,
};

describe("replay orchestration (plan replay.ts)", () => {
  it("refuses unlicensed runs before any execution", async () => {
    const result = await orchestrateReplay({
      ...INPUT_BASE,
      deps: depsFrom([]),
      licenses: [],
      now: 100,
    });
    expect(result.authorized).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.steps).toHaveLength(0);
    expect(result.refusal_reason).toBeTruthy();
  });

  it("passes through a clean run with hash", async () => {
    const result = await orchestrateReplay({
      ...INPUT_BASE,
      deps: {
        replay: async () => ({
          ok: true,
          step_results: [
            { step_index: 0, ok: true },
            { step_index: 1, ok: true },
            { step_index: 2, ok: true },
          ],
          final_world_hash: "abc123",
        }),
      },
    });
    expect(result.authorized).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.final_world_hash).toBe("abc123");
  });

  it("retries exactly one timing failure and clears it on recovery", async () => {
    let retryCalls = 0;
    const result = await orchestrateReplay({
      ...INPUT_BASE,
      deps: depsFrom(
        [
          { ok: true },
          { ok: false, classifier_trunk: "load_delay" },
          { ok: true },
        ],
        async (_fragment, _handle, stepIndex) => {
          retryCalls += 1;
          expect(stepIndex).toBe(1);
          return true; // recovered after waiting
        },
      ),
    });
    expect(retryCalls).toBe(1);
    expect(result.steps[1]!.ok).toBe(true);
    expect(result.steps[1]!.retried).toBe(true);
    expect(result.ok).toBe(true);
  });

  it("keeps non-timing failures classified with human explanations", async () => {
    const result = await orchestrateReplay({
      ...INPUT_BASE,
      deps: depsFrom([
        { ok: true },
        { ok: false, classifier_trunk: "identity_lost" },
        { ok: true },
      ]),
    });
    expect(result.ok).toBe(false);
    const failed = result.steps[1]!;
    expect(failed.classifier_trunk).toBe("identity_lost");
    expect(failed.human_explanation).toContain("plain words for step 2");
  });
});

import { describe, expect, it } from "vitest";
import {
  classifyFailure,
  registerAllFailureCatalogs,
} from "../../src/embodied/failure_catalog.js";
import { lookupSubstrateClass } from "../../src/embodied/classifier.js";

describe("substrate failure-class catalogs (plan trunk table)", () => {
  it("registers every plan-named subclass under its namespace", () => {
    registerAllFailureCatalogs();
    const expected = [
      ["game", "game.physics_blocked"],
      ["game", "game.entity_not_found"],
      ["game", "game.perception_low_confidence"],
      ["game", "game.tick_rate_variance"],
      ["game", "game.occlusion_unresolved"],
      ["game", "game.seed_drift"],
      ["kernel", "kernel.permission_denied"],
      ["kernel", "kernel.unit_failed"],
      ["kernel", "kernel.fs_readonly"],
      ["terminal", "terminal.nonzero_exit"],
      ["terminal", "terminal.prompt_desync"],
      ["terminal", "terminal.secret_detected"],
      ["api", "api.contract_mismatch"],
      ["api", "api.rate_limited"],
      ["api", "api.schema_drift"],
      ["runtime", "runtime.hmr_timeout"],
      ["runtime", "runtime.pod_evicted"],
    ] as const;
    for (const [substrate, id] of expected) {
      const entry = lookupSubstrateClass(substrate, id);
      expect(entry, `${id} missing`).toBeDefined();
      expect(entry!.id).toBe(id); // namespacing invariant held
    }
  });

  it("classification always pairs trunk with subclass", () => {
    const classified = classifyFailure("game", "game.seed_drift");
    expect(classified.trunk).toBe("world_changed");
    expect(classified.subclass).toBe("game.seed_drift");

    const terminal = classifyFailure("terminal", "terminal.secret_detected");
    expect(terminal.trunk).toBe("unsafe_environment");

    const runtime = classifyFailure("runtime", "runtime.pod_evicted");
    expect(runtime.trunk).toBe("substrate_limitation");
  });

  it("unknown subclass ids fall back to a substrate-appropriate trunk", () => {
    const terminalFallback = classifyFailure("terminal", undefined);
    expect(terminalFallback.trunk).toBe("app_validation_error");
    const kernelFallback = classifyFailure("kernel", undefined);
    expect(kernelFallback.trunk).toBe("substrate_limitation");
    const unknownSubstrate = classifyFailure("mystery.world", undefined);
    expect(unknownSubstrate.trunk).toBe("unknown");
  });
});

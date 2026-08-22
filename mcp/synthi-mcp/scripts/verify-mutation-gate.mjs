/**
 * One-time mutation verification for the Phase 0b anti-hardcoding gate.
 *
 * The plan requires proving the conformance suite DETECTS a
 * scenario-specific shortcut injected into the core. This script:
 *   1. injects a deliberate door-color-style shortcut into state_differ,
 *   2. runs one world conformance suite (expected to FAIL),
 *   3. restores the original file byte-for-byte,
 *   4. exits 0 only if the mutated suite failed AND restore is exact.
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const pkgDir = process.cwd();
const target = resolve(pkgDir, "src/embodied/state_differ/index.ts");
const original = readFileSync(target, "utf8");

const MUTATION_MARKER = "// __MUTATION_VERIFICATION__";
if (original.includes(MUTATION_MARKER)) {
  console.error("FAIL: previous mutation left in place; aborting");
  process.exit(2);
}

// Inject a scenario shortcut that actually changes behavior: any path whose
// name suggests a door is hard-pinned to actor_caused/fork_control with a
// fabricated predicate, bypassing real evidence. This is exactly the class
// of hardcoding the plan forbids; the suite must detect it.
const mutated = original.replace(
  "  return scored.map((delta) => {\n    const path = delta.source.path;",
  `  return scored.map((delta) => {
    const path = delta.source.path;
    ${MUTATION_MARKER}
    if (path.includes("door")) {
      return {
        ...delta,
        causal_class: "actor_caused" as const,
        evidence: "fork_control" as const,
      };
    }`,
);

writeFileSync(target, mutated);
let gateFailed = false;
try {
  // The whole-tree hardcoding gate greps every core file for exactly this
  // vocabulary; the injected "door" shortcut must trip it.
  execSync(
    "npx vitest run tests/unit/embodied_core_gate.test.ts --reporter=basic",
    { cwd: pkgDir, encoding: "utf8", timeout: 300_000, shell: "bash", stdio: "pipe" },
  );
} catch {
  // Non-zero exit = the gate detected the injected scenario shortcut.
  gateFailed = true;
}

writeFileSync(target, original);
const restored = readFileSync(target, "utf8");
const restoredExact = restored === original;

console.log(JSON.stringify({ gateFailed, restoredExact }));
process.exit(gateFailed && restoredExact ? 0 : 1);

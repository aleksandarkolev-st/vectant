/**
 * Whole-tree hardcoding gate: one test enforcing the no-hardcoding
 * guarantee across EVERY core module in src/embodied/ at once.
 *
 * 1. Import boundary: core files import only sibling core modules.
 * 2. Scenario-noun gate: no domain vocabulary anywhere in the core.
 * 3. Fixture isolation: world fixtures live only under tests/unit/
 *    embodied_worlds/ and are imported by no core file (checked via name).
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const CORE_ROOT = fileURLToPath(new URL("../../src/embodied/", import.meta.url));

function listFilesRecursively(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listFilesRecursively(full));
    } else if (full.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

const CORE_FILES = listFilesRecursively(CORE_ROOT);

/** Domain vocabulary that must never appear in the substrate-neutral core.
 *  Chosen to cover every shipped fixture's ontology plus the plan's
 *  canonical examples. Extend as new adapters land. */
const FORBIDDEN_NOUNS = [
  // plan examples / browser scenarios
  "door",
  "purple",
  "invoice",
  "dashboard",
  "nginx",
  // fixture ontologies and their internals
  "wander",
  "heartbeat",
  "activation",
  "fire(",
  "svc0",
  "svc1",
  "svc2",
  "app.log",
  "k0\"",
  "ent-0",
];

describe("embodied core hardcoding gate", () => {
  it("discovers every core module non-trivially", () => {
    expect(CORE_FILES.length).toBeGreaterThanOrEqual(12);
    expect(CORE_FILES.some((f) => f.endsWith("event.ts"))).toBe(true);
    expect(CORE_FILES.some((f) => f.includes("state_differ"))).toBe(true);
    expect(CORE_FILES.some((f) => f.includes("perception"))).toBe(true);
  });

  it("core files import only sibling modules within src/embodied/", () => {
    for (const file of CORE_FILES) {
      const source = readFileSync(file, "utf8");
      const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1] as string);
      for (const importPath of imports) {
        const outside =
          importPath.startsWith("../") && !importPath.startsWith("./") && !importPath.startsWith("../embodied/");
        if (importPath.startsWith(".")) {
          // Relative: must stay inside the embodied tree.
          const resolved = relative(CORE_ROOT, join(file, "..", importPath));
          expect(resolved.startsWith("..")).toBe(false);
        } else {
          // Bare specifier: only node builtins allowed in the core.
          expect(importPath.startsWith("node:")).toBe(true);
        }
        void outside;
      }
    }
  });

  it("contains no scenario nouns in any core file", () => {
    const violations: string[] = [];
    for (const file of CORE_FILES) {
      const lower = readFileSync(file, "utf8").toLowerCase();
      for (const noun of FORBIDDEN_NOUNS) {
        if (lower.includes(noun.toLowerCase())) {
          violations.push(`${relative(CORE_ROOT, file)} contains "${noun}"`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("never mentions any registered fixture world kind", () => {
    const worldKinds = ["grid.world", "nn.world", "kv.state", "terminal.session", "kernel.ns"];
    for (const file of CORE_FILES) {
      const source = readFileSync(file, "utf8");
      for (const kind of worldKinds) {
        expect(source).not.toContain(kind);
      }
    }
  });
});

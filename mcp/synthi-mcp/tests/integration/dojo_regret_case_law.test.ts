import { describe, expect, it } from "vitest";
import { InMemoryDojoCaseLawRegistry } from "../../src/dojo/case_law/registry.js";
import { createCaseLawCandidateFromRegretFossils } from "../../src/dojo/regret/branch_fossil.js";
import type { BranchFossil } from "../../src/dojo/regret/types.js";

describe("Dojo regret case-law candidates", () => {
  it("converts repeated strong fossils into proposed case law only", () => {
    const candidate = createCaseLawCandidateFromRegretFossils({
      fossils: [fossil("fossil-a"), fossil("fossil-b")],
      binding_scope: { kind: "workspace", id: "workspace-a" },
      now: "2026-06-24T03:00:00.000Z",
    });
    if (!candidate) throw new Error("expected candidate");
    const registry = new InMemoryDojoCaseLawRegistry();
    const proposed = registry.propose(candidate);

    expect(proposed).toEqual(expect.objectContaining({
      status: "proposed",
      evidence_refs: ["ledger://fossil-a", "ledger://fossil-b"],
    }));
    expect(registry.listBindingCases({ kind: "workspace", id: "workspace-a" })).toEqual([]);
    expect(registry.approve(proposed.case_id, {
      reviewer: "reviewer-a",
      now: "2026-06-24T03:05:00.000Z",
    })).toEqual(expect.objectContaining({ status: "approved" }));
    expect(registry.listBindingCases({ kind: "workspace", id: "workspace-a" })).toHaveLength(1);
  });

  it("does not propose case law for one-off weak or ambiguous fossils", () => {
    expect(createCaseLawCandidateFromRegretFossils({
      fossils: [fossil("weak", { counterfactual_strength: "weak" })],
      binding_scope: { kind: "workspace", id: "workspace-a" },
      now: "2026-06-24T03:00:00.000Z",
    })).toBeNull();
    expect(createCaseLawCandidateFromRegretFossils({
      fossils: [
        fossil("strong-a"),
        fossil("ambiguous", { ambiguity_flags: ["cancellation"] }),
      ],
      binding_scope: { kind: "workspace", id: "workspace-a" },
      now: "2026-06-24T03:00:00.000Z",
    })).toBeNull();
  });
});

function fossil(fossilId: string, overrides: Partial<BranchFossil> = {}): BranchFossil {
  return {
    schema_version: "synthi.dojo.regret.branchFossil.v1",
    fossil_id: fossilId,
    counterfactual_run_id: "cfr-1",
    branch_id: `branch-${fossilId}`,
    tenant_id: "tenant-a",
    workspace_id: "workspace-a",
    skill_id: "skill-a",
    task_class: "invoice_submit",
    base_state_hash: "sha256:base",
    exposure_level: "opened",
    counterfactual_strength: "strong",
    ambiguity_flags: [],
    summary: "API-backed branch needs rollback proof before promotion.",
    lesson: "API-backed execution needs rollback proof before promotion.",
    evidence_ids: [`ledger://${fossilId}`],
    created_at: "2026-06-24T03:00:00.000Z",
    retention_policy: "compact_fossil",
    ...overrides,
  };
}

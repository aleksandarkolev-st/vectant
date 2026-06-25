import {
  createDojoCaseLawFromFailure,
  type DojoCaseLawBindingScope,
  type DojoCaseLawRecord,
} from "../case_law/registry.js";
import type { BranchFossil } from "./types.js";
import { uniqueRegretStrings } from "./types.js";

export function createCaseLawCandidateFromRegretFossils(input: {
  fossils: BranchFossil[];
  binding_scope: DojoCaseLawBindingScope;
  now: string;
  min_repeated_strong_count?: number;
}): DojoCaseLawRecord | null {
  const minCount = input.min_repeated_strong_count ?? 2;
  const strongFossils = input.fossils.filter((fossil) =>
    fossil.counterfactual_strength === "strong"
    && fossil.exposure_level !== "none"
    && fossil.evidence_ids.length > 0
    && fossil.ambiguity_flags.length === 0
  );
  if (strongFossils.length < minCount) return null;

  const first = strongFossils[0]!;
  const evidenceRefs = uniqueRegretStrings(strongFossils.flatMap((fossil) => fossil.evidence_ids));
  if (evidenceRefs.length === 0) return null;
  return createDojoCaseLawFromFailure({
    source_skill_id: first.skill_id ?? "workspace",
    source_run_id: first.counterfactual_run_id,
    scenario_id: first.task_class,
    mutation_kind: first.task_class,
    finding: first.lesson ?? first.summary,
    impact: "Repeated evidence-backed near miss should be reviewed before becoming binding policy.",
    rule_created: "Require reviewer-approved guardrail or scenario coverage for repeated regret near misses.",
    applies_to: uniqueRegretStrings(strongFossils.map((fossil) => fossil.task_class)),
    binding_scope: input.binding_scope,
    evidence_refs: evidenceRefs,
    now: input.now,
  });
}

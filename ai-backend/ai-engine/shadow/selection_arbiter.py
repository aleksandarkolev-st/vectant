"""Selection Arbiter: rank only branches that survived proof gates."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Iterable, List, Optional

from .counterfactual_types import BranchTrace
from .proof_arbiter import ProofVerdict


@dataclass
class SelectionVerdict:
    winner: Optional[str]
    ranking: List[str]
    rationale: str
    risky_candidates: List[str]

    def to_dict(self) -> Dict[str, object]:
        return {
            "winner": self.winner,
            "ranking": self.ranking,
            "rationale": self.rationale,
            "risky_candidates": self.risky_candidates,
        }


def rank_selection(traces: Iterable[BranchTrace], proof: ProofVerdict) -> SelectionVerdict:
    by_id = {t.universe_id: t for t in traces}
    eligible = [by_id[uid] for uid in proof.eligible_universe_ids if uid in by_id]
    ranked = sorted(
        eligible,
        key=lambda t: (-t.proof_score, t.risk_score, t.diff_summary.get("loc_added", 0) + t.diff_summary.get("loc_removed", 0)),
    )
    ranking = [t.universe_id for t in ranked]
    winner = ranking[0] if ranking else None
    if winner:
        rationale = "Ranked proof-valid branches by proof score, risk, then patch size."
    else:
        rationale = "No branch survived proof gates."
    return SelectionVerdict(
        winner=winner,
        ranking=ranking,
        rationale=rationale,
        risky_candidates=list(proof.blocked_universe_ids),
    )

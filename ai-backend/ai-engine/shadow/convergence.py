"""Convergence detection. Master plan §12.

When all completed universes produce essentially identical patches, the
orchestrator cancels pending universes, skips the Arbiter, and emits a
"consensus" event so the UI can show a single card.

Similarity is computed on the *normalized* patched content of every
file produced by a universe — whitespace + trailing newlines + blank
lines collapsed before comparison. We do not compare diffs against the
seed because two universes that produce the same final code via
different patch hunks are still in agreement.

Threshold: 0.92 (master plan §12) — a typo fix or a one-line return
swap will easily clear this; a "rewrite the function" disagreement
won't.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import Any, Dict, List, Optional

from .universe import UniverseResult

logger = logging.getLogger("shadow.convergence")

CONVERGENCE_THRESHOLD = 0.92


@dataclass
class ConvergenceResult:
    consensus_universe_id: str
    similarity: float
    cohort: List[str]  # universe ids that agreed


def detect_convergence(done: List[UniverseResult]) -> Optional[ConvergenceResult]:
    """Return a ConvergenceResult iff at least 2 universes finished and they
    agree above CONVERGENCE_THRESHOLD on every patched file.

    `done` should contain only successful (non-rejected) universes.
    """
    valid = [u for u in done if u.patches_applied]
    if len(valid) < 2:
        return None

    # Pick the highest-scoring universe as the "consensus pick" — it's the
    # one we'd recommend if downstream skips the Arbiter.
    valid_sorted = sorted(valid, key=lambda u: u.score, reverse=True)
    pivot = valid_sorted[0]
    pivot_norm = _normalize_universe(pivot)

    similarities: List[float] = []
    cohort: List[str] = [pivot.universe_id]
    for u in valid_sorted[1:]:
        sim = _similarity(pivot_norm, _normalize_universe(u))
        similarities.append(sim)
        if sim >= CONVERGENCE_THRESHOLD:
            cohort.append(u.universe_id)

    # Convergence requires every other universe (not just one) to agree.
    if len(cohort) != len(valid_sorted):
        return None

    avg = sum(similarities) / len(similarities) if similarities else 1.0
    return ConvergenceResult(
        consensus_universe_id=pivot.universe_id,
        similarity=round(avg, 3),
        cohort=cohort,
    )


# ---------------------------------------------------------------------------
# Normalization helpers
# ---------------------------------------------------------------------------

_BLANK_LINE_RE = re.compile(r"\n[ \t]*\n+")
_TRAILING_WS_RE = re.compile(r"[ \t]+\n")


def _normalize_universe(u: UniverseResult) -> Dict[str, str]:
    """Return { path: normalized_content } for every file the universe
    produced. Two universes are compared file-for-file; if one produced
    a file the other didn't, that file alone drives a 0.0 similarity
    contribution.
    """
    out: Dict[str, str] = {}
    for p in u.patches_applied:
        out[p.path] = _normalize(p.new_content)
    return out


def _normalize(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = _TRAILING_WS_RE.sub("\n", text)
    text = _BLANK_LINE_RE.sub("\n\n", text)
    return text.strip()


def _similarity(a: Dict[str, str], b: Dict[str, str]) -> float:
    """Aggregate similarity across the union of files.

    Files only one universe wrote count as 0; matched files contribute
    their `SequenceMatcher.ratio()`. The aggregate is the *minimum* over
    files (a single divergent file invalidates convergence — we don't
    want a unanimous typo fix to mask a substantive disagreement on
    another file).
    """
    keys = set(a) | set(b)
    if not keys:
        return 1.0
    scores: List[float] = []
    for k in keys:
        if k not in a or k not in b:
            scores.append(0.0)
            continue
        scores.append(SequenceMatcher(None, a[k], b[k]).ratio())
    return min(scores)

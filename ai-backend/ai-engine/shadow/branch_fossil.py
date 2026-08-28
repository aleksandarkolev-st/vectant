"""Create bounded durable fossils from normalized branch telemetry."""

from __future__ import annotations

import hashlib
import time
from typing import Iterable, List

from .counterfactual_types import BranchFossil, BranchTrace, DetectorResult


def fossilize(
    *,
    trace: BranchTrace,
    detectors: Iterable[DetectorResult],
    workspace_id: str,
    task_class: str,
    inferred_lessons: List[str] | None = None,
    now: float | None = None,
    retention_days: int = 365,
) -> BranchFossil:
    created_at = time.time() if now is None else now
    detector_summary = [
        {"detector_kind": item.detector_kind.value, "status": item.status.value,
         "score": item.score, "evidence_summary": item.evidence_summary[:320]}
        for item in detectors
    ]
    digest = hashlib.sha256(f"{trace.counterfactual_run_id}:{trace.id}".encode()).hexdigest()[:16]
    return BranchFossil(
        id=f"fossil_{digest}", branch_trace_id=trace.id, workspace_id=workspace_id,
        task_class=task_class, runner_kind=trace.runner_kind, direction_label=trace.direction_label[:160],
        # Fossils are learning material, never an alternate source archive.
        compact_artifact_summary="Bounded branch artifact retained by reference, not copied into durable memory.",
        compact_diff_summary=dict(trace.diff_summary),
        phenotype_vector=trace.phenotype_vector, detector_summary=detector_summary,
        selection_outcome=trace.selection_outcome, exposure_level=trace.exposure_level,
        counterfactual_strength=trace.counterfactual_strength,
        inferred_lessons=list(inferred_lessons or [])[:16],
        source_counterfactual_run_id=trace.counterfactual_run_id, created_at=created_at,
        decay_after=created_at + retention_days * 86400,
    )

"""Deterministic, non-retentive summary of edits made after branch apply."""

from __future__ import annotations

import difflib
import time
from typing import Iterable, Mapping

from .counterfactual_types import PostSelectionMutation


def summarize_post_selection_mutation(
    *,
    selected_branch_id: str,
    observation_window: str,
    files: Iterable[Mapping[str, object]],
    abstraction_removed: bool = False,
    tests_added_by_user: bool = False,
    ui_changed_by_user: bool = False,
    runtime_changed_by_user: bool = False,
    now: float | None = None,
) -> PostSelectionMutation:
    """Compare supplied generated and observed text without persisting either.

    Each file record supports ``path``, ``generated_content``, and
    ``observed_content``. The durable object contains counts and a summary
    only, never either source payload.
    """
    changed, retained, deleted = [], 0, 0
    ratios = []
    for item in files:
        path = str(item.get("path") or "unknown")[:512]
        generated = str(item.get("generated_content") or "")
        observed = str(item.get("observed_content") or "")
        ratio = difflib.SequenceMatcher(a=generated, b=observed, autojunk=False).ratio()
        ratios.append(ratio)
        if ratio < 0.999:
            changed.append(path)
        if generated and observed:
            retained += 1
        if generated and not observed:
            deleted += 1
    mean_ratio = sum(ratios) / len(ratios) if ratios else 1.0
    score = _retention_score(mean_ratio, abstraction_removed, deleted, len(ratios))
    summary = _summary(score, changed, abstraction_removed, tests_added_by_user, ui_changed_by_user, runtime_changed_by_user)
    return PostSelectionMutation(
        selected_branch_id=selected_branch_id,
        observation_window=observation_window[:160],
        files_changed_after_apply=changed[:100],
        deleted_generated_blocks=deleted,
        retained_generated_blocks=retained,
        abstraction_removed=abstraction_removed,
        tests_added_by_user=tests_added_by_user,
        ui_changed_by_user=ui_changed_by_user,
        runtime_changed_by_user=runtime_changed_by_user,
        mutation_summary=summary,
        retention_score=score,
        observed_at=time.time() if now is None else now,
    )


def _retention_score(mean_ratio: float, abstraction_removed: bool, deleted: int, total: int) -> float:
    if total and deleted == total:
        return 0.0
    if abstraction_removed:
        return 0.1
    if mean_ratio >= 0.98:
        return 1.0
    if mean_ratio >= 0.80:
        return 0.7
    return 0.4 if mean_ratio >= 0.35 else 0.1


def _summary(score: float, changed: list[str], abstraction_removed: bool, tests_added: bool, ui_changed: bool, runtime_changed: bool) -> str:
    if abstraction_removed:
        core = "The selected branch survived application, but its main abstraction was removed."
    elif score == 0.0:
        core = "Generated change was reverted during the observation window."
    elif score >= 0.98:
        core = "The selected branch was retained almost unchanged."
    elif score >= 0.7:
        core = "The selected branch was retained with small follow-up edits."
    else:
        core = "The selected branch was meaningfully rewritten after application."
    facets = [name for name, present in (("tests", tests_added), ("UI", ui_changed), ("runtime", runtime_changed)) if present]
    return f"{core} Changed files: {', '.join(changed[:6]) or 'none'}. Follow-up areas: {', '.join(facets) or 'none'}."

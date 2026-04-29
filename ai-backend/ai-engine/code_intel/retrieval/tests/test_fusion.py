"""Smoke tests for retrieval/fusion.py — RRF + MMR helpers."""

from __future__ import annotations

import numpy as np
import pytest

from code_intel.retrieval.fusion import (
    cosine_similarity,
    jaccard_similarity,
    mmr,
    reciprocal_rank_fusion,
)


# ---------------------------------------------------------------------------
# Reciprocal Rank Fusion
# ---------------------------------------------------------------------------

def test_rrf_orders_by_combined_rank():
    # A is rank 1 in both lists → highest combined score.
    fused = reciprocal_rank_fusion(
        ranked_lists=[["A", "B", "C"], ["A", "C", "B"]],
    )
    assert fused[0][0] == "A"
    fused_ids = [doc for doc, _ in fused]
    assert set(fused_ids) == {"A", "B", "C"}


def test_rrf_handles_missing_items_in_one_list():
    fused = reciprocal_rank_fusion(
        ranked_lists=[["A", "B"], ["B"]],
    )
    # B is in both at decent ranks, A is only in the first list.
    fused_ids = [doc for doc, _ in fused]
    assert fused_ids[0] == "B"
    assert "A" in fused_ids


def test_rrf_weights_change_outcome():
    # Without weights, A beats B because it's rank 1 in two lists.
    base = reciprocal_rank_fusion(
        ranked_lists=[["A", "B"], ["A", "B"], ["B", "A"]],
    )
    assert base[0][0] == "A"
    # Weight the last list heavily and B should win.
    weighted = reciprocal_rank_fusion(
        ranked_lists=[["A", "B"], ["A", "B"], ["B", "A"]],
        weights=[0.1, 0.1, 5.0],
    )
    assert weighted[0][0] == "B"


def test_rrf_empty_lists_returns_empty():
    assert reciprocal_rank_fusion(ranked_lists=[]) == []
    assert reciprocal_rank_fusion(ranked_lists=[[]]) == []


def test_rrf_weights_length_must_match():
    with pytest.raises(ValueError):
        reciprocal_rank_fusion(
            ranked_lists=[["A"], ["B"]],
            weights=[1.0],  # mismatched
        )


# ---------------------------------------------------------------------------
# Maximal Marginal Relevance
# ---------------------------------------------------------------------------

def test_mmr_picks_relevant_then_diverse():
    items = ["A", "B", "C"]
    relevances = {"A": 0.95, "B": 0.90, "C": 0.30}
    # B is nearly identical to A; C is unrelated.
    sims = {("A", "B"): 0.95, ("B", "A"): 0.95}

    out = mmr(
        candidates=items,
        relevance_fn=lambda c: relevances[c],
        similarity_fn=lambda a, b: sims.get((a, b), 0.0),
        lambda_=0.5,
        top_k=2,
    )
    # MMR should pick A first (highest relevance), then C (less similar
    # to A than B, even though B has higher raw relevance).
    assert out[0] == "A"
    assert out[1] == "C"


def test_mmr_lambda_one_is_pure_relevance():
    items = ["A", "B", "C"]
    relevances = {"A": 0.5, "B": 0.9, "C": 0.7}
    out = mmr(
        candidates=items,
        relevance_fn=lambda c: relevances[c],
        similarity_fn=lambda a, b: 0.0,  # no diversity penalty
        lambda_=1.0,
        top_k=3,
    )
    assert out == ["B", "C", "A"]


def test_mmr_caps_at_top_k():
    out = mmr(
        candidates=list("ABCDE"),
        relevance_fn=lambda c: 1.0,
        similarity_fn=lambda a, b: 0.0,
        top_k=3,
    )
    assert len(out) == 3


# ---------------------------------------------------------------------------
# Similarity helpers
# ---------------------------------------------------------------------------

def test_cosine_handles_zero_vectors():
    assert cosine_similarity(np.zeros(4), np.array([1.0, 0, 0, 0])) == 0.0
    assert cosine_similarity(None, np.array([1.0])) == 0.0
    assert cosine_similarity(np.array([1.0, 0, 0]), np.array([1.0, 0, 0])) == pytest.approx(1.0)


def test_jaccard_basic():
    assert jaccard_similarity({"a", "b"}, {"a", "b"}) == 1.0
    assert jaccard_similarity({"a"}, {"b"}) == 0.0
    assert jaccard_similarity({"a", "b", "c"}, {"a"}) == pytest.approx(1 / 3)
    assert jaccard_similarity(set(), {"a"}) == 0.0

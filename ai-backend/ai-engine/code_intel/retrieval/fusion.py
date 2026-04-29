"""
Reciprocal Rank Fusion (RRF) + Maximal Marginal Relevance (MMR).

Two retrieval-stage utilities that drop into the existing pipeline as
alternatives to the weighted-sum hybrid scorer + dedup-only reranker.

Why RRF?
    Weighted-sum hybrid scoring (e.g. 0.6*vector + 0.3*keyword + 0.1*recency)
    requires the underlying scores to live on the same scale or to be
    normalised. Cosine similarity, BM25, and exponential recency decay all
    have different distributions, so the chosen weights are fragile.
    RRF fuses ranked lists without looking at score magnitudes — the only
    input is each item's rank in each list — so it's robust to distribution
    shift across signals.

    Reference: Cormack et al., "Reciprocal Rank Fusion outperforms Condorcet
    and individual Rank Learning Methods", SIGIR 2009.

Why MMR?
    Top-k retrieval often returns near-duplicate chunks from a single file
    or class. The LLM gets the same hit five times and starves on diverse
    context. MMR (Carbonell & Goldstein, 1998) iteratively picks the
    candidate that maximises:
        score(c) - λ * max_sim(c, already_selected)
    so each new pick is balanced between relevance and novelty.
"""

from __future__ import annotations

from typing import Callable, Dict, Hashable, List, Sequence, TypeVar

import numpy as np

T = TypeVar("T")


# ---------------------------------------------------------------------------
# Reciprocal Rank Fusion
# ---------------------------------------------------------------------------

def reciprocal_rank_fusion(
    ranked_lists: Sequence[Sequence[Hashable]],
    *,
    k: int = 60,
    weights: Sequence[float] | None = None,
) -> List[tuple]:
    """Fuse multiple ranked lists into a single ranking via RRF.

    Args:
        ranked_lists: each inner sequence is a list of item ids in
            descending relevance order. Items missing from a list
            contribute zero from that list.
        k: damping constant from the original paper. 60 is the
            community default; smaller k makes the head of each list
            count proportionally more.
        weights: optional per-list weights. Default: 1.0 each.

    Returns:
        List of (item_id, fused_score) tuples in descending order.
    """
    if weights is None:
        weights = [1.0] * len(ranked_lists)
    elif len(weights) != len(ranked_lists):
        raise ValueError("weights length must match ranked_lists length")

    scores: Dict[Hashable, float] = {}
    for ranked, w in zip(ranked_lists, weights):
        if w <= 0:
            continue
        for rank, item in enumerate(ranked, start=1):
            # RRF formula: 1 / (k + rank). Cumulative across lists.
            scores[item] = scores.get(item, 0.0) + w / (k + rank)
    return sorted(scores.items(), key=lambda kv: -kv[1])


# ---------------------------------------------------------------------------
# Maximal Marginal Relevance
# ---------------------------------------------------------------------------

def mmr(
    candidates: Sequence[T],
    *,
    relevance_fn: Callable[[T], float],
    similarity_fn: Callable[[T, T], float],
    lambda_: float = 0.7,
    top_k: int = 10,
) -> List[T]:
    """Maximal Marginal Relevance reranking.

    Args:
        candidates: items to rerank. Order doesn't matter — relevance_fn
            decides each item's base score.
        relevance_fn: returns a 0..1 relevance score for an item against
            the query (precomputed by the caller).
        similarity_fn: returns a 0..1 similarity between two items;
            used for the diversity penalty.
        lambda_: 1.0 = pure relevance (no diversity), 0.0 = pure
            diversity (no relevance). 0.7 is a common default for code
            search.
        top_k: how many items to return.

    Returns:
        Up to top_k items ordered by MMR score.
    """
    if not candidates:
        return []
    remaining = list(candidates)
    selected: List[T] = []
    relevances = {id(c): relevance_fn(c) for c in remaining}

    while remaining and len(selected) < top_k:
        best_item = None
        best_score = float("-inf")
        for c in remaining:
            relevance = relevances[id(c)]
            if not selected:
                mmr_score = relevance
            else:
                max_sim = max(similarity_fn(c, s) for s in selected)
                mmr_score = lambda_ * relevance - (1 - lambda_) * max_sim
            if mmr_score > best_score:
                best_score = mmr_score
                best_item = c
        if best_item is None:
            break
        selected.append(best_item)
        remaining.remove(best_item)
    return selected


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    """Cosine similarity between two embedding vectors. Returns 0 when
    either side is zero-length.
    """
    if a is None or b is None:
        return 0.0
    if a.size == 0 or b.size == 0:
        return 0.0
    na = float(np.linalg.norm(a))
    nb = float(np.linalg.norm(b))
    if na == 0 or nb == 0:
        return 0.0
    return float(np.dot(a, b) / (na * nb))


def jaccard_similarity(a: set, b: set) -> float:
    """Jaccard similarity between two token sets. Cheap fallback when no
    embeddings are available — used by MMR over symbol token sets.
    """
    if not a or not b:
        return 0.0
    inter = a & b
    union = a | b
    return len(inter) / len(union) if union else 0.0

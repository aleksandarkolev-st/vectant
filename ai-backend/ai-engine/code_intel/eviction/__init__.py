"""
Context Eviction Module - Manage context stability across conversation turns.

Problems addressed:
- Context changes unexpectedly between turns
- AI mentions code that's no longer visible
- Token budget overflow as conversation grows
- Lost context from earlier in conversation

Solutions:
- Explicit context pinning
- Recency-based eviction
- Importance scoring
- Context versioning
"""

from .context_tracker import ContextTracker, ContextState
from .eviction_policy import EvictionPolicy, LRUEviction, ImportanceEviction
from .context_pinner import ContextPinner, PinReason
from .context_diff import ContextDiff, diff_contexts


__all__ = [
    "ContextTracker",
    "ContextState",
    "EvictionPolicy",
    "LRUEviction",
    "ImportanceEviction",
    "ContextPinner",
    "PinReason",
    "ContextDiff",
    "diff_contexts",
]

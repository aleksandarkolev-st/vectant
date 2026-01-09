"""
Context Eviction Module - Manage context stability across conversation turns.

Problems addressed:
- Context changes unexpectedly between turns
- AI mentions code that's no longer visible
- Token budget overflow as conversation grows
- Lost context from earlier in conversation
- Index drift from file modifications

Solutions:
- Explicit context pinning
- Recency-based eviction
- Importance scoring
- Context versioning
- Drift detection and auto-resolution
"""

from .context_tracker import ContextTracker, ContextState
from .eviction_policy import EvictionPolicy, LRUEviction, ImportanceEviction
from .context_pinner import ContextPinner, PinReason
from .context_diff import ContextDiff, diff_contexts, ContextStabilizer
from .drift_detector import (
    DriftDetector,
    DriftReport,
    DriftType,
    DriftSeverity,
    AutoDriftResolver,
    check_drift,
)


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
    "ContextStabilizer",
    # Drift Detection
    "DriftDetector",
    "DriftReport",
    "DriftType",
    "DriftSeverity",
    "AutoDriftResolver",
    "check_drift",
]

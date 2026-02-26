"""
Self-Healing Engine

Automatic detection and correction of small, safe code issues.
Only corrects micro-issues (missing colons, unused imports, missing imports, etc.)
and never touches larger structural code that is the user's responsibility.
"""

from .types import (
    HealingCategory,
    HealingSeverity,
    HealingAction,
    HealingFix,
    HealingResult,
    HealingConfig,
    HealingEvent,
    HealingStats,
)
from .classifier import HealingClassifier
from .engine import SelfHealingEngine
from .rule_registry import HealingRuleRegistry

__all__ = [
    "HealingCategory",
    "HealingSeverity",
    "HealingAction",
    "HealingFix",
    "HealingResult",
    "HealingConfig",
    "HealingEvent",
    "HealingStats",
    "HealingClassifier",
    "SelfHealingEngine",
    "HealingRuleRegistry",
]

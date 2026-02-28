"""
Healing system configuration schema and defaults.

Provides a centralised place for all configurable parameters
and their validation.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, Any, Set

from .types import HealingCategory


# ── Default category enablement ───────────────────────────────────────

DEFAULT_AUTO_HEAL_CATEGORIES: Set[HealingCategory] = {
    HealingCategory.TRAILING_WHITESPACE,
    HealingCategory.MISSING_SEMICOLON,
    HealingCategory.UNUSED_IMPORT,
    HealingCategory.UNUSED_VARIABLE,
    HealingCategory.UNDECLARED_VARIABLE,
    HealingCategory.MISMATCHED_BRACKET,
}


# ── Configuration presets ─────────────────────────────────────────────

PRESETS: Dict[str, Dict[str, Any]] = {
    "conservative": {
        "description": "Only the safest, most obvious fixes",
        "min_confidence": 0.95,
        "max_fixes_per_pass": 3,
        "cooldown_ms": 5000,
        "auto_heal_categories": {
            HealingCategory.TRAILING_WHITESPACE,
            HealingCategory.MISSING_SEMICOLON,
        },
    },
    "balanced": {
        "description": "Good balance of safety and coverage (default)",
        "min_confidence": 0.90,
        "max_fixes_per_pass": 5,
        "cooldown_ms": 2000,
        "auto_heal_categories": DEFAULT_AUTO_HEAL_CATEGORIES,
    },
    "aggressive": {
        "description": "Maximum coverage — more auto-fixes, lower threshold",
        "min_confidence": 0.80,
        "max_fixes_per_pass": 10,
        "cooldown_ms": 1000,
        "auto_heal_categories": set(HealingCategory),
    },
}


def get_preset(name: str) -> Dict[str, Any]:
    """Get a configuration preset by name."""
    preset = PRESETS.get(name)
    if preset is None:
        raise ValueError(
            f"Unknown preset '{name}'. Available: {list(PRESETS.keys())}"
        )
    return preset


def list_presets() -> Dict[str, str]:
    """List available presets with descriptions."""
    return {name: p["description"] for name, p in PRESETS.items()}


# ── Validation ────────────────────────────────────────────────────────

def validate_config(config_dict: Dict[str, Any]) -> list[str]:
    """
    Validate a configuration dictionary.
    Returns list of error messages (empty = valid).
    """
    errors = []

    if "min_confidence" in config_dict:
        v = config_dict["min_confidence"]
        if not isinstance(v, (int, float)) or not (0 <= v <= 1):
            errors.append("min_confidence must be between 0.0 and 1.0")

    if "max_fixes_per_pass" in config_dict:
        v = config_dict["max_fixes_per_pass"]
        if not isinstance(v, int) or v < 1:
            errors.append("max_fixes_per_pass must be a positive integer")

    if "cooldown_ms" in config_dict:
        v = config_dict["cooldown_ms"]
        if not isinstance(v, (int, float)) or v < 0:
            errors.append("cooldown_ms must be non-negative")

    return errors

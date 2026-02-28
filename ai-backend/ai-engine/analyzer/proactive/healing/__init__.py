"""
Self-Healing Engine

Automatic detection and correction of code issues via two modes:

1. **Regex mode** (fast): Heuristic rules for obvious syntax issues
2. **AI mode** (agentic): LLM-powered detection for real bugs —
   logic errors, null safety, missing awaits, off-by-one, etc.
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
from .ai_agent import AIHealingAgent, AIAgentConfig
from .ai_memory import AIAgentMemory, get_agent_memory
from .ai_deps import DependencyGraph, get_dependency_graph

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
    "AIHealingAgent",
    "AIAgentConfig",
    "AIAgentMemory",
    "get_agent_memory",
    "DependencyGraph",
    "get_dependency_graph",
]

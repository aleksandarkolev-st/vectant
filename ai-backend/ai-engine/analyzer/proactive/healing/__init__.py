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
from .ai_prompt_cache import AIPromptCache, get_prompt_cache
from .ai_policy import AISuppressionPolicy, get_suppression_policy

# ── Agentic self-healing modules ──────────────────────────────────────
from .repair_episode import RepairEpisode, EpisodeState, EpisodeStore, get_episode_store
from .redaction import RedactionEngine, get_redaction_engine, redact_before_llm
from .verification import VerificationPipeline, SemanticGuardrails, get_verification_pipeline, get_semantic_guardrails
from .rollback import RepairTransaction, TransactionManager, get_transaction_manager
from .precision_telemetry import PrecisionTelemetry, get_precision_telemetry
from .diagnosis import DiagnosisAgent, CauseGraph, ErrorParser, get_diagnosis_agent
from .planner import RepairPlanner, PlanExecutor, ToolExecutor, get_planner, get_tool_executor
from .sandbox import Sandbox, SandboxManager, get_sandbox_manager
from .multi_file import MultiFileCoordinator, ChangeImpactAnalyzer, get_multi_file_coordinator, get_impact_analyzer
from .runtime_healing import RuntimeHealingEngine, StackTraceParser, get_runtime_healing_engine
from .observability import ObservabilityHub, get_observability_hub
from .policy import PolicyEngine, RiskClassifier, get_policy_engine
from .canary import CanaryRolloutEngine, get_canary_engine

__all__ = [
    # Core types
    "HealingCategory",
    "HealingSeverity",
    "HealingAction",
    "HealingFix",
    "HealingResult",
    "HealingConfig",
    "HealingEvent",
    "HealingStats",
    # Core engine
    "HealingClassifier",
    "SelfHealingEngine",
    "HealingRuleRegistry",
    # AI agent
    "AIHealingAgent",
    "AIAgentConfig",
    "AIAgentMemory",
    "get_agent_memory",
    "DependencyGraph",
    "get_dependency_graph",
    "AIPromptCache",
    "get_prompt_cache",
    "AISuppressionPolicy",
    "get_suppression_policy",
    # Agentic self-healing: Phase 1
    "RepairEpisode",
    "EpisodeState",
    "EpisodeStore",
    "get_episode_store",
    "RedactionEngine",
    "get_redaction_engine",
    "redact_before_llm",
    "VerificationPipeline",
    "SemanticGuardrails",
    "get_verification_pipeline",
    "get_semantic_guardrails",
    "RepairTransaction",
    "TransactionManager",
    "get_transaction_manager",
    "PrecisionTelemetry",
    "get_precision_telemetry",
    # Agentic self-healing: Phase 2
    "DiagnosisAgent",
    "CauseGraph",
    "ErrorParser",
    "get_diagnosis_agent",
    "RepairPlanner",
    "PlanExecutor",
    "ToolExecutor",
    "get_planner",
    "get_tool_executor",
    "Sandbox",
    "SandboxManager",
    "get_sandbox_manager",
    "MultiFileCoordinator",
    "ChangeImpactAnalyzer",
    "get_multi_file_coordinator",
    "get_impact_analyzer",
    # Agentic self-healing: Phase 3
    "RuntimeHealingEngine",
    "StackTraceParser",
    "get_runtime_healing_engine",
    "ObservabilityHub",
    "get_observability_hub",
    "PolicyEngine",
    "RiskClassifier",
    "get_policy_engine",
    "CanaryRolloutEngine",
    "get_canary_engine",
]

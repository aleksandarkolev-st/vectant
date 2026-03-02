"""
Repair Planner & Tool Orchestration.

Multi-step repair planner that:
- Takes a CauseGraph from diagnosis
- Generates a sequenced repair plan (Plan A / B / C)
- Orchestrates structured tool use (read, search, compile, test, patch)
- Enforces step budgets and stop conditions
- Tracks plan progress through execution

The planner decides WHAT to do; the executor calls tools to DO it.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Dict, List, Optional, Set

logger = logging.getLogger("healing.planner")


# ── Plan/Step types ───────────────────────────────────────────────────

class StepType(str, Enum):
    """Types of repair steps the planner can schedule."""
    READ_FILE = "read_file"
    SEARCH_SYMBOLS = "search_symbols"
    RUN_COMPILE = "run_compile"
    RUN_LINT = "run_lint"
    RUN_TYPECHECK = "run_typecheck"
    RUN_TESTS = "run_tests"
    APPLY_PATCH = "apply_patch"
    ROLLBACK_PATCH = "rollback_patch"
    ADD_IMPORT = "add_import"
    REMOVE_IMPORT = "remove_import"
    INSTALL_DEPENDENCY = "install_dependency"
    REGENERATE_TYPES = "regenerate_types"
    CLEAR_CACHE = "clear_cache"
    RESTART_SERVICE = "restart_service"
    ASK_LLM = "ask_llm"
    VERIFY = "verify"
    ESCALATE = "escalate"


class StepStatus(str, Enum):
    """Status of a plan step."""
    PENDING = "pending"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    SKIPPED = "skipped"


class PlanStatus(str, Enum):
    """Status of a repair plan."""
    CREATED = "created"
    EXECUTING = "executing"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    EXHAUSTED = "exhausted"  # all strategies tried


class StrategyType(str, Enum):
    """Types of repair strategies."""
    REGEX_FIX = "regex_fix"          # Fast, rule-based fix
    TARGETED_PATCH = "targeted_patch"  # Specific code change
    LLM_REWRITE = "llm_rewrite"       # AI-generated fix
    DEPENDENCY_FIX = "dependency_fix"  # Install/update dependency
    CONFIG_FIX = "config_fix"          # Configuration change
    FULL_REGENERATE = "full_regenerate" # Regenerate file/types
    MANUAL_ESCALATION = "manual_escalation"  # Give up, ask human


# ── Data structures ───────────────────────────────────────────────────

@dataclass
class StepBudget:
    """Limits on what a repair plan can do."""
    max_steps: int = 15
    max_llm_calls: int = 5
    max_file_reads: int = 10
    max_patches: int = 3
    max_duration_sec: float = 120.0
    max_retries_per_step: int = 2

    def to_dict(self) -> Dict[str, Any]:
        return {
            "maxSteps": self.max_steps,
            "maxLlmCalls": self.max_llm_calls,
            "maxFileReads": self.max_file_reads,
            "maxPatches": self.max_patches,
            "maxDurationSec": self.max_duration_sec,
            "maxRetriesPerStep": self.max_retries_per_step,
        }


@dataclass
class RepairStep:
    """A single step in a repair plan."""
    id: int
    step_type: StepType
    description: str
    args: Dict[str, Any] = field(default_factory=dict)
    depends_on: List[int] = field(default_factory=list)
    status: StepStatus = StepStatus.PENDING
    result: Optional[Dict[str, Any]] = None
    error: str = ""
    retries: int = 0
    started_at: float = 0.0
    finished_at: float = 0.0
    on_failure: str = "continue"  # "continue", "abort", "skip_rest"

    @property
    def duration_ms(self) -> float:
        if self.started_at and self.finished_at:
            return (self.finished_at - self.started_at) * 1000
        return 0.0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "stepType": self.step_type.value,
            "description": self.description,
            "args": self.args,
            "dependsOn": self.depends_on,
            "status": self.status.value,
            "result": self.result,
            "error": self.error,
            "retries": self.retries,
            "durationMs": round(self.duration_ms, 1),
            "onFailure": self.on_failure,
        }


@dataclass
class RepairStrategy:
    """A complete strategy (sequence of steps) for fixing an issue."""
    name: str
    strategy_type: StrategyType
    steps: List[RepairStep] = field(default_factory=list)
    priority: int = 0  # lower = tried first
    estimated_confidence: float = 0.5
    requirements: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "strategyType": self.strategy_type.value,
            "steps": [s.to_dict() for s in self.steps],
            "priority": self.priority,
            "estimatedConfidence": round(self.estimated_confidence, 3),
            "requirements": self.requirements,
        }


@dataclass
class RepairPlan:
    """
    A ranked list of strategies for fixing an issue.
    Tries strategies in order until one succeeds or all fail.
    """
    issue_id: str
    strategies: List[RepairStrategy] = field(default_factory=list)
    budget: StepBudget = field(default_factory=StepBudget)
    status: PlanStatus = PlanStatus.CREATED
    current_strategy_idx: int = 0
    current_step_idx: int = 0
    total_steps_executed: int = 0
    total_llm_calls: int = 0
    total_file_reads: int = 0
    total_patches: int = 0
    started_at: float = 0.0
    finished_at: float = 0.0
    metadata: Dict[str, Any] = field(default_factory=dict)

    @property
    def current_strategy(self) -> Optional[RepairStrategy]:
        if 0 <= self.current_strategy_idx < len(self.strategies):
            return self.strategies[self.current_strategy_idx]
        return None

    @property
    def duration_sec(self) -> float:
        if self.started_at:
            end = self.finished_at or time.time()
            return end - self.started_at
        return 0.0

    @property
    def budget_exceeded(self) -> bool:
        if self.total_steps_executed >= self.budget.max_steps:
            return True
        if self.total_llm_calls >= self.budget.max_llm_calls:
            return True
        if self.total_patches >= self.budget.max_patches:
            return True
        if self.duration_sec >= self.budget.max_duration_sec:
            return True
        return False

    def to_dict(self) -> Dict[str, Any]:
        return {
            "issueId": self.issue_id,
            "strategies": [s.to_dict() for s in self.strategies],
            "budget": self.budget.to_dict(),
            "status": self.status.value,
            "currentStrategyIdx": self.current_strategy_idx,
            "currentStepIdx": self.current_step_idx,
            "totalStepsExecuted": self.total_steps_executed,
            "totalLlmCalls": self.total_llm_calls,
            "totalFileReads": self.total_file_reads,
            "totalPatches": self.total_patches,
            "durationSec": round(self.duration_sec, 2),
            "budgetExceeded": self.budget_exceeded,
        }


# ── Stop conditions ───────────────────────────────────────────────────

class StopCondition:
    """Evaluates whether a plan should stop executing."""

    def __init__(self, budget: StepBudget):
        self._budget = budget

    def should_stop(self, plan: RepairPlan) -> Optional[str]:
        """Returns reason string if should stop, None otherwise."""
        if plan.total_steps_executed >= self._budget.max_steps:
            return f"step budget exhausted ({plan.total_steps_executed}/{self._budget.max_steps})"
        if plan.total_llm_calls >= self._budget.max_llm_calls:
            return f"LLM call budget exhausted ({plan.total_llm_calls}/{self._budget.max_llm_calls})"
        if plan.total_patches >= self._budget.max_patches:
            return f"patch budget exhausted ({plan.total_patches}/{self._budget.max_patches})"
        if plan.duration_sec >= self._budget.max_duration_sec:
            return f"time budget exhausted ({plan.duration_sec:.0f}s/{self._budget.max_duration_sec}s)"
        return None


# ── Planner ───────────────────────────────────────────────────────────

class RepairPlanner:
    """
    Generates repair plans from a cause graph.

    The planner selects strategies based on:
    - Cause type
    - Confidence of diagnosis
    - Available tools
    - Historical success rates
    - Budget constraints
    """

    def __init__(
        self,
        default_budget: Optional[StepBudget] = None,
        confidence_fn: Optional[Callable] = None,
    ):
        self._default_budget = default_budget or StepBudget()
        # Optional: (rule_id, cause_type) -> calibrated confidence
        self._confidence_fn = confidence_fn

    def plan(
        self,
        cause_graph: Any,  # CauseGraph from diagnosis module
        language: str = "",
        budget: Optional[StepBudget] = None,
    ) -> RepairPlan:
        """
        Generate a repair plan from a diagnosis cause graph.

        Returns a plan with ranked strategies (Plan A, B, C, ...).
        """
        from .diagnosis import CauseType

        plan_budget = budget or self._default_budget
        primary = cause_graph.primary_cause

        issue_id = f"plan_{int(time.time() * 1000)}"

        plan = RepairPlan(
            issue_id=issue_id,
            budget=plan_budget,
        )

        if not primary:
            # No diagnosis → single LLM strategy
            plan.strategies.append(self._llm_strategy(cause_graph))
            return plan

        # Generate strategies based on cause type
        strategies = self._strategies_for_cause(primary, cause_graph, language)

        # Always include LLM fallback if not already present
        has_llm = any(s.strategy_type == StrategyType.LLM_REWRITE for s in strategies)
        if not has_llm:
            strategies.append(self._llm_strategy(cause_graph))

        # Always end with manual escalation
        strategies.append(RepairStrategy(
            name="Escalate to developer",
            strategy_type=StrategyType.MANUAL_ESCALATION,
            steps=[RepairStep(
                id=1,
                step_type=StepType.ESCALATE,
                description="All automated strategies failed. Escalate to developer.",
                on_failure="abort",
            )],
            priority=100,
            estimated_confidence=0.0,
        ))

        # Sort by priority (lower first) then confidence (higher first)
        strategies.sort(key=lambda s: (s.priority, -s.estimated_confidence))

        plan.strategies = strategies
        return plan

    def _strategies_for_cause(
        self,
        cause: Any,  # CauseCandidate
        graph: Any,   # CauseGraph
        language: str,
    ) -> List[RepairStrategy]:
        """Generate strategies based on cause type."""
        from .diagnosis import CauseType

        strategies = []
        ct = cause.cause_type

        if ct == CauseType.SYNTAX_ERROR:
            strategies.append(self._syntax_fix_strategy(cause, language))

        elif ct == CauseType.MISSING_IMPORT:
            strategies.append(self._add_import_strategy(cause, language))

        elif ct == CauseType.WRONG_IMPORT_PATH:
            strategies.append(self._fix_import_path_strategy(cause))

        elif ct == CauseType.UNDEFINED_VARIABLE:
            strategies.append(self._undefined_var_strategy(cause, language))

        elif ct == CauseType.TYPE_MISMATCH:
            strategies.append(self._type_fix_strategy(cause, language))

        elif ct == CauseType.MISSING_DEPENDENCY:
            strategies.append(self._install_dep_strategy(cause, language))

        elif ct == CauseType.MERGE_CONFLICT_RESIDUE:
            strategies.append(self._merge_conflict_strategy(cause))

        elif ct == CauseType.MISSING_AWAIT:
            strategies.append(self._missing_await_strategy(cause))

        elif ct == CauseType.NULL_REFERENCE:
            strategies.append(self._null_guard_strategy(cause, language))

        elif ct == CauseType.CONFIG_ERROR:
            strategies.append(self._config_fix_strategy(cause))

        elif ct == CauseType.CIRCULAR_DEPENDENCY:
            strategies.append(self._circular_dep_strategy(cause))

        elif ct == CauseType.VERSION_MISMATCH:
            strategies.append(self._version_fix_strategy(cause, language))

        elif ct == CauseType.STALE_CACHE:
            strategies.append(RepairStrategy(
                name="Clear cache",
                strategy_type=StrategyType.CONFIG_FIX,
                steps=[
                    RepairStep(
                        id=1,
                        step_type=StepType.CLEAR_CACHE,
                        description="Clear build/module cache",
                        on_failure="continue",
                    ),
                    RepairStep(
                        id=2,
                        step_type=StepType.RUN_COMPILE,
                        description="Rebuild after cache clear",
                        depends_on=[1],
                        on_failure="abort",
                    ),
                ],
                priority=0,
                estimated_confidence=0.8,
            ))

        return strategies

    def _syntax_fix_strategy(self, cause, language: str) -> RepairStrategy:
        return RepairStrategy(
            name="Fix syntax error",
            strategy_type=StrategyType.TARGETED_PATCH,
            steps=[
                RepairStep(
                    id=1,
                    step_type=StepType.READ_FILE,
                    description=f"Read {cause.file_path} around line {cause.line}",
                    args={"file": cause.file_path, "line": cause.line, "context": 10},
                ),
                RepairStep(
                    id=2,
                    step_type=StepType.ASK_LLM,
                    description="Ask LLM to fix syntax error",
                    args={"task": "fix_syntax"},
                    depends_on=[1],
                ),
                RepairStep(
                    id=3,
                    step_type=StepType.APPLY_PATCH,
                    description="Apply syntax fix",
                    depends_on=[2],
                    on_failure="abort",
                ),
                RepairStep(
                    id=4,
                    step_type=StepType.VERIFY,
                    description="Verify syntax fix compiles",
                    depends_on=[3],
                    on_failure="abort",
                ),
            ],
            priority=0,
            estimated_confidence=cause.confidence * 0.8,
        )

    def _add_import_strategy(self, cause, language: str) -> RepairStrategy:
        return RepairStrategy(
            name="Add missing import",
            strategy_type=StrategyType.TARGETED_PATCH,
            steps=[
                RepairStep(
                    id=1,
                    step_type=StepType.SEARCH_SYMBOLS,
                    description="Search for symbol definition",
                    args={"symbol": cause.evidence[0] if cause.evidence else ""},
                ),
                RepairStep(
                    id=2,
                    step_type=StepType.ADD_IMPORT,
                    description="Add import statement",
                    depends_on=[1],
                    on_failure="abort",
                ),
                RepairStep(
                    id=3,
                    step_type=StepType.VERIFY,
                    description="Verify import resolves",
                    depends_on=[2],
                    on_failure="abort",
                ),
            ],
            priority=0,
            estimated_confidence=cause.confidence * 0.85,
        )

    def _fix_import_path_strategy(self, cause) -> RepairStrategy:
        return RepairStrategy(
            name="Fix import path",
            strategy_type=StrategyType.TARGETED_PATCH,
            steps=[
                RepairStep(
                    id=1,
                    step_type=StepType.SEARCH_SYMBOLS,
                    description="Search for correct module path",
                    args={"symbol": cause.evidence[0] if cause.evidence else ""},
                ),
                RepairStep(
                    id=2,
                    step_type=StepType.APPLY_PATCH,
                    description="Update import path",
                    depends_on=[1],
                    on_failure="abort",
                ),
                RepairStep(
                    id=3,
                    step_type=StepType.VERIFY,
                    description="Verify import resolves",
                    depends_on=[2],
                    on_failure="abort",
                ),
            ],
            priority=0,
            estimated_confidence=cause.confidence * 0.8,
        )

    def _undefined_var_strategy(self, cause, language: str) -> RepairStrategy:
        return RepairStrategy(
            name="Fix undefined variable",
            strategy_type=StrategyType.TARGETED_PATCH,
            steps=[
                RepairStep(
                    id=1,
                    step_type=StepType.READ_FILE,
                    description=f"Read {cause.file_path} for context",
                    args={"file": cause.file_path, "line": cause.line, "context": 20},
                ),
                RepairStep(
                    id=2,
                    step_type=StepType.SEARCH_SYMBOLS,
                    description="Search for symbol across project",
                    args={"symbol": cause.evidence[0] if cause.evidence else ""},
                    depends_on=[1],
                ),
                RepairStep(
                    id=3,
                    step_type=StepType.ASK_LLM,
                    description="Determine if import or declaration is needed",
                    depends_on=[1, 2],
                ),
                RepairStep(
                    id=4,
                    step_type=StepType.APPLY_PATCH,
                    description="Apply fix",
                    depends_on=[3],
                    on_failure="abort",
                ),
                RepairStep(
                    id=5,
                    step_type=StepType.VERIFY,
                    description="Verify fix",
                    depends_on=[4],
                    on_failure="abort",
                ),
            ],
            priority=1,
            estimated_confidence=cause.confidence * 0.7,
        )

    def _type_fix_strategy(self, cause, language: str) -> RepairStrategy:
        return RepairStrategy(
            name="Fix type mismatch",
            strategy_type=StrategyType.TARGETED_PATCH,
            steps=[
                RepairStep(
                    id=1,
                    step_type=StepType.READ_FILE,
                    description=f"Read {cause.file_path}",
                    args={"file": cause.file_path, "line": cause.line, "context": 15},
                ),
                RepairStep(
                    id=2,
                    step_type=StepType.ASK_LLM,
                    description="Ask LLM to fix type error",
                    args={"task": "fix_type"},
                    depends_on=[1],
                ),
                RepairStep(
                    id=3,
                    step_type=StepType.APPLY_PATCH,
                    description="Apply type fix",
                    depends_on=[2],
                    on_failure="abort",
                ),
                RepairStep(
                    id=4,
                    step_type=StepType.RUN_TYPECHECK,
                    description="Run type checker",
                    depends_on=[3],
                    on_failure="abort",
                ),
            ],
            priority=1,
            estimated_confidence=cause.confidence * 0.65,
        )

    def _install_dep_strategy(self, cause, language: str) -> RepairStrategy:
        return RepairStrategy(
            name="Install missing dependency",
            strategy_type=StrategyType.DEPENDENCY_FIX,
            steps=[
                RepairStep(
                    id=1,
                    step_type=StepType.INSTALL_DEPENDENCY,
                    description="Install missing package",
                    args={"package": cause.evidence[0] if cause.evidence else ""},
                    on_failure="abort",
                ),
                RepairStep(
                    id=2,
                    step_type=StepType.RUN_COMPILE,
                    description="Rebuild after dependency install",
                    depends_on=[1],
                    on_failure="abort",
                ),
            ],
            priority=0,
            estimated_confidence=0.85,
        )

    def _merge_conflict_strategy(self, cause) -> RepairStrategy:
        return RepairStrategy(
            name="Clean merge conflict markers",
            strategy_type=StrategyType.REGEX_FIX,
            steps=[
                RepairStep(
                    id=1,
                    step_type=StepType.READ_FILE,
                    description=f"Read {cause.file_path} to find conflict markers",
                    args={"file": cause.file_path},
                ),
                RepairStep(
                    id=2,
                    step_type=StepType.ASK_LLM,
                    description="Resolve merge conflict",
                    depends_on=[1],
                ),
                RepairStep(
                    id=3,
                    step_type=StepType.APPLY_PATCH,
                    description="Apply resolved content",
                    depends_on=[2],
                    on_failure="abort",
                ),
                RepairStep(
                    id=4,
                    step_type=StepType.VERIFY,
                    description="Verify conflict resolved cleanly",
                    depends_on=[3],
                    on_failure="abort",
                ),
            ],
            priority=0,
            estimated_confidence=0.9,
        )

    def _missing_await_strategy(self, cause) -> RepairStrategy:
        return RepairStrategy(
            name="Add missing await",
            strategy_type=StrategyType.TARGETED_PATCH,
            steps=[
                RepairStep(
                    id=1,
                    step_type=StepType.READ_FILE,
                    description=f"Read {cause.file_path}",
                    args={"file": cause.file_path, "line": cause.line, "context": 10},
                ),
                RepairStep(
                    id=2,
                    step_type=StepType.APPLY_PATCH,
                    description="Add await keyword",
                    depends_on=[1],
                    on_failure="abort",
                ),
                RepairStep(
                    id=3,
                    step_type=StepType.RUN_TYPECHECK,
                    description="Run type checker",
                    depends_on=[2],
                    on_failure="abort",
                ),
            ],
            priority=0,
            estimated_confidence=cause.confidence * 0.85,
        )

    def _null_guard_strategy(self, cause, language: str) -> RepairStrategy:
        return RepairStrategy(
            name="Add null guard",
            strategy_type=StrategyType.TARGETED_PATCH,
            steps=[
                RepairStep(
                    id=1,
                    step_type=StepType.READ_FILE,
                    description=f"Read {cause.file_path}",
                    args={"file": cause.file_path, "line": cause.line, "context": 15},
                ),
                RepairStep(
                    id=2,
                    step_type=StepType.ASK_LLM,
                    description="Generate null guard / optional chaining",
                    args={"task": "null_guard"},
                    depends_on=[1],
                ),
                RepairStep(
                    id=3,
                    step_type=StepType.APPLY_PATCH,
                    description="Apply null safety fix",
                    depends_on=[2],
                    on_failure="abort",
                ),
                RepairStep(
                    id=4,
                    step_type=StepType.VERIFY,
                    description="Verify null safety",
                    depends_on=[3],
                    on_failure="abort",
                ),
            ],
            priority=1,
            estimated_confidence=cause.confidence * 0.7,
        )

    def _config_fix_strategy(self, cause) -> RepairStrategy:
        return RepairStrategy(
            name="Fix configuration",
            strategy_type=StrategyType.CONFIG_FIX,
            steps=[
                RepairStep(
                    id=1,
                    step_type=StepType.READ_FILE,
                    description=f"Read config file {cause.file_path}",
                    args={"file": cause.file_path},
                ),
                RepairStep(
                    id=2,
                    step_type=StepType.ASK_LLM,
                    description="Determine configuration fix",
                    depends_on=[1],
                ),
                RepairStep(
                    id=3,
                    step_type=StepType.APPLY_PATCH,
                    description="Apply configuration change",
                    depends_on=[2],
                    on_failure="abort",
                ),
                RepairStep(
                    id=4,
                    step_type=StepType.VERIFY,
                    description="Verify configuration",
                    depends_on=[3],
                    on_failure="abort",
                ),
            ],
            priority=1,
            estimated_confidence=cause.confidence * 0.6,
        )

    def _circular_dep_strategy(self, cause) -> RepairStrategy:
        return RepairStrategy(
            name="Break circular dependency",
            strategy_type=StrategyType.TARGETED_PATCH,
            steps=[
                RepairStep(
                    id=1,
                    step_type=StepType.SEARCH_SYMBOLS,
                    description="Map import cycle",
                    args={"file": cause.file_path},
                ),
                RepairStep(
                    id=2,
                    step_type=StepType.ASK_LLM,
                    description="Determine how to break cycle (lazy import, extract module)",
                    depends_on=[1],
                ),
                RepairStep(
                    id=3,
                    step_type=StepType.APPLY_PATCH,
                    description="Apply cycle-breaking fix",
                    depends_on=[2],
                    on_failure="abort",
                ),
                RepairStep(
                    id=4,
                    step_type=StepType.RUN_COMPILE,
                    description="Verify no circular import",
                    depends_on=[3],
                    on_failure="abort",
                ),
            ],
            priority=2,
            estimated_confidence=cause.confidence * 0.5,
        )

    def _version_fix_strategy(self, cause, language: str) -> RepairStrategy:
        return RepairStrategy(
            name="Fix version mismatch",
            strategy_type=StrategyType.DEPENDENCY_FIX,
            steps=[
                RepairStep(
                    id=1,
                    step_type=StepType.SEARCH_SYMBOLS,
                    description="Check installed vs required versions",
                ),
                RepairStep(
                    id=2,
                    step_type=StepType.INSTALL_DEPENDENCY,
                    description="Update to compatible version",
                    depends_on=[1],
                    on_failure="abort",
                ),
                RepairStep(
                    id=3,
                    step_type=StepType.RUN_COMPILE,
                    description="Rebuild",
                    depends_on=[2],
                    on_failure="abort",
                ),
            ],
            priority=1,
            estimated_confidence=0.70,
        )

    def _llm_strategy(self, graph: Any) -> RepairStrategy:
        """Fallback LLM rewrite strategy."""
        return RepairStrategy(
            name="LLM-assisted rewrite",
            strategy_type=StrategyType.LLM_REWRITE,
            steps=[
                RepairStep(
                    id=1,
                    step_type=StepType.READ_FILE,
                    description="Read affected file(s)",
                    args={"files": list(graph.affected_files)[:5]},
                ),
                RepairStep(
                    id=2,
                    step_type=StepType.ASK_LLM,
                    description="Ask LLM for comprehensive fix",
                    depends_on=[1],
                ),
                RepairStep(
                    id=3,
                    step_type=StepType.APPLY_PATCH,
                    description="Apply LLM-generated patch",
                    depends_on=[2],
                    on_failure="abort",
                ),
                RepairStep(
                    id=4,
                    step_type=StepType.VERIFY,
                    description="Full verification",
                    depends_on=[3],
                    on_failure="abort",
                ),
            ],
            priority=50,
            estimated_confidence=0.45,
        )


# ── Plan Executor ─────────────────────────────────────────────────────

class ToolExecutor:
    """
    Registry of tool handlers for plan step execution.

    Each step type maps to a callable that performs the action.
    Tools are injected from the outside (engine, file system, LLM client, etc.).
    """

    def __init__(self):
        self._handlers: Dict[StepType, Callable] = {}

    def register(self, step_type: StepType, handler: Callable) -> None:
        """Register a handler for a step type."""
        self._handlers[step_type] = handler

    def has_handler(self, step_type: StepType) -> bool:
        return step_type in self._handlers

    async def execute(
        self,
        step: RepairStep,
        context: Dict[str, Any],
    ) -> Dict[str, Any]:
        """
        Execute a step using the registered handler.

        Args:
            step: The step to execute.
            context: Accumulated context from prior steps.

        Returns:
            Result dict to add to context.

        Raises:
            KeyError: if no handler is registered for the step type.
        """
        handler = self._handlers.get(step.step_type)
        if not handler:
            raise KeyError(f"No handler registered for {step.step_type.value}")
        return await handler(step, context)


class PlanExecutor:
    """
    Executes a RepairPlan, running strategies in order until one succeeds.

    Manages:
    - Step sequencing and dependency resolution
    - Budget tracking
    - Retry logic
    - Strategy failover (Plan A → B → C)
    """

    def __init__(
        self,
        tool_executor: ToolExecutor,
        on_step_complete: Optional[Callable] = None,
        on_strategy_complete: Optional[Callable] = None,
    ):
        self._tools = tool_executor
        self._on_step_complete = on_step_complete
        self._on_strategy_complete = on_strategy_complete

    async def execute(self, plan: RepairPlan) -> RepairPlan:
        """
        Execute a plan, trying strategies in order.
        Mutates and returns the plan with updated statuses.
        """
        plan.started_at = time.time()
        plan.status = PlanStatus.EXECUTING

        stop_cond = StopCondition(plan.budget)

        for idx, strategy in enumerate(plan.strategies):
            plan.current_strategy_idx = idx

            # Check global budget
            reason = stop_cond.should_stop(plan)
            if reason:
                logger.warning(f"Plan stopped: {reason}")
                plan.status = PlanStatus.EXHAUSTED
                plan.finished_at = time.time()
                return plan

            # Skip manual escalation unless it's the last resort
            if strategy.strategy_type == StrategyType.MANUAL_ESCALATION:
                logger.info("All strategies exhausted, escalating.")
                plan.status = PlanStatus.FAILED
                plan.finished_at = time.time()
                return plan

            logger.info(f"Trying strategy [{idx}]: {strategy.name}")

            success = await self._execute_strategy(plan, strategy, stop_cond)

            if self._on_strategy_complete:
                try:
                    self._on_strategy_complete(strategy, success)
                except Exception:
                    pass

            if success:
                plan.status = PlanStatus.SUCCEEDED
                plan.finished_at = time.time()
                return plan

        plan.status = PlanStatus.EXHAUSTED
        plan.finished_at = time.time()
        return plan

    async def _execute_strategy(
        self,
        plan: RepairPlan,
        strategy: RepairStrategy,
        stop_cond: StopCondition,
    ) -> bool:
        """Execute all steps of a strategy. Returns True on success."""
        context: Dict[str, Any] = {
            "plan": plan,
            "strategy": strategy,
        }
        all_succeeded = True

        for step_idx, step in enumerate(strategy.steps):
            plan.current_step_idx = step_idx

            # Check budget
            reason = stop_cond.should_stop(plan)
            if reason:
                logger.warning(f"Budget exceeded during strategy: {reason}")
                return False

            # Check dependencies
            for dep_id in step.depends_on:
                dep_step = next(
                    (s for s in strategy.steps if s.id == dep_id), None
                )
                if dep_step and dep_step.status != StepStatus.SUCCEEDED:
                    step.status = StepStatus.SKIPPED
                    all_succeeded = False
                    if step.on_failure == "abort":
                        return False
                    continue

            # Execute step with retries
            success = await self._execute_step(step, context, plan)

            # Track budget usage
            plan.total_steps_executed += 1
            if step.step_type == StepType.ASK_LLM:
                plan.total_llm_calls += 1
            elif step.step_type == StepType.READ_FILE:
                plan.total_file_reads += 1
            elif step.step_type == StepType.APPLY_PATCH:
                plan.total_patches += 1

            if self._on_step_complete:
                try:
                    self._on_step_complete(step, success)
                except Exception:
                    pass

            if not success:
                all_succeeded = False
                if step.on_failure == "abort":
                    return False
                elif step.on_failure == "skip_rest":
                    break

        return all_succeeded

    async def _execute_step(
        self,
        step: RepairStep,
        context: Dict[str, Any],
        plan: RepairPlan,
    ) -> bool:
        """Execute a single step with retry logic."""
        max_retries = plan.budget.max_retries_per_step

        for attempt in range(max_retries + 1):
            step.status = StepStatus.RUNNING
            step.started_at = time.time()
            step.retries = attempt

            try:
                if not self._tools.has_handler(step.step_type):
                    logger.warning(f"No handler for {step.step_type.value}, skipping")
                    step.status = StepStatus.SKIPPED
                    step.finished_at = time.time()
                    return False

                result = await self._tools.execute(step, context)
                step.result = result
                step.status = StepStatus.SUCCEEDED
                step.finished_at = time.time()

                # Add result to context for downstream steps
                context[f"step_{step.id}"] = result
                return True

            except Exception as e:
                step.error = str(e)[:500]
                logger.warning(
                    f"Step {step.id} ({step.step_type.value}) failed "
                    f"(attempt {attempt + 1}/{max_retries + 1}): {e}"
                )

                if attempt >= max_retries:
                    step.status = StepStatus.FAILED
                    step.finished_at = time.time()
                    return False

        step.status = StepStatus.FAILED
        step.finished_at = time.time()
        return False


# ── Module-level singletons ──────────────────────────────────────────

_planner: Optional[RepairPlanner] = None
_tool_executor: Optional[ToolExecutor] = None


def get_planner(**kwargs) -> RepairPlanner:
    """Get or create the global planner."""
    global _planner
    if _planner is None:
        _planner = RepairPlanner(**kwargs)
    return _planner


def get_tool_executor() -> ToolExecutor:
    """Get or create the global tool executor."""
    global _tool_executor
    if _tool_executor is None:
        _tool_executor = ToolExecutor()
    return _tool_executor


def reset_planner() -> None:
    """Reset singletons (for testing)."""
    global _planner, _tool_executor
    _planner = None
    _tool_executor = None

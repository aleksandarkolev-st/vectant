"""
Repair Episode State Machine.

Models a complete repair episode with explicit states:
    DETECTED → DIAGNOSING → PLANNING → EXECUTING → VERIFYING
      → SUCCEEDED / ROLLED_BACK / ESCALATED

Each episode tracks:
- Attempts and actions taken
- Diffs applied and rolled back
- Verification results
- Failure reasons
- Timing for every state transition

This is the backbone of the agentic self-healing loop.
"""

from __future__ import annotations

import hashlib
import logging
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger("healing.repair_episode")


# ── Episode States ────────────────────────────────────────────────────

class EpisodeState(str, Enum):
    """States of a repair episode."""
    DETECTED = "detected"
    DIAGNOSING = "diagnosing"
    PLANNING = "planning"
    EXECUTING = "executing"
    VERIFYING = "verifying"
    SUCCEEDED = "succeeded"
    ROLLED_BACK = "rolled_back"
    ESCALATED = "escalated"
    CANCELLED = "cancelled"
    FAILED = "failed"


# Valid state transitions
VALID_TRANSITIONS: Dict[EpisodeState, List[EpisodeState]] = {
    EpisodeState.DETECTED: [
        EpisodeState.DIAGNOSING,
        EpisodeState.PLANNING,       # skip diagnosis for simple fixes
        EpisodeState.CANCELLED,
    ],
    EpisodeState.DIAGNOSING: [
        EpisodeState.PLANNING,
        EpisodeState.ESCALATED,      # diagnosis reveals too-complex issue
        EpisodeState.CANCELLED,
    ],
    EpisodeState.PLANNING: [
        EpisodeState.EXECUTING,
        EpisodeState.ESCALATED,      # no viable plan found
        EpisodeState.CANCELLED,
    ],
    EpisodeState.EXECUTING: [
        EpisodeState.VERIFYING,
        EpisodeState.ROLLED_BACK,    # execution failure → immediate rollback
        EpisodeState.FAILED,
    ],
    EpisodeState.VERIFYING: [
        EpisodeState.SUCCEEDED,
        EpisodeState.ROLLED_BACK,    # verification failure → rollback
        EpisodeState.PLANNING,       # verification failure → re-plan (retry)
        EpisodeState.ESCALATED,      # out of retry budget
    ],
    EpisodeState.SUCCEEDED: [],       # terminal
    EpisodeState.ROLLED_BACK: [
        EpisodeState.PLANNING,       # retry after rollback
        EpisodeState.ESCALATED,      # out of retry budget
    ],
    EpisodeState.ESCALATED: [],       # terminal
    EpisodeState.CANCELLED: [],       # terminal
    EpisodeState.FAILED: [],          # terminal
}


class TransitionError(Exception):
    """Invalid state transition."""
    pass


class BudgetExhaustedError(Exception):
    """Repair budget (attempts, time, tokens) exhausted."""
    pass


# ── Data structures ───────────────────────────────────────────────────

@dataclass
class RepairAction:
    """A single action taken during a repair episode."""
    action_type: str          # "patch", "compile", "test", "typecheck", "rollback", etc.
    description: str
    timestamp: float = field(default_factory=time.time)
    duration_ms: float = 0.0
    success: bool = True
    details: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "actionType": self.action_type,
            "description": self.description,
            "timestamp": self.timestamp,
            "durationMs": round(self.duration_ms, 1),
            "success": self.success,
            "details": self.details,
        }


@dataclass
class DiffRecord:
    """Record of a diff applied during repair."""
    file_path: str
    original_hash: str        # SHA-256 of original content
    patched_hash: str         # SHA-256 of patched content
    diff_text: str            # Unified diff
    applied_at: float = field(default_factory=time.time)
    rolled_back: bool = False
    rolled_back_at: Optional[float] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "filePath": self.file_path,
            "originalHash": self.original_hash,
            "patchedHash": self.patched_hash,
            "diffText": self.diff_text,
            "appliedAt": self.applied_at,
            "rolledBack": self.rolled_back,
            "rolledBackAt": self.rolled_back_at,
        }


@dataclass
class VerificationResult:
    """Result of a verification step."""
    check_type: str           # "compile", "test", "typecheck", "lint", "smoke"
    passed: bool
    details: str = ""
    duration_ms: float = 0.0
    timestamp: float = field(default_factory=time.time)
    errors: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "checkType": self.check_type,
            "passed": self.passed,
            "details": self.details,
            "durationMs": round(self.duration_ms, 1),
            "timestamp": self.timestamp,
            "errors": self.errors,
        }


@dataclass
class DiagnosisResult:
    """Result of diagnosing the root cause."""
    root_cause: str                   # Human-readable root cause
    source_files: List[str]           # Files involved
    dependency_chain: List[str]       # Import/call chain leading to error
    recent_edits: List[str]           # Recently edited files
    prior_attempts: int = 0           # How many prior fix attempts
    confidence: float = 0.5           # Confidence in diagnosis
    cause_candidates: List[Dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "rootCause": self.root_cause,
            "sourceFiles": self.source_files,
            "dependencyChain": self.dependency_chain,
            "recentEdits": self.recent_edits,
            "priorAttempts": self.prior_attempts,
            "confidence": self.confidence,
            "causeCandidates": self.cause_candidates,
        }


@dataclass
class RepairPlan:
    """A planned sequence of repair steps."""
    plan_id: str = ""
    steps: List[Dict[str, Any]] = field(default_factory=list)
    estimated_duration_ms: float = 0.0
    confidence: float = 0.5
    strategy: str = "single_patch"  # "single_patch", "multi_step", "iterative"
    fallback_plans: List["RepairPlan"] = field(default_factory=list)

    def __post_init__(self):
        if not self.plan_id:
            self.plan_id = uuid.uuid4().hex[:12]

    def to_dict(self) -> Dict[str, Any]:
        return {
            "planId": self.plan_id,
            "steps": self.steps,
            "estimatedDurationMs": round(self.estimated_duration_ms, 1),
            "confidence": self.confidence,
            "strategy": self.strategy,
            "fallbackPlans": [p.to_dict() for p in self.fallback_plans],
        }


@dataclass
class RepairBudget:
    """Resource limits for a repair episode."""
    max_attempts: int = 3             # Max fix attempts
    max_duration_seconds: float = 120.0   # Total time budget
    max_llm_calls: int = 10           # Max LLM API calls
    max_files_modified: int = 5       # Max files touched
    max_lines_changed: int = 50       # Max total lines changed

    def to_dict(self) -> Dict[str, Any]:
        return {
            "maxAttempts": self.max_attempts,
            "maxDurationSeconds": self.max_duration_seconds,
            "maxLlmCalls": self.max_llm_calls,
            "maxFilesModified": self.max_files_modified,
            "maxLinesChanged": self.max_lines_changed,
        }


@dataclass
class StateTransition:
    """Record of a state transition."""
    from_state: EpisodeState
    to_state: EpisodeState
    timestamp: float = field(default_factory=time.time)
    reason: str = ""
    details: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "fromState": self.from_state.value,
            "toState": self.to_state.value,
            "timestamp": self.timestamp,
            "reason": self.reason,
            "details": self.details,
        }


# ── The Episode itself ────────────────────────────────────────────────

class RepairEpisode:
    """
    A complete repair episode with state machine semantics.

    Tracks every action, diff, verification, and state transition
    from detection through success/failure/escalation.

    Usage:
        episode = RepairEpisode(
            trigger="compile_error",
            error_message="SyntaxError: unexpected token...",
            file_path="src/app.py",
        )
        episode.transition_to(EpisodeState.DIAGNOSING)
        episode.set_diagnosis(DiagnosisResult(...))
        episode.transition_to(EpisodeState.PLANNING)
        episode.set_plan(RepairPlan(...))
        episode.transition_to(EpisodeState.EXECUTING)
        episode.record_action(RepairAction(...))
        episode.record_diff(DiffRecord(...))
        episode.transition_to(EpisodeState.VERIFYING)
        episode.record_verification(VerificationResult(...))
        episode.transition_to(EpisodeState.SUCCEEDED)
    """

    def __init__(
        self,
        trigger: str,
        error_message: str = "",
        file_path: str = "",
        language: str = "",
        budget: Optional[RepairBudget] = None,
        episode_id: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ):
        self.episode_id = episode_id or uuid.uuid4().hex[:16]
        self.trigger = trigger           # "compile_error", "test_failure", "runtime_exception", etc.
        self.error_message = error_message
        self.file_path = file_path
        self.language = language
        self.budget = budget or RepairBudget()
        self.metadata = metadata or {}

        # State
        self._state = EpisodeState.DETECTED
        self._created_at = time.time()
        self._updated_at = time.time()
        self._finished_at: Optional[float] = None

        # Tracking
        self._transitions: List[StateTransition] = []
        self._actions: List[RepairAction] = []
        self._diffs: List[DiffRecord] = []
        self._verifications: List[VerificationResult] = []
        self._diagnosis: Optional[DiagnosisResult] = None
        self._plan: Optional[RepairPlan] = None
        self._active_plan_index: int = 0  # Which fallback plan we're on

        # Counters
        self._attempt_count: int = 0
        self._llm_call_count: int = 0
        self._files_modified: set = set()
        self._lines_changed: int = 0

        # Failure info
        self._failure_reasons: List[str] = []
        self._escalation_reason: str = ""

        # Listeners
        self._listeners: List[Callable[[RepairEpisode, StateTransition], None]] = []

        logger.info(
            f"Repair episode {self.episode_id} created: "
            f"trigger={trigger}, file={file_path}"
        )

    @property
    def state(self) -> EpisodeState:
        return self._state

    @property
    def is_terminal(self) -> bool:
        return self._state in {
            EpisodeState.SUCCEEDED,
            EpisodeState.ESCALATED,
            EpisodeState.CANCELLED,
            EpisodeState.FAILED,
        }

    @property
    def elapsed_seconds(self) -> float:
        end = self._finished_at or time.time()
        return end - self._created_at

    @property
    def attempt_count(self) -> int:
        return self._attempt_count

    @property
    def diagnosis(self) -> Optional[DiagnosisResult]:
        return self._diagnosis

    @property
    def plan(self) -> Optional[RepairPlan]:
        return self._plan

    @property
    def diffs(self) -> List[DiffRecord]:
        return list(self._diffs)

    @property
    def verifications(self) -> List[VerificationResult]:
        return list(self._verifications)

    @property
    def actions(self) -> List[RepairAction]:
        return list(self._actions)

    @property
    def transitions(self) -> List[StateTransition]:
        return list(self._transitions)

    @property
    def failure_reasons(self) -> List[str]:
        return list(self._failure_reasons)

    def on_transition(
        self, listener: Callable[["RepairEpisode", StateTransition], None]
    ) -> Callable:
        """Register a transition listener. Returns unsubscribe fn."""
        self._listeners.append(listener)
        return lambda: self._listeners.remove(listener)

    # ── State transitions ─────────────────────────────────────────────

    def transition_to(
        self,
        new_state: EpisodeState,
        reason: str = "",
        details: Optional[Dict[str, Any]] = None,
    ) -> None:
        """
        Transition to a new state.

        Validates the transition against VALID_TRANSITIONS.
        Raises TransitionError if invalid.
        """
        if self.is_terminal:
            raise TransitionError(
                f"Episode {self.episode_id} is in terminal state "
                f"{self._state.value}, cannot transition to {new_state.value}"
            )

        valid_next = VALID_TRANSITIONS.get(self._state, [])
        if new_state not in valid_next:
            raise TransitionError(
                f"Invalid transition: {self._state.value} → {new_state.value}. "
                f"Valid: {[s.value for s in valid_next]}"
            )

        # Check budget before executing
        if new_state == EpisodeState.EXECUTING:
            self._check_budget()

        transition = StateTransition(
            from_state=self._state,
            to_state=new_state,
            reason=reason,
            details=details or {},
        )
        self._transitions.append(transition)
        old_state = self._state
        self._state = new_state
        self._updated_at = time.time()

        # Track attempt count on re-plan
        if old_state in (EpisodeState.ROLLED_BACK, EpisodeState.VERIFYING) \
                and new_state == EpisodeState.PLANNING:
            self._attempt_count += 1

        # Mark finished
        if self.is_terminal:
            self._finished_at = time.time()

        logger.info(
            f"Episode {self.episode_id}: "
            f"{old_state.value} → {new_state.value}"
            f"{f' ({reason})' if reason else ''}"
        )

        # Notify listeners
        for listener in self._listeners:
            try:
                listener(self, transition)
            except Exception as e:
                logger.warning(f"Transition listener error: {e}")

    def _check_budget(self) -> None:
        """Raise BudgetExhaustedError if any budget limit is reached."""
        if self._attempt_count >= self.budget.max_attempts:
            raise BudgetExhaustedError(
                f"Max attempts reached: {self._attempt_count} >= "
                f"{self.budget.max_attempts}"
            )
        if self.elapsed_seconds >= self.budget.max_duration_seconds:
            raise BudgetExhaustedError(
                f"Time budget exhausted: {self.elapsed_seconds:.1f}s >= "
                f"{self.budget.max_duration_seconds}s"
            )
        if self._llm_call_count >= self.budget.max_llm_calls:
            raise BudgetExhaustedError(
                f"LLM call budget exhausted: {self._llm_call_count} >= "
                f"{self.budget.max_llm_calls}"
            )

    # ── Recording methods ─────────────────────────────────────────────

    def set_diagnosis(self, diagnosis: DiagnosisResult) -> None:
        """Record diagnosis result."""
        self._diagnosis = diagnosis
        logger.debug(
            f"Episode {self.episode_id}: diagnosis set, "
            f"root_cause={diagnosis.root_cause[:80]}"
        )

    def set_plan(self, plan: RepairPlan) -> None:
        """Record the active repair plan."""
        self._plan = plan
        logger.debug(
            f"Episode {self.episode_id}: plan set, "
            f"strategy={plan.strategy}, steps={len(plan.steps)}"
        )

    def record_action(self, action: RepairAction) -> None:
        """Record an action taken during the episode."""
        self._actions.append(action)
        if action.action_type == "llm_call":
            self._llm_call_count += 1

    def record_diff(self, diff: DiffRecord) -> None:
        """Record a diff applied to a file."""
        self._diffs.append(diff)
        self._files_modified.add(diff.file_path)
        # Rough line count from diff text
        added = diff.diff_text.count("\n+") if diff.diff_text else 0
        removed = diff.diff_text.count("\n-") if diff.diff_text else 0
        self._lines_changed += added + removed

    def record_verification(self, result: VerificationResult) -> None:
        """Record a verification result."""
        self._verifications.append(result)

    def record_failure(self, reason: str) -> None:
        """Record a failure reason."""
        self._failure_reasons.append(reason)
        logger.warning(f"Episode {self.episode_id}: failure recorded: {reason}")

    def set_escalation_reason(self, reason: str) -> None:
        """Set the escalation reason (for ESCALATED state)."""
        self._escalation_reason = reason

    def mark_diff_rolled_back(self, file_path: str) -> None:
        """Mark all diffs for a file as rolled back."""
        for diff in self._diffs:
            if diff.file_path == file_path and not diff.rolled_back:
                diff.rolled_back = True
                diff.rolled_back_at = time.time()

    def mark_all_diffs_rolled_back(self) -> None:
        """Mark ALL diffs as rolled back."""
        for diff in self._diffs:
            if not diff.rolled_back:
                diff.rolled_back = True
                diff.rolled_back_at = time.time()

    # ── Budget tracking ───────────────────────────────────────────────

    def increment_llm_calls(self, count: int = 1) -> None:
        self._llm_call_count += count

    def has_budget(self) -> bool:
        """Check if the episode still has budget remaining."""
        try:
            self._check_budget()
            return True
        except BudgetExhaustedError:
            return False

    # ── Serialization ─────────────────────────────────────────────────

    def to_dict(self) -> Dict[str, Any]:
        """Full serialization for audit/API."""
        return {
            "episodeId": self.episode_id,
            "state": self._state.value,
            "trigger": self.trigger,
            "errorMessage": self.error_message,
            "filePath": self.file_path,
            "language": self.language,
            "budget": self.budget.to_dict(),
            "metadata": self.metadata,
            "createdAt": self._created_at,
            "updatedAt": self._updated_at,
            "finishedAt": self._finished_at,
            "elapsedSeconds": round(self.elapsed_seconds, 2),
            "attemptCount": self._attempt_count,
            "llmCallCount": self._llm_call_count,
            "filesModified": list(self._files_modified),
            "linesChanged": self._lines_changed,
            "transitions": [t.to_dict() for t in self._transitions],
            "actions": [a.to_dict() for a in self._actions],
            "diffs": [d.to_dict() for d in self._diffs],
            "verifications": [v.to_dict() for v in self._verifications],
            "diagnosis": self._diagnosis.to_dict() if self._diagnosis else None,
            "plan": self._plan.to_dict() if self._plan else None,
            "failureReasons": self._failure_reasons,
            "escalationReason": self._escalation_reason,
        }

    def summary(self) -> Dict[str, Any]:
        """Compact summary for listings."""
        return {
            "episodeId": self.episode_id,
            "state": self._state.value,
            "trigger": self.trigger,
            "filePath": self.file_path,
            "elapsedSeconds": round(self.elapsed_seconds, 2),
            "attemptCount": self._attempt_count,
            "verificationsRun": len(self._verifications),
            "verificationsPassed": sum(
                1 for v in self._verifications if v.passed
            ),
        }


# ── Episode Store (in-memory) ────────────────────────────────────────

class EpisodeStore:
    """
    In-memory store for repair episodes.

    Provides lookup by ID, listing, and cleanup of old episodes.
    In production, back this with a database.
    """

    def __init__(self, max_episodes: int = 500):
        self._episodes: Dict[str, RepairEpisode] = {}
        self._max_episodes = max_episodes

    def create(self, **kwargs) -> RepairEpisode:
        """Create and store a new episode."""
        episode = RepairEpisode(**kwargs)
        self._episodes[episode.episode_id] = episode
        self._evict_if_needed()
        return episode

    def get(self, episode_id: str) -> Optional[RepairEpisode]:
        """Get an episode by ID."""
        return self._episodes.get(episode_id)

    def list_active(self) -> List[RepairEpisode]:
        """List all non-terminal episodes."""
        return [
            ep for ep in self._episodes.values()
            if not ep.is_terminal
        ]

    def list_recent(self, limit: int = 20) -> List[RepairEpisode]:
        """List recent episodes, newest first."""
        episodes = sorted(
            self._episodes.values(),
            key=lambda ep: ep._created_at,
            reverse=True,
        )
        return episodes[:limit]

    def list_by_file(self, file_path: str) -> List[RepairEpisode]:
        """List episodes for a specific file."""
        return [
            ep for ep in self._episodes.values()
            if ep.file_path == file_path
        ]

    def list_by_state(self, state: EpisodeState) -> List[RepairEpisode]:
        """List episodes in a specific state."""
        return [
            ep for ep in self._episodes.values()
            if ep.state == state
        ]

    def cleanup_old(self, max_age_seconds: float = 3600.0) -> int:
        """Remove terminal episodes older than max_age_seconds."""
        cutoff = time.time() - max_age_seconds
        to_remove = [
            eid for eid, ep in self._episodes.items()
            if ep.is_terminal and ep._created_at < cutoff
        ]
        for eid in to_remove:
            del self._episodes[eid]
        return len(to_remove)

    def stats(self) -> Dict[str, Any]:
        """Summary statistics."""
        by_state: Dict[str, int] = {}
        for ep in self._episodes.values():
            state = ep.state.value
            by_state[state] = by_state.get(state, 0) + 1

        return {
            "total": len(self._episodes),
            "active": len(self.list_active()),
            "byState": by_state,
        }

    def _evict_if_needed(self) -> None:
        """Evict oldest terminal episodes if over capacity."""
        if len(self._episodes) <= self._max_episodes:
            return
        terminal = sorted(
            [
                (eid, ep) for eid, ep in self._episodes.items()
                if ep.is_terminal
            ],
            key=lambda x: x[1]._created_at,
        )
        while len(self._episodes) > self._max_episodes and terminal:
            eid, _ = terminal.pop(0)
            del self._episodes[eid]


# ── Module-level singleton ────────────────────────────────────────────

_episode_store: Optional[EpisodeStore] = None


def get_episode_store() -> EpisodeStore:
    """Get or create the global episode store."""
    global _episode_store
    if _episode_store is None:
        _episode_store = EpisodeStore()
    return _episode_store


def reset_episode_store() -> None:
    """Reset the global store (for testing)."""
    global _episode_store
    _episode_store = None

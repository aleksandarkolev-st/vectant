"""Counterfactual telemetry contracts for shadow execution.

These types are intentionally runner-agnostic. Existing shadow universes,
future Codex/Claude adapters, browser agents, and workflow runners should all
normalize into these contracts before arbiters or policy learning touch them.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional


class ExposureLevel(str, Enum):
    GENERATED = "generated"
    DETECTOR_EVALUATED = "detector_evaluated"
    ARBITER_RANKED = "arbiter_ranked"
    SHOWN = "shown"
    DIFF_OPENED = "diff_opened"
    EXPLANATION_OPENED = "explanation_opened"
    APPLIED = "applied"
    EDITED_AFTER_APPLY = "edited_after_apply"
    REUSED_LATER = "reused_later"


class CounterfactualStrength(str, Enum):
    NONE = "none"
    WEAK = "weak"
    MEDIUM = "medium"
    STRONG = "strong"


class DetectorKind(str, Enum):
    LINT = "lint"
    TYPECHECK = "typecheck"
    UNIT_TESTS = "unit_tests"
    INTEGRATION_TESTS = "integration_tests"
    RUNTIME_PROBE = "runtime_probe"
    BROWSER_PROBE = "browser_probe"
    VISUAL_SNAPSHOT = "visual_snapshot"
    SECURITY_SCAN = "security_scan"
    LICENSE_SCAN = "license_scan"
    DEPENDENCY_SCAN = "dependency_scan"
    MIGRATION_CHECK = "migration_check"
    PERFORMANCE_PROBE = "performance_probe"
    COST_METER = "cost_meter"
    LATENCY_METER = "latency_meter"
    HUMAN_READABILITY = "human_readability"


class DetectorStatus(str, Enum):
    PASSED = "passed"
    FAILED = "failed"
    PARTIAL = "partial"
    SKIPPED = "skipped"
    NOT_APPLICABLE = "not_applicable"


class PolicyDeltaKind(str, Enum):
    RUNNER_WEIGHT_CHANGE = "runner_weight_change"
    UNIVERSE_DIRECTION_CHANGE = "universe_direction_change"
    DETECTOR_GATE_CHANGE = "detector_gate_change"
    PROMPT_HINT_CHANGE = "prompt_hint_change"
    ARBITER_WEIGHT_CHANGE = "arbiter_weight_change"
    BUDGET_ALLOCATION_CHANGE = "budget_allocation_change"
    MUTATION_TRIAL_PERMISSION = "mutation_trial_permission"


class PolicyDeltaStatus(str, Enum):
    HYPOTHESIS = "hypothesis"
    ACTIVE = "active"
    PROMOTED = "promoted"
    CONTRADICTED = "contradicted"
    DELETED = "deleted"


class MutationTrialStatus(str, Enum):
    PLANNED = "planned"
    RUNNING = "running"
    PASSED = "passed"
    FAILED = "failed"
    NOT_SELECTED = "not_selected"
    CANCELLED = "cancelled"


class SelectionOutcome(str, Enum):
    SELECTED = "selected"
    NOT_SELECTED = "not_selected"
    CANCELLED = "cancelled"
    FAILED_BEFORE_COMPARISON = "failed_before_comparison"
    UNKNOWN = "unknown"


AMBIGUITY_FLAGS = {
    "branch_failed_before_comparison",
    "branch_not_visible_to_selector",
    "budget_exhausted",
    "latency_abort",
    "stale_branch",
    "merge_conflict",
    "permission_blocked",
    "detector_incomplete",
    "user_left_session",
    "selector_unknown",
    "applied_due_to_time_pressure",
    "final_selection_external",
}


@dataclass
class PhenotypeVector:
    locality: float = 0.0
    abstraction_shift: float = 0.0
    runtime_depth: float = 0.0
    ui_surface_shift: float = 0.0
    workflow_shift: float = 0.0
    proof_newness: float = 0.0
    dependency_change: float = 0.0
    blast_radius: float = 0.0
    reversibility: float = 1.0
    migration_complexity: float = 0.0
    user_visible_change: float = 0.0
    protocol_change: float = 0.0
    state_model_change: float = 0.0

    def to_dict(self) -> Dict[str, float]:
        return asdict(self)


@dataclass
class CostTrace:
    estimated_usd: float = 0.0
    actual_usd: Optional[float] = None


@dataclass
class LatencyTrace:
    duration_ms: int = 0
    timed_out: bool = False


@dataclass
class RiskTrace:
    failed_hard_gates: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)


@dataclass
class DetectorResult:
    id: str
    branch_trace_id: str
    detector_kind: DetectorKind
    status: DetectorStatus
    score: float
    evidence_summary: str
    raw_artifact_ref: Optional[str] = None
    started_at: Optional[float] = None
    finished_at: Optional[float] = None

    def to_dict(self) -> Dict[str, Any]:
        data = asdict(self)
        data["detector_kind"] = self.detector_kind.value
        data["status"] = self.status.value
        return data


@dataclass
class BranchTrace:
    id: str
    counterfactual_run_id: str
    universe_id: str
    runner_id: str
    runner_kind: str
    direction_id: str
    direction_label: str
    declared_condition: str
    prompt_lineage: List[str]
    start_state_hash: str
    end_state_hash: str
    artifact_summary: str
    diff_summary: Dict[str, Any]
    tool_trace_summary: Dict[str, Any]
    command_trace_summary: Dict[str, Any]
    detector_trace_ids: List[str]
    cost_trace: CostTrace
    latency_trace: LatencyTrace
    risk_trace: RiskTrace
    phenotype_vector: PhenotypeVector
    novelty_vector: Dict[str, float]
    proof_score: float
    risk_score: float
    exposure_level: ExposureLevel = ExposureLevel.GENERATED
    selection_outcome: SelectionOutcome = SelectionOutcome.UNKNOWN
    counterfactual_strength: CounterfactualStrength = CounterfactualStrength.NONE
    extinction_hypotheses: List[str] = field(default_factory=list)
    ambiguity_flags: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        data = asdict(self)
        data["exposure_level"] = self.exposure_level.value
        data["selection_outcome"] = self.selection_outcome.value
        data["counterfactual_strength"] = self.counterfactual_strength.value
        return data


@dataclass
class ChoiceScene:
    id: str
    counterfactual_run_id: str
    base_commit_or_state_hash: str
    request_summary: str
    task_class: str
    available_universe_ids: List[str]
    visible_universe_ids: List[str]
    opened_diff_universe_ids: List[str]
    opened_explanation_universe_ids: List[str]
    arbiter_recommendation: Optional[str]
    selector_action: str
    selected_universe_id: Optional[str]
    cancel_stage: Optional[str] = None
    override_reason: Optional[str] = None
    selection_latency_ms: Optional[int] = None
    budget_state: Dict[str, Any] = field(default_factory=dict)
    ambiguity_flags: List[str] = field(default_factory=list)

    @property
    def user_overrode_arbiter(self) -> bool:
        return bool(
            self.selected_universe_id
            and self.arbiter_recommendation
            and self.selected_universe_id != self.arbiter_recommendation
        )

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class CounterfactualRun:
    run_id: str
    workspace_id: str
    request_id: str
    task_class: str
    base_state: Dict[str, Any]
    created_at: float
    user_id: Optional[str] = None
    team_id: Optional[str] = None
    runners: List[Dict[str, Any]] = field(default_factory=list)
    universes: List[str] = field(default_factory=list)
    detector_results: List[str] = field(default_factory=list)
    arbiter_results: List[Dict[str, Any]] = field(default_factory=list)
    selection_event: Optional[Dict[str, Any]] = None
    post_selection_mutation: Optional[Dict[str, Any]] = None
    learned_policy_deltas: List[str] = field(default_factory=list)
    retention_policy: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class PolicyDelta:
    id: str
    source_counterfactual_run_id: str
    workspace_id: str
    task_class: str
    delta_kind: PolicyDeltaKind
    before: str
    after: str
    confidence: str
    evidence_refs: List[str]
    expiry: Optional[float] = None
    status: PolicyDeltaStatus = PolicyDeltaStatus.HYPOTHESIS

    def to_dict(self) -> Dict[str, Any]:
        data = asdict(self)
        data["delta_kind"] = self.delta_kind.value
        data["status"] = self.status.value
        return data


@dataclass
class BranchFossil:
    """Bounded, durable learning material derived from a branch trace.

    Full source, prompts, and raw tool output deliberately stay out of fossils.
    They remain behind explicit artifact references and their separate retention
    policy, so a workspace can learn without turning its source tree into a
    telemetry archive.
    """

    id: str
    branch_trace_id: str
    workspace_id: str
    task_class: str
    runner_kind: str
    direction_label: str
    compact_artifact_summary: str
    compact_diff_summary: Dict[str, Any]
    phenotype_vector: PhenotypeVector
    detector_summary: List[Dict[str, Any]]
    selection_outcome: SelectionOutcome
    exposure_level: ExposureLevel
    counterfactual_strength: CounterfactualStrength
    inferred_lessons: List[str]
    source_counterfactual_run_id: str
    created_at: float
    decay_after: Optional[float] = None

    def to_dict(self) -> Dict[str, Any]:
        data = asdict(self)
        data["selection_outcome"] = self.selection_outcome.value
        data["exposure_level"] = self.exposure_level.value
        data["counterfactual_strength"] = self.counterfactual_strength.value
        return data


@dataclass
class MutationTrial:
    """A quarantined policy exception. It can never be auto-applied."""

    id: str
    counterfactual_run_id: str
    workspace_id: str
    task_class: str
    violated_policy: str
    why_now: str
    stricter_detectors: List[DetectorKind]
    quarantine_policy: str
    budget_cap_usd: float
    status: MutationTrialStatus = MutationTrialStatus.PLANNED
    result: Optional[str] = None
    regret_signal_scope: str = "isolated"
    auto_apply_allowed: bool = False
    created_at: float = 0.0

    def __post_init__(self) -> None:
        if self.auto_apply_allowed:
            raise ValueError("Mutation Trials must never allow auto-apply")
        if self.budget_cap_usd <= 0:
            raise ValueError("Mutation Trial budget cap must be positive")

    def to_dict(self) -> Dict[str, Any]:
        data = asdict(self)
        data["stricter_detectors"] = [kind.value for kind in self.stricter_detectors]
        data["status"] = self.status.value
        return data


@dataclass
class PostSelectionMutation:
    selected_branch_id: str
    observation_window: str
    files_changed_after_apply: List[str]
    deleted_generated_blocks: int
    retained_generated_blocks: int
    abstraction_removed: bool
    tests_added_by_user: bool
    ui_changed_by_user: bool
    runtime_changed_by_user: bool
    mutation_summary: str
    retention_score: float
    observed_at: float

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

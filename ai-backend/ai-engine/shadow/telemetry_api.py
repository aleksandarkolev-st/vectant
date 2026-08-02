"""Public counterfactual control-plane API backed by durable workspace telemetry."""

from __future__ import annotations

import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .branch_fossil import fossilize
from .choice_scene import annotate_traces_with_choice, build_choice_scene
from .counterfactual_types import (
    BranchTrace, CostTrace, DetectorKind, DetectorResult, DetectorStatus, LatencyTrace,
    PhenotypeVector, RiskTrace,
)
from .regret_arbiter import extract_regret_lessons
from .telemetry_repository import TelemetryRepository
from .post_selection_mutation import summarize_post_selection_mutation

router = APIRouter(prefix="/counterfactual", tags=["counterfactual"])


class RunRequest(BaseModel):
    workspace_path: str
    workspace_id: Optional[str] = None
    request_id: str
    task_class: str
    base_state: Dict[str, Any]
    universe_plan: List[Dict[str, Any]] = Field(min_length=1, max_length=8)
    user_id: Optional[str] = None
    team_id: Optional[str] = None


class BranchRequest(BaseModel):
    universe_id: str
    runner_kind: str
    direction_label: str
    artifact_summary: str
    phenotype_vector: Dict[str, float] = Field(default_factory=dict)
    diff_summary: Dict[str, Any] = Field(default_factory=dict)
    direction_id: Optional[str] = None
    runner_id: Optional[str] = None
    declared_condition: Optional[str] = None


class DetectorRequest(BaseModel):
    detector_kind: DetectorKind
    status: DetectorStatus
    score: float = Field(ge=0, le=1)
    evidence_summary: str
    raw_artifact_ref: Optional[str] = None


class SelectionRequest(BaseModel):
    selected_universe_id: Optional[str] = None
    selector_kind: Literal["human", "system", "external"] = "human"
    arbiter_winner_universe_id: Optional[str] = None
    visible_universe_ids: List[str] = Field(default_factory=list)
    opened_diff_universe_ids: List[str] = Field(default_factory=list)
    opened_explanation_universe_ids: List[str] = Field(default_factory=list)
    selection_action: str
    ambiguity_flags: List[str] = Field(default_factory=list)
    cancel_stage: Optional[str] = None


class DeltaRequest(BaseModel):
    mode: Literal["deterministic_first"] = "deterministic_first"
    max_deltas: int = Field(default=3, ge=1, le=5)


class ForecastRequest(BaseModel):
    workspace_path: str
    task_class: str
    request_summary: str
    budget: Dict[str, Any]


class ControlsRequest(BaseModel):
    workspace_path: str
    enabled: Optional[bool] = None
    fossil_days: Optional[int] = None
    raw_trace_days: Optional[int] = None


class MutationTrialRequest(BaseModel):
    workspace_path: str
    task_class: str
    violated_policy: str
    why_now: str
    stricter_detectors: List[DetectorKind] = Field(min_length=1)
    quarantine_policy: str
    budget_cap_usd: float = Field(gt=0, le=1000)
    auto_apply_allowed: Literal[False] = False


class PostSelectionMutationFile(BaseModel):
    path: str
    generated_content: str = Field(max_length=256_000)
    observed_content: str = Field(max_length=256_000)


class PostSelectionMutationRequest(BaseModel):
    selected_branch_id: str
    observation_window: str = Field(max_length=160)
    files: List[PostSelectionMutationFile] = Field(default_factory=list, max_length=100)
    abstraction_removed: bool = False
    tests_added_by_user: bool = False
    ui_changed_by_user: bool = False
    runtime_changed_by_user: bool = False


def _repo(workspace_path: str) -> TelemetryRepository:
    root = Path(workspace_path).expanduser().resolve()
    if not root.is_dir():
        raise HTTPException(status_code=422, detail="workspace_path must be an existing directory")
    return TelemetryRepository(root)


@router.post("/runs", status_code=201)
def create_run(payload: RunRequest) -> Dict[str, Any]:
    repo = _repo(payload.workspace_path)
    run_id = f"cfr_{uuid.uuid4().hex}"
    record = repo.put_run({"run_id": run_id, "workspace_id": payload.workspace_id or str(repo.repo),
        "request_id": payload.request_id, "task_class": payload.task_class, "base_state": payload.base_state,
        "created_at": time.time(), "user_id": payload.user_id, "team_id": payload.team_id,
        "runners": [{"kind": item.get("runner_kind", "custom")} for item in payload.universe_plan],
        "universes": [str(item.get("id") or item.get("universe_id") or "") for item in payload.universe_plan],
        "detector_results": [], "arbiter_results": [], "learned_policy_deltas": [], "retention_policy": repo.retention()})
    return {"counterfactual_run": record, "telemetry_enabled": repo.is_enabled()}


@router.post("/runs/{run_id}/branches", status_code=201)
def submit_branch(run_id: str, payload: BranchRequest, workspace_path: str) -> Dict[str, Any]:
    repo = _repo(workspace_path)
    run = repo.get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="counterfactual run not found")
    trace = _trace_from_payload(run_id, payload)
    return {"branch_trace": repo.put_branch(trace.to_dict())}


@router.post("/branches/{branch_id}/detectors", status_code=201)
def submit_detector(branch_id: str, payload: DetectorRequest, workspace_path: str) -> Dict[str, Any]:
    repo = _repo(workspace_path)
    detector = DetectorResult(id=f"det_{uuid.uuid4().hex[:16]}", branch_trace_id=branch_id,
        detector_kind=payload.detector_kind, status=payload.status, score=payload.score,
        evidence_summary=payload.evidence_summary, raw_artifact_ref=payload.raw_artifact_ref,
        started_at=time.time(), finished_at=time.time())
    try:
        return {"detector_result": repo.put_detector(detector.to_dict())}
    except KeyError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@router.post("/runs/{run_id}/selection", status_code=201)
def record_selection(run_id: str, payload: SelectionRequest, workspace_path: str) -> Dict[str, Any]:
    repo = _repo(workspace_path)
    run = repo.get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="counterfactual run not found")
    scene = build_choice_scene(run_id=run_id, base_state_hash=str(run.get("base_state", {}).get("commit") or "unknown"),
        request_summary=str(run.get("request_id") or ""), task_class=str(run.get("task_class") or "unknown"),
        available_universe_ids=run.get("universes") or [], visible_universe_ids=payload.visible_universe_ids,
        opened_diff_universe_ids=payload.opened_diff_universe_ids,
        opened_explanation_universe_ids=payload.opened_explanation_universe_ids,
        arbiter_recommendation=payload.arbiter_winner_universe_id, selector_action=payload.selection_action,
        selected_universe_id=payload.selected_universe_id, ambiguity_flags=payload.ambiguity_flags,
        cancel_stage=payload.cancel_stage)
    return {"choice_scene": repo.put_choice_scene(scene.to_dict())}


@router.post("/runs/{run_id}/policy-deltas", status_code=201)
def generate_policy_deltas(run_id: str, payload: DeltaRequest, workspace_path: str) -> Dict[str, Any]:
    repo = _repo(workspace_path)
    run = repo.get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="counterfactual run not found")
    scenes = [scene for scene in repo._read()["choice_scenes"].values() if scene.get("counterfactual_run_id") == run_id]
    if not scenes:
        raise HTTPException(status_code=409, detail="a ChoiceScene is required before extracting policy deltas")
    scene = max(scenes, key=lambda item: item.get("id", ""))
    traces = [_trace_from_record(item) for item in repo._read()["branches"].values() if item.get("counterfactual_run_id") == run_id]
    choice = _scene_from_record(scene)
    annotated = annotate_traces_with_choice(traces, choice)
    lessons = extract_regret_lessons(choice_scene=choice, traces=annotated, workspace_id=str(repo.repo))[:payload.max_deltas]
    stored = repo.put_policy_deltas([lesson.policy_delta.to_dict() for lesson in lessons])
    detectors = repo._read()["detectors"]
    for trace in annotated:
        matching = [_detector_from_record(item) for item in detectors.values() if item.get("branch_trace_id") == trace.id]
        repo.put_branch(trace.to_dict())
        repo.put_fossil(fossilize(trace=trace, detectors=matching, workspace_id=str(repo.repo), task_class=choice.task_class,
            inferred_lessons=[lesson.text for lesson in lessons if trace.id in lesson.policy_delta.evidence_refs], retention_days=repo.retention()["fossil_days"]).to_dict())
    return {"policy_deltas": stored, "learned_lines": [lesson.text for lesson in lessons], "execution_niche_map": repo.niche_map(choice.task_class)}


@router.get("/niche-map")
def get_niche_map(workspace_path: str, task_class: str) -> Dict[str, Any]:
    repo = _repo(workspace_path)
    return {"execution_niche_map": repo.niche_map(task_class), "telemetry_enabled": repo.is_enabled()}


@router.post("/forecast/directions")
def forecast_directions(payload: ForecastRequest) -> Dict[str, Any]:
    repo = _repo(payload.workspace_path)
    return {"directions": repo.forecast(task_class=payload.task_class, request_summary=payload.request_summary,
        max_universes=int(payload.budget.get("max_universes", 3)), max_cost_usd=float(payload.budget.get("max_cost_usd", 0)))}


@router.get("/controls")
def get_controls(workspace_path: str) -> Dict[str, Any]:
    repo = _repo(workspace_path)
    return {"enabled": repo.is_enabled(), "retention": repo.retention()}


@router.put("/controls")
def update_controls(payload: ControlsRequest) -> Dict[str, Any]:
    repo = _repo(payload.workspace_path)
    if payload.enabled is not None:
        repo.set_enabled(payload.enabled)
    if payload.fossil_days is not None or payload.raw_trace_days is not None:
        repo.update_retention(fossil_days=payload.fossil_days, raw_trace_days=payload.raw_trace_days)
    return {"enabled": repo.is_enabled(), "retention": repo.retention()}


@router.delete("/policy-deltas/{delta_id}")
def delete_policy_delta(delta_id: str, workspace_path: str) -> Dict[str, Any]:
    repo = _repo(workspace_path)
    if not repo.delete_policy_delta(delta_id):
        raise HTTPException(status_code=404, detail="policy delta not found")
    return {"deleted": True}


@router.post("/runs/{run_id}/mutation-trials", status_code=201)
def create_mutation_trial(run_id: str, payload: MutationTrialRequest) -> Dict[str, Any]:
    repo = _repo(payload.workspace_path)
    if not repo.get_run(run_id):
        raise HTTPException(status_code=404, detail="counterfactual run not found")
    trial = {"id": f"mutation_{uuid.uuid4().hex}", "counterfactual_run_id": run_id, "workspace_id": str(repo.repo),
        "task_class": payload.task_class, "violated_policy": payload.violated_policy, "why_now": payload.why_now,
        "stricter_detectors": [item.value for item in payload.stricter_detectors], "quarantine_policy": payload.quarantine_policy,
        "budget_cap_usd": payload.budget_cap_usd, "status": "planned", "result": None,
        "regret_signal_scope": "isolated", "auto_apply_allowed": False, "created_at": time.time()}
    return {"mutation_trial": repo.put_mutation_trial(trial)}


@router.post("/runs/{run_id}/post-selection-mutation", status_code=201)
def record_post_selection_mutation(run_id: str, payload: PostSelectionMutationRequest, workspace_path: str) -> Dict[str, Any]:
    repo = _repo(workspace_path)
    run = repo.get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="counterfactual run not found")
    mutation = summarize_post_selection_mutation(
        selected_branch_id=payload.selected_branch_id,
        observation_window=payload.observation_window,
        files=[item.model_dump() for item in payload.files],
        abstraction_removed=payload.abstraction_removed,
        tests_added_by_user=payload.tests_added_by_user,
        ui_changed_by_user=payload.ui_changed_by_user,
        runtime_changed_by_user=payload.runtime_changed_by_user,
    )
    try:
        repo.update_run(run_id, post_selection_mutation=mutation.to_dict())
    except KeyError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    return {"post_selection_mutation": mutation.to_dict()}


def _trace_from_payload(run_id: str, payload: BranchRequest) -> BranchTrace:
    vector = PhenotypeVector(**{key: value for key, value in payload.phenotype_vector.items() if key in PhenotypeVector.__dataclass_fields__})
    return BranchTrace(id=f"br_{run_id}_{payload.universe_id}", counterfactual_run_id=run_id, universe_id=payload.universe_id,
        runner_id=payload.runner_id or payload.runner_kind, runner_kind=payload.runner_kind,
        direction_id=payload.direction_id or payload.direction_label, direction_label=payload.direction_label,
        declared_condition=payload.declared_condition or payload.direction_label, prompt_lineage=[], start_state_hash="external",
        end_state_hash="external", artifact_summary=payload.artifact_summary, diff_summary=payload.diff_summary,
        tool_trace_summary={}, command_trace_summary={}, detector_trace_ids=[], cost_trace=CostTrace(), latency_trace=LatencyTrace(),
        risk_trace=RiskTrace(), phenotype_vector=vector, novelty_vector=vector.to_dict(), proof_score=0, risk_score=0)


def _trace_from_record(value: Dict[str, Any]) -> BranchTrace:
    payload = dict(value)
    payload["cost_trace"] = CostTrace(**payload.get("cost_trace", {})); payload["latency_trace"] = LatencyTrace(**payload.get("latency_trace", {})); payload["risk_trace"] = RiskTrace(**payload.get("risk_trace", {})); payload["phenotype_vector"] = PhenotypeVector(**payload.get("phenotype_vector", {}))
    from .counterfactual_types import CounterfactualStrength, ExposureLevel, SelectionOutcome
    payload["exposure_level"] = ExposureLevel(payload.get("exposure_level", "generated")); payload["selection_outcome"] = SelectionOutcome(payload.get("selection_outcome", "unknown")); payload["counterfactual_strength"] = CounterfactualStrength(payload.get("counterfactual_strength", "none"))
    return BranchTrace(**payload)


def _detector_from_record(value: Dict[str, Any]) -> DetectorResult:
    return DetectorResult(**{**value, "detector_kind": DetectorKind(value["detector_kind"]), "status": DetectorStatus(value["status"])})


def _scene_from_record(value: Dict[str, Any]):
    from .counterfactual_types import ChoiceScene
    return ChoiceScene(**value)

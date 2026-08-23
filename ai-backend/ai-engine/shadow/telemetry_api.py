"""Public counterfactual control-plane API backed by durable workspace telemetry."""

from __future__ import annotations

import time
import uuid
import json
import subprocess
import os
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
from .policy_delta import make_policy_delta
from .counterfactual_types import PolicyDeltaKind
from .proof_arbiter import adjudicate_proof
from .runner_base import RunnerInvocation
from .codex_runner import CodexRunner
from .claude_code_runner import ClaudeCodeRunner
from .hermes_runner import HermesRunner
from .agent_execution import AgentContainerPolicy, docker_command
from .codesite_agent_workspace import CodeSiteExecutionBinding, create_codesite_agent_worktree, remove_codesite_agent_worktree
from .codesite_control_plane import verify_codesite_authority, record_codesite_writes
from .codesite_finalizer import finalize_codesite_worktree
from .workspace_write_policy import assert_protected_unchanged, protected_snapshot, provision_agent_write_access
from .live_workspace_lock import live_workspace_lock

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


class PolicyContradictionRequest(BaseModel):
    workspace_path: str
    reason: str = Field(min_length=1, max_length=500)


class MutationTrialRequest(BaseModel):
    workspace_path: str
    task_class: str
    violated_policy: str
    why_now: str
    stricter_detectors: List[DetectorKind] = Field(min_length=1)
    quarantine_policy: str
    budget_cap_usd: float = Field(gt=0, le=1000)
    auto_apply_allowed: Literal[False] = False


class MutationTrialResultRequest(BaseModel):
    workspace_path: str
    detector_results: List[DetectorRequest] = Field(min_length=1, max_length=50)


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


class RunnerExecutionRequest(BaseModel):
    runner_kind: Literal["codex", "claude_code", "hermes"]
    universe_id: str
    direction_id: str
    direction_label: str
    declared_condition: str
    task_summary: str = Field(min_length=1, max_length=4_000)
    policy_hints: List[str] = Field(default_factory=list, max_length=5)
    timeout_seconds: int = Field(default=300, ge=1, le=3600)
    budget_usd: float = Field(gt=0, le=1000)
    workspace_mode: Literal["live", "isolated", "codesite_overlay"] = "live"
    codesite_workspace_slug: Optional[str] = None
    codesite_project_id: Optional[str] = None
    codesite_agent_session_id: Optional[str] = None
    codesite_mutation_lease_id: Optional[str] = None
    codesite_transaction_id: Optional[str] = None
    codesite_base_commit: Optional[str] = None
    codesite_agent_access_token: Optional[str] = Field(default=None, min_length=36, max_length=256)


class MutationTrialExecutionRequest(RunnerExecutionRequest):
    workspace_path: str


class CodeSiteFinalizeRequest(BaseModel):
    codesite_workspace_slug: str
    codesite_project_id: str
    codesite_agent_session_id: str
    codesite_mutation_lease_id: str
    codesite_transaction_id: str
    codesite_base_commit: str
    codesite_agent_access_token: str = Field(min_length=36, max_length=256)


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
    available = set(run.get("universes") or [])
    selected = payload.selected_universe_id
    arbiter = payload.arbiter_winner_universe_id
    if selected is not None and selected not in available:
        raise HTTPException(status_code=422, detail="selected universe is not part of this run")
    if arbiter is not None and arbiter not in available:
        raise HTTPException(status_code=422, detail="Arbiter recommendation is not part of this run")
    unknown_visible = set(payload.visible_universe_ids) - available
    unknown_opened = (set(payload.opened_diff_universe_ids) | set(payload.opened_explanation_universe_ids)) - set(payload.visible_universe_ids)
    if unknown_visible or unknown_opened:
        raise HTTPException(status_code=422, detail="ChoiceScene exposure must reference visible universes from this run")
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
    detector_records = repo._read()["detectors"]
    detector_results = [_detector_from_record(item) for item in detector_records.values() if item.get("branch_trace_id") in {trace.id for trace in annotated}]
    proof = adjudicate_proof(annotated, detector_results)
    eligible = set(proof.eligible_universe_ids)
    # Proof is a hard gate, including for an externally captured selection.
    # Never let novelty or a human override promote a failed or unevidenced
    # branch into learned policy.
    lessons = []
    if choice.selected_universe_id in eligible and choice.arbiter_recommendation in eligible:
        lessons = extract_regret_lessons(choice_scene=choice, traces=annotated, workspace_id=str(repo.repo))[:payload.max_deltas]
    stored = repo.put_policy_deltas([lesson.policy_delta.to_dict() for lesson in lessons])
    for trace in annotated:
        matching = [item for item in detector_results if item.branch_trace_id == trace.id]
        repo.put_branch(trace.to_dict())
        repo.put_fossil(fossilize(trace=trace, detectors=matching, workspace_id=str(repo.repo), task_class=choice.task_class,
            inferred_lessons=[lesson.text for lesson in lessons if trace.id in lesson.policy_delta.evidence_refs], retention_days=repo.retention()["fossil_days"]).to_dict())
    return {"policy_deltas": stored, "learned_lines": [lesson.text for lesson in lessons], "proof_verdict": proof.to_dict(), "execution_niche_map": repo.niche_map(choice.task_class)}


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


@router.post("/policy-deltas/{delta_id}/contradict")
def contradict_policy_delta(delta_id: str, payload: PolicyContradictionRequest) -> Dict[str, Any]:
    repo = _repo(payload.workspace_path)
    if not repo.contradict_policy_delta(delta_id, reason=payload.reason):
        raise HTTPException(status_code=404, detail="active policy delta not found")
    return {"contradicted": True, "execution_niche_map": repo.niche_map("unknown")}


@router.delete("/telemetry")
def delete_workspace_telemetry(workspace_path: str) -> Dict[str, Any]:
    repo = _repo(workspace_path)
    repo.delete_all()
    return {"deleted": True, "enabled": repo.is_enabled(), "retention": repo.retention()}


@router.get("/policy-deltas")
def list_policy_deltas(workspace_path: str, task_class: Optional[str] = None) -> Dict[str, Any]:
    repo = _repo(workspace_path)
    return {"policy_deltas": repo.list_policy_deltas(task_class=task_class, active_only=True)}


@router.get("/inspection")
def inspect_telemetry(workspace_path: str, task_class: Optional[str] = None, limit: int = 50) -> Dict[str, Any]:
    repo = _repo(workspace_path)
    return {"telemetry_enabled": repo.is_enabled(), "inspection": repo.inspection(task_class=task_class, limit=limit)}


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


@router.post("/mutation-trials/{trial_id}/results")
def record_mutation_trial_result(trial_id: str, payload: MutationTrialResultRequest) -> Dict[str, Any]:
    repo = _repo(payload.workspace_path)
    data = repo._read()
    trial = data["mutation_trials"].get(trial_id)
    if not trial:
        raise HTTPException(status_code=404, detail="mutation trial not found")
    required = set(trial.get("stricter_detectors") or [])
    results = payload.detector_results
    passed = {item.detector_kind.value for item in results if item.status.value == "passed"}
    failed = [item.detector_kind.value for item in results if item.status.value == "failed"]
    if failed or not required.issubset(passed):
        status, result = "failed", "stricter proof did not pass"
    else:
        status, result = "passed", "stricter proof passed; manual selection remains required"
    trial.update({"status": status, "result": result, "auto_apply_allowed": False})
    data["mutation_trials"][trial_id] = trial
    repo._write(data)
    return {"mutation_trial": trial}


@router.post("/mutation-trials/{trial_id}/execute", status_code=201)
def execute_mutation_trial(trial_id: str, payload: MutationTrialExecutionRequest) -> Dict[str, Any]:
    """Run a quarantined trial through the same isolated adapter path.

    A successful runner process is deliberately not a selected branch. The
    trial remains ``running`` until every declared stricter detector is
    recorded through the results endpoint, and it can never auto-apply.
    """
    repo = _repo(payload.workspace_path)
    trial = repo._read()["mutation_trials"].get(trial_id)
    if not trial:
        raise HTTPException(status_code=404, detail="mutation trial not found")
    if trial.get("status") not in {"planned", "failed", "cancelled"}:
        raise HTTPException(status_code=409, detail="mutation trial is already running or complete")
    if payload.budget_usd > float(trial.get("budget_cap_usd") or 0):
        raise HTTPException(status_code=422, detail="mutation trial budget exceeds its quarantine cap")
    execution = RunnerExecutionRequest(**{**payload.model_dump(exclude={"workspace_path"}), "workspace_mode": "isolated"})
    result = execute_external_runner(str(trial["counterfactual_run_id"]), execution, payload.workspace_path)
    data = repo._read()
    data["mutation_trials"][trial_id].update({
        "status": "running", "result": "runner completed in quarantine; stricter proof pending",
        "branch_trace_id": result["branch_trace"]["id"], "auto_apply_allowed": False,
    })
    repo._write(data)
    return {"mutation_trial": data["mutation_trials"][trial_id], **result}


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
    retention_deltas = []
    if mutation.abstraction_removed or mutation.retention_score <= 0.1:
        delta = make_policy_delta(
            run_id=run_id, workspace_id=str(repo.repo), task_class=str(run.get("task_class") or "unknown"),
            delta_kind=PolicyDeltaKind.PROMPT_HINT_CHANGE,
            before="allow unproven abstraction breadth for similar task class",
            after="require repeated evidence before introducing broad abstractions for similar task class",
            confidence="high" if mutation.abstraction_removed else "medium",
            evidence_refs=[payload.selected_branch_id, f"post_selection_mutation:{run_id}"],
        )
        retention_deltas = repo.put_policy_deltas([delta.to_dict()])
    return {"post_selection_mutation": mutation.to_dict(), "policy_deltas": retention_deltas}


@router.post("/runs/{run_id}/execute", status_code=201)
def execute_external_runner(run_id: str, payload: RunnerExecutionRequest, workspace_path: str) -> Dict[str, Any]:
    """Execute a configured first-class runner in an existing run chamber.

    The command is constructed server-side for Codex or Claude Code. Callers
    cannot supply arbitrary executables or shell fragments.
    """
    repo = _repo(workspace_path)
    run = repo.get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="counterfactual run not found")
    if payload.universe_id not in set(run.get("universes") or []):
        raise HTTPException(status_code=422, detail="runner universe is not part of this run")
    invocation = RunnerInvocation(
        run_id=run_id, universe_id=payload.universe_id, runner_id=payload.runner_kind,
        direction_id=payload.direction_id, direction_label=payload.direction_label,
        declared_condition=payload.declared_condition,
        start_state_hash=str(run.get("base_state", {}).get("state_hash") or "external"),
        task_summary=payload.task_summary, policy_hints=payload.policy_hints,
        timeout_seconds=payload.timeout_seconds, budget_usd=payload.budget_usd,
    )
    adapters = {
        "codex": CodexRunner,
        "claude_code": ClaudeCodeRunner,
        "hermes": HermesRunner,
    }
    adapter = adapters[payload.runner_kind]()
    try:
        if payload.workspace_mode == "live":
            with live_workspace_lock(repo.repo):
                before_protected = protected_snapshot(repo.repo)
                container_policy = AgentContainerPolicy.from_environment()
                provision_agent_write_access(repo.repo, shared_gid=container_policy.shared_workspace_gid)
                if payload.runner_kind == "codex":
                    runner_command = adapter.live_command_for(invocation=invocation)
                else:
                    runner_command = adapter.command_for(invocation=invocation)
                command = docker_command(
                    workspace=repo.repo, run_id=invocation.run_id,
                    runner_command=runner_command, policy=container_policy,
                )
                artifact = adapter.run(workspace_path=repo.repo, artifact_root=repo.repo, invocation=invocation, command=command)
                assert_protected_unchanged(
                    before_protected,
                    repo.repo,
                    allowed_paths=[f".vectant/runner-artifacts/{invocation.run_id}/{adapter.runner_kind}-{invocation.universe_id}.json"],
                )
                diff = adapter.collect_diff(repo.repo, invocation.start_state_hash)
        elif payload.workspace_mode == "codesite_overlay":
            binding = _codesite_execution_binding(payload)
            container_policy = AgentContainerPolicy.from_environment()
            if not container_policy.codesite_overlay_root:
                raise ValueError("SYNTHI_CODESITE_AGENT_OVERLAY_ROOT must be configured for CodeSite execution")
            if not container_policy.codesite_control_plane_url:
                raise ValueError("SYNTHI_CODESITE_CONTROL_PLANE_URL must be configured for CodeSite execution")
            if _git_head(repo.repo) != binding.base_commit:
                raise PermissionError("CodeSite base commit is stale; open a new transaction before execution")
            verify_codesite_authority(
                control_plane_url=container_policy.codesite_control_plane_url,
                agent_access_token=str(payload.codesite_agent_access_token or ""),
                binding=binding,
            )
            worktree = create_codesite_agent_worktree(
                source_workspace=repo.repo,
                overlay_root=Path(container_policy.codesite_overlay_root),
                binding=binding,
            )
            try:
                before_protected = protected_snapshot(worktree.path)
                provision_agent_write_access(worktree.path, shared_gid=container_policy.shared_workspace_gid)
                runner_command = adapter.live_command_for(invocation=invocation) if payload.runner_kind == "codex" else adapter.command_for(invocation=invocation)
                command = docker_command(
                    workspace=worktree.path, run_id=invocation.run_id,
                    runner_command=runner_command, policy=container_policy,
                    codesite_binding=binding,
                )
                artifact = adapter.run(workspace_path=worktree.path, artifact_root=repo.repo, invocation=invocation, command=command)
                assert_protected_unchanged(before_protected, worktree.path)
                diff = adapter.collect_diff(worktree.path, binding.base_commit)
                record_codesite_writes(
                    control_plane_url=container_policy.codesite_control_plane_url,
                    agent_access_token=str(payload.codesite_agent_access_token or ""),
                    binding=binding, paths=diff["changed_paths"],
                )
                artifact.tool_summary["codesite"] = {
                    "workspace_slug": binding.workspace_slug,
                    "project_id": binding.project_id,
                    "agent_session_id": binding.agent_session_id,
                    "mutation_lease_id": binding.mutation_lease_id,
                    "transaction_id": binding.transaction_id,
                    "overlay_id": binding.overlay_id,
                    "base_commit": binding.base_commit,
                }
            except Exception:
                remove_codesite_agent_worktree(worktree)
                raise
        else:
            # Isolated execution remains available for counterfactual trials.
            with adapter.isolated_chamber(repo.repo, invocation) as chamber:
                if payload.runner_kind == "codex":
                    # Codex receives only chamber-local schema/output paths.
                    # This keeps workspace-write sandboxing inside the
                    # disposable chamber while the base adapter separately
                    # captures a bounded raw log by reference in the source
                    # workspace.
                    schema_path = chamber / ".vectant-branch-summary.schema.json"
                    output_path = chamber / ".vectant-branch-summary.json"
                    schema_path.write_text(json.dumps(_codex_output_schema()), encoding="utf-8")
                    command = adapter.command_for(invocation=invocation, output_schema=schema_path, output_path=output_path)
                else:
                    command = adapter.command_for(invocation=invocation)
                artifact = adapter.run(workspace_path=chamber, artifact_root=repo.repo, invocation=invocation, command=command)
                diff = adapter.collect_diff(chamber, invocation.start_state_hash)
        # The server-created invocation remains the authoritative budget
        # record even if an adapter has no provider usage report yet.
        artifact.cost_estimated_usd = payload.budget_usd
    except PermissionError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except OSError as error:
        raise HTTPException(status_code=503, detail=f"{payload.runner_kind} runner is unavailable: {error}") from error
    except (RuntimeError, ValueError) as error:
        raise HTTPException(status_code=422, detail=f"runner chamber could not be prepared: {error}") from error
    artifact.end_state_hash = str(diff["end_state_hash"])
    artifact.diff_summary = diff
    trace = adapter.collect_trace(invocation, artifact)
    try:
        repo.put_branch(trace.to_dict())
    except KeyError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    return {"branch_trace": trace.to_dict(), "detector_inputs": adapter.collect_detector_inputs(artifact)}


@router.post("/runs/{run_id}/codesite-finalize", status_code=201)
def finalize_codesite_runner(run_id: str, payload: CodeSiteFinalizeRequest, workspace_path: str) -> Dict[str, Any]:
    repo = _repo(workspace_path)
    if not repo.get_run(run_id):
        raise HTTPException(status_code=404, detail="counterfactual run not found")
    binding = _codesite_execution_binding(payload)
    try:
        policy = AgentContainerPolicy.from_environment()
        if not policy.codesite_overlay_root or not policy.codesite_control_plane_url:
            raise ValueError("CodeSite overlay root and control plane URL must be configured")
        authority = verify_codesite_authority(
            control_plane_url=policy.codesite_control_plane_url,
            agent_access_token=payload.codesite_agent_access_token,
            binding=binding,
        )
        from .codesite_agent_workspace import CodeSiteAgentWorktree
        worktree = CodeSiteAgentWorktree(Path(policy.codesite_overlay_root).resolve(), repo.repo, binding)
        if not worktree.path.is_dir():
            raise ValueError("CodeSite agent overlay is unavailable")
        command = _codesite_finalizer_command()
        # Agent execution is concurrent; only the final source-workspace
        # promotion is serialized.  Re-checks inside the finalizer make a
        # stale overlay fail closed after it waits for an earlier landing.
        with live_workspace_lock(repo.repo):
            paths = finalize_codesite_worktree(
                source_workspace=repo.repo, worktree=worktree, binding=binding,
                allowed_paths=authority.allowed_paths, test_command=command,
            )
        remove_codesite_agent_worktree(worktree)
        return {"status": "landed", "transaction_id": binding.transaction_id, "changed_paths": paths}
    except PermissionError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except (RuntimeError, ValueError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


def _codesite_finalizer_command() -> list[str]:
    raw = os.environ.get("SYNTHI_CODESITE_FINALIZER_COMMAND", "").strip()
    if not raw:
        raise ValueError("SYNTHI_CODESITE_FINALIZER_COMMAND must be configured")
    try:
        command = json.loads(raw)
    except json.JSONDecodeError as error:
        raise ValueError("SYNTHI_CODESITE_FINALIZER_COMMAND must be a JSON argv array") from error
    if not isinstance(command, list) or not command or any(not isinstance(item, str) or not item for item in command):
        raise ValueError("SYNTHI_CODESITE_FINALIZER_COMMAND must be a non-empty JSON argv array")
    return command


def _codesite_execution_binding(payload: RunnerExecutionRequest) -> CodeSiteExecutionBinding:
    fields = {
        "workspace_slug": payload.codesite_workspace_slug,
        "project_id": payload.codesite_project_id,
        "agent_session_id": payload.codesite_agent_session_id,
        "mutation_lease_id": payload.codesite_mutation_lease_id,
        "transaction_id": payload.codesite_transaction_id,
        "base_commit": payload.codesite_base_commit,
    }
    if any(not isinstance(value, str) or not value.strip() for value in fields.values()):
        raise ValueError("complete CodeSite execution binding is required")
    return CodeSiteExecutionBinding(**{key: str(value).strip() for key, value in fields.items()})


def _git_head(workspace: Path) -> str:
    completed = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=workspace, shell=False, check=False,
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=10,
    )
    if completed.returncode != 0:
        raise ValueError("CodeSite execution requires a committed Git base")
    return completed.stdout.strip()


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


def _codex_output_schema() -> Dict[str, Any]:
    return {"type": "object", "additionalProperties": False, "properties": {
        "summary": {"type": "string"}, "rationale": {"type": "string"},
        "files_changed": {"type": "array", "items": {"type": "string"}},
        "tests_run": {"type": "array", "items": {"type": "string"}},
    }, "required": ["summary", "rationale", "files_changed", "tests_run"]}

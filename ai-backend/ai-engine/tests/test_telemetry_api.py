from fastapi import FastAPI
from fastapi.testclient import TestClient
import subprocess
from contextlib import nullcontext
from types import SimpleNamespace
import json
import sys

from shadow.telemetry_api import router
from shadow.runner_base import RunnerArtifact
from shadow.agent_execution import AgentContainerPolicy


def test_counterfactual_control_plane_persists_a_choice_and_changes_forecast(tmp_path):
    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)
    workspace = str(tmp_path)

    created = client.post("/counterfactual/runs", json={
        "workspace_path": workspace,
        "request_id": "req-1",
        "task_class": "agent_feature",
        "base_state": {"repo": "fixture", "commit": "base"},
        "universe_plan": [
            {"id": "A", "direction": "conservative_local_repair", "runner_kind": "internal"},
            {"id": "B", "direction": "runtime_primitive", "runner_kind": "codex"},
        ],
    })
    assert created.status_code == 201
    run_id = created.json()["counterfactual_run"]["run_id"]

    for universe_id, loc, runtime_depth in (("A", 100, 0.1), ("B", 10, 0.9)):
        branch = client.post(f"/counterfactual/runs/{run_id}/branches", params={"workspace_path": workspace}, json={
            "universe_id": universe_id,
            "runner_kind": "internal",
            "direction_label": "local" if universe_id == "A" else "runtime",
            "artifact_summary": f"{universe_id} trace",
            "phenotype_vector": {"runtime_depth": runtime_depth},
            "diff_summary": {"loc_added": loc, "loc_removed": 0},
        })
        assert branch.status_code == 201
        branch_id = branch.json()["branch_trace"]["id"]
        detector = client.post(f"/counterfactual/branches/{branch_id}/detectors", params={"workspace_path": workspace}, json={
            "detector_kind": "unit_tests", "status": "passed", "score": 1,
            "evidence_summary": "fixture test passed",
        })
        assert detector.status_code == 201

    selected = client.post(f"/counterfactual/runs/{run_id}/selection", params={"workspace_path": workspace}, json={
        "selected_universe_id": "B", "arbiter_winner_universe_id": "A",
        "visible_universe_ids": ["A", "B"], "opened_diff_universe_ids": ["A", "B"],
        "selection_action": "applied",
    })
    assert selected.status_code == 201

    deltas = client.post(f"/counterfactual/runs/{run_id}/policy-deltas", params={"workspace_path": workspace}, json={})
    assert deltas.status_code == 201
    assert {delta["delta_kind"] for delta in deltas.json()["policy_deltas"]} == {
        "arbiter_weight_change", "universe_direction_change",
    }
    assert deltas.json()["execution_niche_map"]["runtime_depth_preference"] == "raise_runtime_primitive"

    forecast = client.post("/counterfactual/forecast/directions", json={
        "workspace_path": workspace, "task_class": "agent_feature", "request_summary": "add infrastructure",
        "budget": {"max_universes": 3, "max_cost_usd": 0.1},
    })
    assert forecast.status_code == 200
    runtime = next(item for item in forecast.json()["directions"] if item["label"] == "runtime_primitive")
    assert runtime["selection_fit_estimate"] == "high"

    delta_id = deltas.json()["policy_deltas"][0]["id"]
    removed = client.delete(f"/counterfactual/policy-deltas/{delta_id}", params={"workspace_path": workspace})
    assert removed.status_code == 200


def test_counterfactual_controls_disable_persistence_and_mutation_trials_are_quarantined(tmp_path):
    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)
    workspace = str(tmp_path)
    controls = client.put("/counterfactual/controls", json={"workspace_path": workspace, "enabled": False, "fossil_days": 30})
    assert controls.status_code == 200
    assert controls.json() == {"enabled": False, "retention": {"fossil_days": 30, "raw_trace_days": 30}}

    enabled = client.put("/counterfactual/controls", json={"workspace_path": workspace, "enabled": True})
    assert enabled.status_code == 200

    run = client.post("/counterfactual/runs", json={
        "workspace_path": workspace, "request_id": "req-2", "task_class": "fix",
        "base_state": {}, "universe_plan": [{"id": "A"}],
    })
    assert run.status_code == 201
    run_id = run.json()["counterfactual_run"]["run_id"]
    trial = client.post(f"/counterfactual/runs/{run_id}/mutation-trials", json={
        "workspace_path": workspace, "task_class": "fix", "violated_policy": "small diff",
        "why_now": "repeated evidence", "stricter_detectors": ["unit_tests"],
        "quarantine_policy": "manual review", "budget_cap_usd": 0.1, "auto_apply_allowed": False,
    })
    assert trial.status_code == 201
    assert trial.json()["mutation_trial"]["auto_apply_allowed"] is False


def test_control_plane_records_post_apply_retention_without_storing_source(tmp_path):
    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)
    workspace = str(tmp_path)
    run = client.post("/counterfactual/runs", json={
        "workspace_path": workspace, "request_id": "req-mutation", "task_class": "fix",
        "base_state": {}, "universe_plan": [{"id": "A"}],
    })
    run_id = run.json()["counterfactual_run"]["run_id"]

    response = client.post(f"/counterfactual/runs/{run_id}/post-selection-mutation", params={"workspace_path": workspace}, json={
        "selected_branch_id": f"br_{run_id}_A", "observation_window": "24h",
        "files": [{"path": "app.py", "generated_content": "class Generated: pass", "observed_content": ""}],
        "abstraction_removed": True,
    })

    assert response.status_code == 201, response.text
    mutation = response.json()["post_selection_mutation"]
    assert mutation["retention_score"] == 0
    assert "class Generated" not in str(mutation)
    assert response.json()["policy_deltas"][0]["delta_kind"] == "prompt_hint_change"


def test_control_plane_executes_only_server_constructed_runner_contract(tmp_path, monkeypatch):
    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)
    workspace = str(tmp_path)
    subprocess.run(["git", "init"], cwd=workspace, check=True, capture_output=True)
    subprocess.run(["git", "config", "user.email", "tests@example.invalid"], cwd=workspace, check=True)
    subprocess.run(["git", "config", "user.name", "Vectant Tests"], cwd=workspace, check=True)
    (tmp_path / "README.md").write_text("fixture\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=workspace, check=True)
    subprocess.run(["git", "commit", "-m", "fixture"], cwd=workspace, check=True, capture_output=True)
    run = client.post("/counterfactual/runs", json={
        "workspace_path": workspace, "request_id": "req-runner", "task_class": "fix",
        "base_state": {"state_hash": "base"}, "universe_plan": [{"id": "A"}],
    })
    run_id = run.json()["counterfactual_run"]["run_id"]
    observed = {}

    def fake_run(self, *, workspace_path, invocation, command, artifact_root=None):
        observed["command"] = command
        observed["workspace_path"] = workspace_path
        return RunnerArtifact(artifact_summary="runner completed", raw_log_ref=".vectant/runner-artifacts/log.json")

    monkeypatch.setattr("shadow.telemetry_api.CodexRunner.run", fake_run)
    response = client.post(f"/counterfactual/runs/{run_id}/execute", params={"workspace_path": workspace}, json={
        "runner_kind": "codex", "universe_id": "A", "direction_id": "safe", "direction_label": "safe",
        "declared_condition": "conservative repair", "task_summary": "fix the issue", "budget_usd": 0.1,
        "workspace_mode": "isolated",
    })

    assert response.status_code == 201
    assert observed["command"][:4] == ["codex", "exec", "--sandbox", "workspace-write"]
    assert observed["workspace_path"] != tmp_path
    assert response.json()["branch_trace"]["runner_kind"] == "codex"
    assert response.json()["branch_trace"]["cost_trace"]["estimated_usd"] == 0.1


def test_live_runner_allows_only_its_controller_artifact(tmp_path, monkeypatch):
    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)
    workspace = str(tmp_path)
    subprocess.run(["git", "init"], cwd=workspace, check=True, capture_output=True)
    subprocess.run(["git", "config", "user.email", "tests@example.invalid"], cwd=workspace, check=True)
    subprocess.run(["git", "config", "user.name", "Vectant Tests"], cwd=workspace, check=True)
    (tmp_path / "README.md").write_text("fixture\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=workspace, check=True)
    subprocess.run(["git", "commit", "-m", "fixture"], cwd=workspace, check=True, capture_output=True)
    run_id = client.post("/counterfactual/runs", json={
        "workspace_path": workspace, "request_id": "live-runner", "task_class": "fix",
        "base_state": {"state_hash": "base"}, "universe_plan": [{"id": "A"}],
    }).json()["counterfactual_run"]["run_id"]

    monkeypatch.setattr("shadow.telemetry_api.provision_agent_write_access", lambda *args, **kwargs: None)
    monkeypatch.setattr("shadow.telemetry_api.live_workspace_lock", lambda *args, **kwargs: nullcontext())
    monkeypatch.setattr("shadow.telemetry_api.AgentContainerPolicy.from_environment", lambda: AgentContainerPolicy(image="runner", network="isolated", credentials_volume="credentials"))

    def fake_run(self, *, workspace_path, invocation, command, artifact_root=None):
        path = tmp_path / ".vectant" / "runner-artifacts" / invocation.run_id / "codex-A.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("redacted controller artifact", encoding="utf-8")
        return RunnerArtifact(artifact_summary="runner completed", raw_log_ref=str(path.relative_to(tmp_path)))

    monkeypatch.setattr("shadow.telemetry_api.CodexRunner.run", fake_run)
    response = client.post(f"/counterfactual/runs/{run_id}/execute", params={"workspace_path": workspace}, json={
        "runner_kind": "codex", "universe_id": "A", "direction_id": "safe", "direction_label": "safe",
        "declared_condition": "repair", "task_summary": "fix", "budget_usd": 0.1, "workspace_mode": "live",
    })

    assert response.status_code == 201


def test_codesite_overlay_runner_uses_an_isolated_worktree(tmp_path, monkeypatch):
    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    subprocess.run(["git", "init"], cwd=workspace, check=True, capture_output=True)
    subprocess.run(["git", "config", "user.email", "tests@example.invalid"], cwd=workspace, check=True)
    subprocess.run(["git", "config", "user.name", "Vectant Tests"], cwd=workspace, check=True)
    (workspace / "README.md").write_text("base\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=workspace, check=True)
    subprocess.run(["git", "commit", "-m", "fixture"], cwd=workspace, check=True, capture_output=True)
    base_commit = subprocess.run(["git", "rev-parse", "HEAD"], cwd=workspace, check=True, capture_output=True, text=True).stdout.strip()
    overlay_root = tmp_path / "overlays"
    overlay_root.mkdir()
    run_id = client.post("/counterfactual/runs", json={
        "workspace_path": str(workspace), "request_id": "codesite-runner", "task_class": "fix",
        "base_state": {"state_hash": "base"}, "universe_plan": [{"id": "A"}],
    }).json()["counterfactual_run"]["run_id"]

    monkeypatch.setattr("shadow.telemetry_api.verify_codesite_authority", lambda **kwargs: SimpleNamespace(allowed_paths=("**",)))
    monkeypatch.setattr("shadow.telemetry_api.record_codesite_writes", lambda **kwargs: None)
    monkeypatch.setattr("shadow.telemetry_api.provision_agent_write_access", lambda *args, **kwargs: None)
    monkeypatch.setattr("shadow.telemetry_api.AgentContainerPolicy.from_environment", lambda: AgentContainerPolicy(
        image="runner", network="isolated", credentials_volume="credentials",
        codesite_overlay_root=str(overlay_root), codesite_control_plane_url="https://codesite.example.test",
    ))

    def fake_run(self, *, workspace_path, invocation, command, artifact_root=None):
        (workspace_path / "agent-created.txt").write_text("isolated\n", encoding="utf-8")
        return RunnerArtifact(artifact_summary="runner completed", raw_log_ref="runner-artifacts/log.json")

    monkeypatch.setattr("shadow.telemetry_api.CodexRunner.run", fake_run)
    response = client.post(f"/counterfactual/runs/{run_id}/execute", params={"workspace_path": str(workspace)}, json={
        "runner_kind": "codex", "universe_id": "A", "direction_id": "safe", "direction_label": "safe",
        "declared_condition": "repair", "task_summary": "fix", "budget_usd": 0.1,
        "workspace_mode": "codesite_overlay", "codesite_workspace_slug": "demo",
        "codesite_project_id": "project-1", "codesite_agent_session_id": "agent-1",
        "codesite_mutation_lease_id": "lease-1", "codesite_transaction_id": "txn-1",
        "codesite_base_commit": base_commit, "codesite_agent_access_token": "csa_" + "a" * 32,
    })

    assert response.status_code == 201, response.text
    assert not (workspace / "agent-created.txt").exists()
    assert list(overlay_root.rglob("agent-created.txt")), "the retained CodeSite overlay must contain the agent change"
    monkeypatch.setenv("SYNTHI_CODESITE_FINALIZER_COMMAND", json.dumps([sys.executable, "-c", "pass"]))
    finalized = client.post(f"/counterfactual/runs/{run_id}/codesite-finalize", params={"workspace_path": str(workspace)}, json={
        "codesite_workspace_slug": "demo", "codesite_project_id": "project-1",
        "codesite_agent_session_id": "agent-1", "codesite_mutation_lease_id": "lease-1",
        "codesite_transaction_id": "txn-1", "codesite_base_commit": base_commit,
        "codesite_agent_access_token": "csa_" + "a" * 32,
    })
    assert finalized.status_code == 201, finalized.text
    assert (workspace / "agent-created.txt").read_text(encoding="utf-8") == "isolated\n"


def test_choice_scene_and_policy_extraction_require_real_exposure_and_proof(tmp_path):
    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)
    workspace = str(tmp_path)
    created = client.post("/counterfactual/runs", json={
        "workspace_path": workspace, "request_id": "req-proof", "task_class": "fix",
        "base_state": {}, "universe_plan": [{"id": "A"}, {"id": "B"}],
    })
    run_id = created.json()["counterfactual_run"]["run_id"]
    invalid = client.post(f"/counterfactual/runs/{run_id}/selection", params={"workspace_path": workspace}, json={
        "selected_universe_id": "A", "arbiter_winner_universe_id": "B", "visible_universe_ids": ["A", "unknown"],
        "opened_diff_universe_ids": ["A"], "selection_action": "applied",
    })
    assert invalid.status_code == 422

    for universe_id, runtime_depth in (("A", 0.1), ("B", 0.9)):
        response = client.post(f"/counterfactual/runs/{run_id}/branches", params={"workspace_path": workspace}, json={
            "universe_id": universe_id, "runner_kind": "internal", "direction_label": universe_id,
            "artifact_summary": "compact", "phenotype_vector": {"runtime_depth": runtime_depth},
            "diff_summary": {"loc_added": 10 if universe_id == "A" else 2},
        })
        assert response.status_code == 201
    selection = client.post(f"/counterfactual/runs/{run_id}/selection", params={"workspace_path": workspace}, json={
        "selected_universe_id": "B", "arbiter_winner_universe_id": "A", "visible_universe_ids": ["A", "B"],
        "opened_diff_universe_ids": ["A", "B"], "selection_action": "applied",
    })
    assert selection.status_code == 201
    unproven = client.post(f"/counterfactual/runs/{run_id}/policy-deltas", params={"workspace_path": workspace}, json={})
    assert unproven.status_code == 201
    assert unproven.json()["policy_deltas"] == []
    assert set(unproven.json()["proof_verdict"]["blocked_universe_ids"]) == {"A", "B"}


def test_inspection_is_compact_and_mutation_trial_needs_all_stricter_proof(tmp_path):
    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)
    workspace = str(tmp_path)
    created = client.post("/counterfactual/runs", json={
        "workspace_path": workspace, "request_id": "req-inspection", "task_class": "fix",
        "base_state": {}, "universe_plan": [{"id": "A"}],
    })
    run_id = created.json()["counterfactual_run"]["run_id"]
    trial = client.post(f"/counterfactual/runs/{run_id}/mutation-trials", json={
        "workspace_path": workspace, "task_class": "fix", "violated_policy": "small patch",
        "why_now": "prior compact repairs failed", "stricter_detectors": ["unit_tests", "security_scan"],
        "quarantine_policy": "manual review", "budget_cap_usd": 0.1,
    }).json()["mutation_trial"]
    failed = client.post(f"/counterfactual/mutation-trials/{trial['id']}/results", json={
        "workspace_path": workspace,
        "detector_results": [{"detector_kind": "unit_tests", "status": "passed", "score": 1, "evidence_summary": "ok"}],
    })
    assert failed.status_code == 200
    assert failed.json()["mutation_trial"]["status"] == "failed"
    assert failed.json()["mutation_trial"]["auto_apply_allowed"] is False
    inspected = client.get("/counterfactual/inspection", params={"workspace_path": workspace, "task_class": "fix"})
    assert inspected.status_code == 200
    assert inspected.json()["inspection"]["runs"][0]["run_id"] == run_id
    assert inspected.json()["inspection"]["mutation_trials"][0]["result"] == "stricter proof did not pass"


def test_delete_workspace_telemetry_removes_compact_memory_and_runner_artifacts(tmp_path):
    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)
    workspace = str(tmp_path)
    run = client.post("/counterfactual/runs", json={
        "workspace_path": workspace, "request_id": "req-delete", "task_class": "fix",
        "base_state": {}, "universe_plan": [{"id": "A"}],
    })
    assert run.status_code == 201
    artifact = tmp_path / ".vectant" / "runner-artifacts" / "run" / "trace.json"
    artifact.parent.mkdir(parents=True)
    artifact.write_text("bounded raw log", encoding="utf-8")

    deleted = client.delete("/counterfactual/telemetry", params={"workspace_path": workspace})

    assert deleted.status_code == 200
    assert not artifact.exists()
    inspection = client.get("/counterfactual/inspection", params={"workspace_path": workspace})
    assert inspection.json()["inspection"]["runs"] == []


def test_mutation_trial_runs_only_in_quarantine_and_respects_its_budget(tmp_path, monkeypatch):
    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)
    workspace = str(tmp_path)
    subprocess.run(["git", "init"], cwd=workspace, check=True, capture_output=True)
    subprocess.run(["git", "config", "user.email", "tests@example.invalid"], cwd=workspace, check=True)
    subprocess.run(["git", "config", "user.name", "Vectant Tests"], cwd=workspace, check=True)
    (tmp_path / "README.md").write_text("fixture\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=workspace, check=True)
    subprocess.run(["git", "commit", "-m", "fixture"], cwd=workspace, check=True, capture_output=True)
    run_id = client.post("/counterfactual/runs", json={
        "workspace_path": workspace, "request_id": "req-trial", "task_class": "fix",
        "base_state": {"state_hash": "base"}, "universe_plan": [{"id": "A"}],
    }).json()["counterfactual_run"]["run_id"]
    trial = client.post(f"/counterfactual/runs/{run_id}/mutation-trials", json={
        "workspace_path": workspace, "task_class": "fix", "violated_policy": "small patch",
        "why_now": "repeat evidence", "stricter_detectors": ["unit_tests"],
        "quarantine_policy": "manual review", "budget_cap_usd": 0.1,
    }).json()["mutation_trial"]
    monkeypatch.setattr("shadow.telemetry_api.CodexRunner.run", lambda self, **kwargs: RunnerArtifact(artifact_summary="quarantined"))
    over_cap = client.post(f"/counterfactual/mutation-trials/{trial['id']}/execute", json={
        "workspace_path": workspace, "runner_kind": "codex", "universe_id": "A", "direction_id": "trial",
        "direction_label": "trial", "declared_condition": "quarantined", "task_summary": "test", "budget_usd": 0.2,
    })
    assert over_cap.status_code == 422
    executed = client.post(f"/counterfactual/mutation-trials/{trial['id']}/execute", json={
        "workspace_path": workspace, "runner_kind": "codex", "universe_id": "A", "direction_id": "trial",
        "direction_label": "trial", "declared_condition": "quarantined", "task_summary": "test", "budget_usd": 0.1,
    })
    assert executed.status_code == 201
    assert executed.json()["mutation_trial"]["status"] == "running"
    assert executed.json()["mutation_trial"]["auto_apply_allowed"] is False


def test_contradicted_policy_is_removed_from_the_next_run_niche_map(tmp_path):
    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)
    workspace = str(tmp_path)
    created = client.post("/counterfactual/runs", json={
        "workspace_path": workspace, "request_id": "req-contradict", "task_class": "fix",
        "base_state": {}, "universe_plan": [{"id": "A"}, {"id": "B"}],
    })
    run_id = created.json()["counterfactual_run"]["run_id"]
    for universe_id, depth in (("A", 0.1), ("B", 0.9)):
        trace = client.post(f"/counterfactual/runs/{run_id}/branches", params={"workspace_path": workspace}, json={
            "universe_id": universe_id, "runner_kind": "internal", "direction_label": universe_id,
            "artifact_summary": "compact", "phenotype_vector": {"runtime_depth": depth}, "diff_summary": {"loc_added": 10 if universe_id == "A" else 2},
        }).json()["branch_trace"]
        client.post(f"/counterfactual/branches/{trace['id']}/detectors", params={"workspace_path": workspace}, json={
            "detector_kind": "unit_tests", "status": "passed", "score": 1, "evidence_summary": "passed",
        })
    client.post(f"/counterfactual/runs/{run_id}/selection", params={"workspace_path": workspace}, json={
        "selected_universe_id": "B", "arbiter_winner_universe_id": "A", "visible_universe_ids": ["A", "B"],
        "opened_diff_universe_ids": ["A", "B"], "selection_action": "applied",
    })
    deltas = client.post(f"/counterfactual/runs/{run_id}/policy-deltas", params={"workspace_path": workspace}, json={}).json()["policy_deltas"]
    runtime_delta = next(item for item in deltas if item["delta_kind"] == "universe_direction_change")
    contradicted = client.post(f"/counterfactual/policy-deltas/{runtime_delta['id']}/contradict", json={
        "workspace_path": workspace, "reason": "Later comparable selection chose a local repair.",
    })
    assert contradicted.status_code == 200
    policy = client.get("/counterfactual/policy-deltas", params={"workspace_path": workspace, "task_class": "fix"})
    assert runtime_delta["id"] not in {item["id"] for item in policy.json()["policy_deltas"]}
    forecast = client.post("/counterfactual/forecast/directions", json={
        "workspace_path": workspace, "task_class": "fix", "request_summary": "repair", "budget": {"max_universes": 3, "max_cost_usd": 0.1},
    })
    runtime = next(item for item in forecast.json()["directions"] if item["label"] == "runtime_primitive")
    assert runtime["selection_fit_estimate"] == "medium"


def test_durable_trace_storage_drops_raw_prompt_output_and_base_payload(tmp_path):
    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)
    workspace = str(tmp_path)
    source_marker = "SECRET_SOURCE_MARKER_DO_NOT_PERSIST"
    run_id = client.post("/counterfactual/runs", json={
        "workspace_path": workspace, "request_id": "req-private", "task_class": "fix",
        "base_state": {"commit": "base", "source": source_marker}, "universe_plan": [{"id": "A"}],
    }).json()["counterfactual_run"]["run_id"]
    branch = client.post(f"/counterfactual/runs/{run_id}/branches", params={"workspace_path": workspace}, json={
        "universe_id": "A", "runner_kind": "internal", "direction_label": "safe",
        "artifact_summary": source_marker, "diff_summary": {},
    })
    assert branch.status_code == 201
    persisted = (tmp_path / ".vectant" / "counterfactual-telemetry.json").read_text(encoding="utf-8")
    assert source_marker not in persisted

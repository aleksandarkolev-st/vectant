import asyncio
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import main
from analyzer.proactive.healing.failure_distiller import DistillationError, FailureDistiller
from analyzer.proactive.healing.failure_distiller_execution import ContainerExecutor, IsolationError
from analyzer.proactive.healing import failure_distiller_execution
from test_failure_distiller import request, workspace


def docker_ready():
    return bool(shutil.which("docker")) and subprocess.run(["docker", "info"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False).returncode == 0


def test_production_distillation_fails_closed_without_a_container_profile(workspace):
    with pytest.raises(DistillationError, match="container isolation profile is required"):
        asyncio.run(FailureDistiller(production=True).distill(request(workspace, [])))


def test_container_profile_rejects_package_install_and_escape_arguments():
    executor = ContainerExecutor("python:3.12-slim")
    with pytest.raises(IsolationError, match="package installation"):
        executor._validate_command(["pip", "install", "unsafe-package"])
    with pytest.raises(IsolationError, match="escape"):
        executor._validate_command(["docker", "run", "--privileged", "x"])


def test_production_distillation_refuses_an_unavailable_engine_before_repository_code_runs(workspace, monkeypatch):
    monkeypatch.setattr(failure_distiller_execution.shutil, "which", lambda _: None)
    payload = request(workspace, [])
    payload["isolation"] = {"mode": "container", "engine": "docker", "image": "python:3.12-slim"}
    with pytest.raises(DistillationError, match="isolation engine is unavailable"):
        asyncio.run(FailureDistiller(production=True).distill(payload))


@pytest.mark.skipif(not docker_ready(), reason="Docker daemon is required for isolated executor E2E")
def test_production_executor_distills_inside_a_network_denied_container(workspace):
    payload = request(workspace, [{"kind": "file", "reference": "unrelated.txt"}])
    payload["command"] = ["python", "runner.py"]
    payload["isolation"] = {"mode": "container", "engine": "docker", "image": "vectant-ade-ai-engine:latest"}
    result = asyncio.run(FailureDistiller(production=True).distill(payload))
    assert result["ok"], result
    assert result["reduction"]["removed_units"] == 1


@pytest.mark.skipif(not docker_ready(), reason="Docker daemon is required for authenticated isolated E2E")
def test_authenticated_api_distills_through_the_production_container(workspace, monkeypatch):
    from analyzer.proactive.healing import failure_distiller
    monkeypatch.setattr(main, "AI_ENGINE_AUTH_TOKEN", "isolated-distiller-test")
    monkeypatch.setattr(main, "AI_ENGINE_AUTH_DISABLED", False)
    monkeypatch.setattr(failure_distiller, "_failure_distiller", FailureDistiller(production=True))
    payload = request(workspace, [{"kind": "file", "reference": "unrelated.txt"}])
    payload["command"] = ["python", "runner.py"]
    payload["isolation"] = {"mode": "container", "engine": "docker", "image": "vectant-ade-ai-engine:latest"}
    with TestClient(main.app) as client:
        response = client.post("/heal/agentic/distill", json=payload, headers={"x-synthi-internal-token": "isolated-distiller-test"})
    assert response.status_code == 200, response.text
    assert response.json()["ok"] is True


@pytest.mark.skipif(not docker_ready(), reason="Docker daemon is required for browser adapter isolated E2E")
def test_taught_browser_contract_distills_through_production_container(workspace):
    payload = request(workspace, [{"kind": "file", "reference": "unrelated.txt"}])
    payload.update({
        "command": ["python", "runner.py"],
        "isolation": {"mode": "container", "engine": "docker", "image": "vectant-ade-ai-engine:latest"},
        "autoDiscover": True,
        "observation": {
            "kind": "browser", "viewport": {"width": 1280, "height": 720},
            "workflowContract": {
                "workflowId": "failure-flow", "appOrigin": "http://app.local", "routePattern": "/failure",
                "sourceIdentityCoverage": {"status": "complete", "linkedSteps": 1, "totalSteps": 1}, "replayModes": ["ciIsolated"],
                "steps": [{"stepId": "submit", "label": "Submit", "sourcePlan": {"status": "linked", "filePath": "runner.py", "line": 1}, "apiPlan": {"status": "observed", "method": "POST", "url": "/fail"}, "expectedEffects": ["failure shown"]}],
            },
        },
    })
    result = asyncio.run(FailureDistiller(production=True).distill(payload))
    assert result["ok"], result
    repro = (Path(result["workspace_path"]) / "repro.json").read_text(encoding="utf-8")
    assert '"workflow_id": "failure-flow"' in repro


@pytest.mark.skipif(not docker_ready(), reason="Docker daemon is required for adapter isolated E2E")
@pytest.mark.parametrize(("kind", "evidence", "needle"), [
    ("native", {"diagnostic": {"code": "E0425", "source_span": "runner.py:1:1"}, "executedPaths": ["runner.py"]}, "E0425"),
    ("hmr", {"hmrEvents": ["check", "applied"], "executedPaths": ["runner.py"]}, "applied"),
    ("gpu", {"deviceMarker": "software-adapter", "errorFingerprint": "GPU_TEST_FAILURE", "frameStates": ["frame-0", "frame-1-error"], "launchParameters": {"workgroups": 1}, "executedPaths": ["runner.py"]}, "GPU_TEST_FAILURE"),
])
def test_specialized_adapter_evidence_distills_through_production_container(workspace, kind, evidence, needle):
    payload = request(workspace, [{"kind": "file", "reference": "unrelated.txt"}])
    payload.update({"command": ["python", "runner.py"], "isolation": {"mode": "container", "engine": "docker", "image": "vectant-ade-ai-engine:latest"}, "autoDiscover": True, "observation": {"kind": kind, **evidence}})
    result = asyncio.run(FailureDistiller(production=True).distill(payload))
    assert result["ok"], result
    assert needle in (Path(result["workspace_path"]) / "repro.json").read_text(encoding="utf-8")

import asyncio
import shutil
import subprocess
import sys

import pytest

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

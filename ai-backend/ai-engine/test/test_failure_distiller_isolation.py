import asyncio
import sys

import pytest

from analyzer.proactive.healing.failure_distiller import DistillationError, FailureDistiller
from analyzer.proactive.healing.failure_distiller_execution import ContainerExecutor, IsolationError
from test_failure_distiller import request, workspace


def test_production_distillation_fails_closed_without_a_container_profile(workspace):
    with pytest.raises(DistillationError, match="container isolation profile is required"):
        asyncio.run(FailureDistiller(production=True).distill(request(workspace, [])))


def test_container_profile_rejects_package_install_and_escape_arguments():
    executor = ContainerExecutor("python:3.12-slim")
    with pytest.raises(IsolationError, match="package installation"):
        executor._validate_command(["pip", "install", "unsafe-package"])
    with pytest.raises(IsolationError, match="escape"):
        executor._validate_command(["docker", "run", "--privileged", "x"])


def test_production_distillation_refuses_an_unavailable_engine_before_repository_code_runs(workspace):
    payload = request(workspace, [])
    payload["isolation"] = {"mode": "container", "engine": "docker", "image": "python:3.12-slim"}
    with pytest.raises(DistillationError, match="isolation engine is not running"):
        asyncio.run(FailureDistiller(production=True).distill(payload))

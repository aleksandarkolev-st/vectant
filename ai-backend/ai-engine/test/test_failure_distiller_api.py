import sys

import pytest
from fastapi.testclient import TestClient

import main
from analyzer.proactive.healing import failure_distiller
from analyzer.proactive.healing.failure_distiller import FailureDistiller

from test_failure_distiller import git, request


@pytest.fixture(autouse=True)
def isolated_service_fixture(monkeypatch):
    """Inject the hermetic local executor only for HTTP route fixtures."""
    monkeypatch.setattr(failure_distiller, "_failure_distiller", FailureDistiller())


def test_authenticated_distill_and_vivarium_export_routes(tmp_path, monkeypatch):
    root = tmp_path / "repo"
    root.mkdir()
    git(root, "init")
    git(root, "config", "user.email", "test@example.com")
    git(root, "config", "user.name", "Test")
    (root / "runner.py").write_text(
        "import pathlib, sys\n"
        "if pathlib.Path('required.txt').exists():\n"
        " print('FailureSignature: api integration')\n"
        " sys.exit(7)\n",
        encoding="utf-8",
    )
    (root / "required.txt").write_text("required\n", encoding="utf-8")
    (root / "unrelated.txt").write_text("remove\n", encoding="utf-8")
    git(root, "add", ".")
    git(root, "commit", "-m", "fixture")
    monkeypatch.setattr(main, "AI_ENGINE_AUTH_TOKEN", "distiller-api-test")
    monkeypatch.setattr(main, "AI_ENGINE_AUTH_DISABLED", False)
    headers = {"x-synthi-internal-token": "distiller-api-test"}
    payload = request(root, [{"kind": "file", "reference": "unrelated.txt"}])
    payload["command"] = [sys.executable, "runner.py"]
    payload["signature"] = {"required": ["api integration"]}
    payload["budget"] = {"preset": "fast", "stability_attempts": 1, "minimum_matches": 1, "max_executions": 8}
    with TestClient(main.app) as client:
        distill = client.post("/heal/agentic/distill", json=payload, headers=headers)
        assert distill.status_code == 200, distill.text
        capsule = distill.json()
        assert capsule["ok"]
        exported = client.post("/heal/agentic/distill/vivarium-export", json={"capsulePath": capsule["workspacePath"]}, headers=headers)
        assert exported.status_code == 200, exported.text
        assert exported.json()["status"] == "vivarium_manifest_exported"


def test_authenticated_capsule_lifecycle_through_real_app_routes(tmp_path, monkeypatch):
    root = tmp_path / "repo"
    root.mkdir()
    git(root, "init")
    git(root, "config", "user.email", "test@example.com")
    git(root, "config", "user.name", "Test")
    (root / "runner.py").write_text(
        "import pathlib, sys\n"
        "if pathlib.Path('required.txt').exists():\n"
        " print('FailureSignature: full api lifecycle')\n"
        " sys.exit(7)\n",
        encoding="utf-8",
    )
    (root / "required.txt").write_text("required\n", encoding="utf-8")
    (root / "unrelated.txt").write_text("remove\n", encoding="utf-8")
    git(root, "add", ".")
    git(root, "commit", "-m", "fixture")
    monkeypatch.setattr(main, "AI_ENGINE_AUTH_TOKEN", "distiller-api-test")
    monkeypatch.setattr(main, "AI_ENGINE_AUTH_DISABLED", False)
    headers = {"x-synthi-internal-token": "distiller-api-test"}
    payload = request(root, [{"kind": "file", "reference": "unrelated.txt"}])
    payload.update({
        "command": [sys.executable, "runner.py"],
        "signature": {"required": ["full api lifecycle"]},
        "budget": {"preset": "fast", "stability_attempts": 1, "minimum_matches": 1, "max_executions": 8},
    })
    with TestClient(main.app) as client:
        distilled = client.post("/heal/agentic/distill", json=payload, headers=headers)
        assert distilled.status_code == 200, distilled.text
        capsule = distilled.json()
        capsule_path = capsule["workspacePath"]
        replay = client.post("/heal/agentic/distill/run", json={"capsulePath": capsule_path}, headers=headers)
        assert replay.status_code == 200 and replay.json()["status"] == "same_failure", replay.text
        materialized = client.post("/heal/agentic/distill/materialize", json={"capsulePath": capsule_path}, headers=headers)
        assert materialized.status_code == 200 and materialized.json()["status"] == "materialized", materialized.text
        materialized_replay = client.post("/heal/agentic/distill/run", json={"capsulePath": materialized.json()["workspacePath"]}, headers=headers)
        assert materialized_replay.status_code == 200 and materialized_replay.json()["status"] == "same_failure", materialized_replay.text
        exported = client.post("/heal/agentic/distill/vivarium-export", json={"capsulePath": capsule_path}, headers=headers)
        assert exported.status_code == 200 and exported.json()["ok"], exported.text
        validation = client.post("/heal/agentic/distill/validate-patch", json={
            "capsulePath": capsule_path,
            "edits": [{"path": "runner.py", "content": "print('fixed')\n"}],
            "affectedChecks": [[sys.executable, "-c", "import sys; sys.exit(0)"]],
        }, headers=headers)
        assert validation.status_code == 200 and validation.json()["status"] == "validated", validation.text
        promotion = client.post("/heal/agentic/distill/vivarium-promote", json={"capsulePath": capsule_path, "mode": "regression"}, headers=headers)
        assert promotion.status_code == 200 and promotion.json()["status"] == "vivarium_promoted", promotion.text
        deleted = client.post("/heal/agentic/distill/delete", json={"capsulePath": capsule_path}, headers=headers)
        assert deleted.status_code == 200 and deleted.json()["status"] == "deleted", deleted.text
        purged = client.post("/heal/agentic/distill/purge-expired", json={"workspaceRoot": str(root)}, headers=headers)
        assert purged.status_code == 200 and purged.json()["status"] == "purged", purged.text

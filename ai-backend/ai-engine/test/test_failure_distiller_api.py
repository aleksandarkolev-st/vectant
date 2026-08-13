import sys

from fastapi.testclient import TestClient

import main

from test_failure_distiller import git, request


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

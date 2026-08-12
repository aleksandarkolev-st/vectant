import asyncio
import json
import subprocess
import sys
from pathlib import Path

import pytest

from analyzer.proactive.healing.failure_distiller import (
    DistillationError,
    FailureDistiller,
)


def run(coro):
    return asyncio.run(coro)


def git(root, *args):
    completed = subprocess.run(["git", "-C", str(root), *args], check=True, capture_output=True, text=True)
    return completed.stdout.strip()


@pytest.fixture
def workspace(tmp_path):
    root = tmp_path / "repo"
    root.mkdir()
    git(root, "init")
    git(root, "config", "user.email", "test@example.com")
    git(root, "config", "user.name", "Test")
    (root / "runner.py").write_text(
        "import pathlib, sys\n"
        "if pathlib.Path('required.txt').exists():\n"
        "  print('FailureSignature: required boundary')\n"
        "  sys.exit(7)\n"
        "print('fixed')\n",
        encoding="utf-8",
    )
    (root / "required.txt").write_text("keep this failure alive\n", encoding="utf-8")
    (root / "unrelated.txt").write_text("not involved\n", encoding="utf-8")
    git(root, "add", ".")
    git(root, "commit", "-m", "fixture")
    return root


def request(root, candidates):
    return {
        "workspaceRoot": str(root),
        "command": [sys.executable, "runner.py"],
        "predicate": {"type": "exit_nonzero", "required_output": ["FailureSignature"]},
        "signature": {"required": ["required boundary"]},
        "budget": {"preset": "fast", "stability_attempts": 2, "minimum_matches": 2, "max_executions": 20},
        "candidates": candidates,
    }


def test_distills_an_unrelated_file_and_writes_contract(workspace):
    result = run(FailureDistiller().distill(request(workspace, [
        {"kind": "file", "reference": "unrelated.txt"},
        {"kind": "file", "reference": "required.txt"},
    ])))
    assert result["ok"]
    assert result["status"] == "stable_partial"
    assert result["reduction"]["removed_units"] == 1
    capsule = Path(result["workspace_path"])
    assert (capsule / "manifest.json").is_file()
    assert (capsule / "reduction.ndjson").is_file()
    assert json.loads((capsule / "repro.json").read_text())["predicate"]["type"] == "exit_nonzero"
    replay = run(FailureDistiller().run(str(capsule)))
    assert replay["status"] == "same_failure"


def test_rejects_secret_environment_and_path_escape(workspace):
    with pytest.raises(DistillationError, match="secret-bearing"):
        run(FailureDistiller().distill({**request(workspace, []), "environment": {"API_TOKEN": "nope"}}))
    with pytest.raises(DistillationError, match="escapes workspace"):
        run(FailureDistiller().distill(request(workspace, [{"kind": "file", "reference": "../outside"}])))


def test_patch_mapping_rejects_capsule_only_edits(workspace):
    result = run(FailureDistiller().distill(request(workspace, [{"kind": "file", "reference": "required.txt"}])))
    assert result["ok"]
    validation = run(FailureDistiller().validate_patch({
        "capsulePath": result["workspace_path"],
        "edits": [{"path": "mocks/provider.py", "content": "not production"}],
    }))
    assert validation["status"] == "patch_mapping_conflict"


def test_auto_discovery_reduces_json_fixture_records_and_replay_uses_overlay(workspace):
    (workspace / "fixture.json").write_text(
        json.dumps({"required": True, "unrelated": "remove me"}), encoding="utf-8"
    )
    (workspace / "runner.py").write_text(
        "import json, sys\n"
        "fixture = json.load(open('fixture.json', encoding='utf-8'))\n"
        "if fixture.get('required'):\n"
        "  print('FailureSignature: fixture boundary')\n"
        "  sys.exit(7)\n"
        "print('fixed')\n",
        encoding="utf-8",
    )
    git(workspace, "add", ".")
    git(workspace, "commit", "-m", "fixture json")
    payload = request(workspace, [])
    payload["autoDiscover"] = True
    payload["command"] = [sys.executable, "runner.py"]
    payload["signature"] = {"required": ["fixture boundary"]}
    result = run(FailureDistiller().distill(payload))
    assert result["ok"]
    capsule = Path(result["workspace_path"])
    repro = json.loads((capsule / "repro.json").read_text(encoding="utf-8"))
    assert {item["reference"] for item in repro["removed_units"]} >= {"fixture.json#/unrelated"}
    replay = run(FailureDistiller().run(str(capsule)))
    assert replay["status"] == "same_failure"


def test_cli_runs_and_explains_a_capsule(workspace):
    result = run(FailureDistiller().distill(request(workspace, [
        {"kind": "file", "reference": "unrelated.txt"},
    ])))
    cli = Path(__file__).parents[1] / "vectant_repro.py"
    command = [sys.executable, str(cli), "repro", "run", result["workspace_path"]]
    replay = subprocess.run(command, check=False, capture_output=True, text=True)
    assert replay.returncode == 0
    assert json.loads(replay.stdout)["status"] == "same_failure"
    explain = subprocess.run([
        sys.executable, str(cli), "repro", "explain", result["workspace_path"], "unrelated.txt",
    ], check=False, capture_output=True, text=True)
    assert explain.returncode == 0
    assert json.loads(explain.stdout)["evidence"][0]["decision"] == "removed"


def test_materializes_a_reduced_workspace_and_reproduces(workspace):
    result = run(FailureDistiller().distill(request(workspace, [
        {"kind": "file", "reference": "unrelated.txt"},
    ])))
    materialized = run(FailureDistiller().materialize({"capsulePath": result["workspace_path"]}))
    assert materialized["ok"]
    destination = Path(materialized["workspace_path"])
    assert not (destination / "unrelated.txt").exists()
    assert (destination / "runner.py").is_file()
    assert materialized["run"]["exit_code"] == 7

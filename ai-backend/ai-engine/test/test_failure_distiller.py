import asyncio
import json
import shutil
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
    with pytest.raises(DistillationError, match="secret-bearing argument"):
        run(FailureDistiller().distill({**request(workspace, []), "command": [sys.executable, "runner.py", "--api-key", "not-safe"]}))


def test_refuses_dirty_workspace_instead_of_reducing_a_different_revision(workspace):
    (workspace / "runner.py").write_text("import sys\nprint('FailureSignature: dirty')\nsys.exit(7)\n", encoding="utf-8")
    result = run(FailureDistiller().distill(request(workspace, [{"kind": "file", "reference": "unrelated.txt"}])))
    assert result["status"] == "boundary_not_isolatable"
    assert result["dirty_workspace"] is True


def test_patch_mapping_rejects_capsule_only_edits(workspace):
    result = run(FailureDistiller().distill(request(workspace, [{"kind": "file", "reference": "required.txt"}])))
    assert result["ok"]
    validation = run(FailureDistiller().validate_patch({
        "capsulePath": result["workspace_path"],
        "edits": [{"path": "mocks/provider.py", "content": "not production"}],
    }))
    assert validation["status"] == "patch_mapping_conflict"


def test_patch_validation_requires_and_records_all_round_trip_gates(workspace):
    result = run(FailureDistiller().distill(request(workspace, [
        {"kind": "file", "reference": "unrelated.txt"},
    ])))
    validation = run(FailureDistiller().validate_patch({
        "capsulePath": result["workspace_path"],
        "edits": [{"path": "runner.py", "content": "print('fixed')\n"}],
        "affectedChecks": [[sys.executable, "-c", "import sys; sys.exit(0)"]],
    }))
    assert validation["status"] == "validated"
    assert validation["gates"]["capsule_fails_before_patch"]["status"] == "same_failure"
    assert validation["gates"]["capsule_passes_after_patch"]["exit_code"] == 0
    stored = json.loads((Path(result["workspace_path"]) / "evidence" / "validation.json").read_text())
    assert stored["status"] == "validated"


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


def test_explicit_capsule_deletion_leaves_an_audit_record(workspace):
    result = run(FailureDistiller().distill(request(workspace, [
        {"kind": "file", "reference": "unrelated.txt"},
    ])))
    capsule = Path(result["workspace_path"])
    deleted = FailureDistiller().discard(str(capsule))
    assert deleted["status"] == "deleted"
    assert not capsule.exists()
    audit = (workspace / ".vectant" / "capsule-deletions.ndjson").read_text(encoding="utf-8")
    assert result["capsule_id"] in audit


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
    assert "runner.py" in materialized["retained_paths"]


def test_materialization_keeps_static_python_import_closure(workspace):
    (workspace / "helper.py").write_text("def failure(): return True\n", encoding="utf-8")
    (workspace / "runner.py").write_text(
        "import sys\nfrom helper import failure\nif failure():\n print('FailureSignature: import closure')\n sys.exit(7)\n",
        encoding="utf-8",
    )
    git(workspace, "add", "runner.py", "helper.py")
    git(workspace, "commit", "-m", "import closure fixture")
    payload = request(workspace, [{"kind": "file", "reference": "unrelated.txt"}])
    payload["signature"] = {"required": ["import closure"]}
    result = run(FailureDistiller().distill(payload))
    materialized = run(FailureDistiller().materialize({"capsulePath": result["workspace_path"]}))
    assert materialized["ok"]
    assert {"runner.py", "helper.py"} <= set(materialized["retained_paths"])


def test_metrics_report_reduction_and_validation_outcomes(workspace):
    distiller = FailureDistiller()
    result = run(distiller.distill(request(workspace, [{"kind": "file", "reference": "unrelated.txt"}])))
    run(distiller.validate_patch({
        "capsulePath": result["workspace_path"],
        "edits": [{"path": "runner.py", "content": "print('fixed')\n"}],
    }))
    metrics = distiller.metrics()
    assert metrics["accepted_capsules"] == 1
    assert metrics["removed_units"] == 1
    assert metrics["validated_patches"] == 1
    assert metrics["reduction_ratio"] == 1.0


def test_cli_exposes_distiller_metrics(workspace):
    cli = Path(__file__).parents[1] / "vectant_repro.py"
    completed = subprocess.run([sys.executable, str(cli), "repro", "metrics"], check=False, capture_output=True, text=True)
    assert completed.returncode == 0
    assert json.loads(completed.stdout)["ok"] is True


def test_exports_a_sanitized_deterministic_vivarium_manifest(workspace):
    result = run(FailureDistiller().distill(request(workspace, [{"kind": "file", "reference": "unrelated.txt"}])))
    exported = FailureDistiller().export_vivarium_manifest(result["workspace_path"])
    assert exported["ok"]
    assert exported["manifest"]["scenario_id"] == f"distiller_{result['capsule_id']}"
    assert exported["manifest"]["reset_profile"]["seed"]
    assert exported["manifest"]["synthetic_fixture_requirements"][0]["synthetic_data_only"] is True
    assert "original-world validation remains required" in " ".join(exported["manifest"]["limits"])
    assert Path(exported["manifest_path"]).is_file()


def test_promotes_only_original_world_validated_capsules_to_vivarium(workspace):
    distiller = FailureDistiller()
    result = run(distiller.distill(request(workspace, [{"kind": "file", "reference": "unrelated.txt"}])))
    blocked = distiller.promote_vivarium_scenario(result["workspace_path"])
    assert blocked["status"] == "boundary_not_isolatable"
    validation = run(distiller.validate_patch({"capsulePath": result["workspace_path"], "edits": [{"path": "runner.py", "content": "print('fixed')\n"}]}))
    assert validation["status"] == "validated"
    promoted = distiller.promote_vivarium_scenario(result["workspace_path"], "practice")
    assert promoted["ok"]
    assert promoted["mode"] == "practice"
    assert Path(promoted["artifact_path"]).is_file()


def test_reduces_noncausal_command_input_and_replays_reduced_command(workspace):
    (workspace / "runner.py").write_text(
        "import argparse, sys\n"
        "parser = argparse.ArgumentParser()\n"
        "parser.add_argument('--noise')\n"
        "parser.parse_args()\n"
        "print('FailureSignature: input boundary')\n"
        "sys.exit(7)\n",
        encoding="utf-8",
    )
    git(workspace, "add", "runner.py")
    git(workspace, "commit", "-m", "input fixture")
    payload = request(workspace, [{"kind": "command_arg", "reference": "2"}])
    payload["command"] = [sys.executable, "runner.py", "--noise=discard"]
    payload["signature"] = {"required": ["input boundary"]}
    result = run(FailureDistiller().distill(payload))
    assert result["reduction"]["removed_units"] == 1
    repro = json.loads((Path(result["workspace_path"]) / "repro.json").read_text())
    assert repro["removed_units"][0]["kind"] == "command_arg"
    assert run(FailureDistiller().run(result["workspace_path"]))["status"] == "same_failure"


def test_confirmation_pass_removes_units_that_become_noncausal_later(workspace):
    (workspace / "a.flag").write_text("a\n", encoding="utf-8")
    (workspace / "b.flag").write_text("b\n", encoding="utf-8")
    (workspace / "runner.py").write_text(
        "import pathlib, sys\n"
        "a = pathlib.Path('a.flag').exists()\n"
        "b = pathlib.Path('b.flag').exists()\n"
        "if (b and a) or not b:\n"
        "  print('FailureSignature: confirmation')\n"
        "  sys.exit(7)\n"
        "print('fixed')\n",
        encoding="utf-8",
    )
    git(workspace, "add", ".")
    git(workspace, "commit", "-m", "confirmation fixture")
    payload = request(workspace, [
        {"kind": "file", "reference": "a.flag"},
        {"kind": "file", "reference": "b.flag"},
    ])
    payload["signature"] = {"required": ["confirmation"]}
    result = run(FailureDistiller().distill(payload))
    assert result["reduction"]["removed_units"] == 2
    assert result["reduction"]["minimality"] == "1-minimal_under_declared_units"
    decisions = (Path(result["workspace_path"]) / "reduction.ndjson").read_text()
    assert '"operation":"confirm_remove"' in decisions


def test_derives_a_failure_signature_when_callers_supply_only_a_predicate(workspace):
    payload = request(workspace, [{"kind": "file", "reference": "unrelated.txt"}])
    payload.pop("signature")
    result = run(FailureDistiller().distill(payload))
    assert result["ok"]
    repro = json.loads((Path(result["workspace_path"]) / "repro.json").read_text())
    assert repro["signature"]["required"]
    assert run(FailureDistiller().run(result["workspace_path"]))["status"] == "same_failure"


def test_records_redacted_hmr_observation_and_maps_its_source_provenance(workspace):
    payload = request(workspace, [{"kind": "file", "reference": "unrelated.txt"}])
    payload["observation"] = {"kind": "hmr", "eventRef": "hmr:42", "filePath": "runner.py", "message": "password=never-persist"}
    result = run(FailureDistiller().distill(payload))
    capsule = Path(result["workspace_path"])
    repro = json.loads((capsule / "repro.json").read_text(encoding="utf-8"))
    provenance = json.loads((capsule / "provenance.json").read_text(encoding="utf-8"))
    assert repro["observation"] == {"kind": "hmr", "event_ref": "hmr:42", "file_path": "runner.py", "message": "password=<redacted>"}
    assert "runner.py" in provenance


def test_capsule_records_runtime_identity_and_redacts_persisted_output(workspace):
    (workspace / "runner.py").write_text(
        "import sys\nprint('FailureSignature: redaction password=should-not-persist')\nsys.exit(7)\n",
        encoding="utf-8",
    )
    git(workspace, "add", "runner.py")
    git(workspace, "commit", "-m", "redaction fixture")
    payload = request(workspace, [{"kind": "file", "reference": "unrelated.txt"}])
    payload["signature"] = {"required": ["redaction"]}
    result = run(FailureDistiller().distill(payload))
    capsule = Path(result["workspace_path"])
    manifest = json.loads((capsule / "manifest.json").read_text(encoding="utf-8"))
    baseline = (capsule / "evidence" / "baseline.json").read_text(encoding="utf-8")
    assert manifest["runtime"]["command_executable"]
    assert manifest["runtime"]["python"]
    assert "should-not-persist" not in baseline
    assert "password=<redacted>" in baseline


@pytest.mark.skipif(not (Path(__file__).parents[3] / "synthi" / "node_modules" / "vitest").exists(), reason="Vitest install unavailable")
def test_vitest_adapter_reduces_a_real_node_fixture(workspace):
    shared_modules = Path(__file__).parents[3] / "synthi" / "node_modules"
    (workspace / ".gitignore").write_text("node_modules\n", encoding="utf-8")
    try:
        (workspace / "node_modules").symlink_to(shared_modules, target_is_directory=True)
    except OSError:
        pytest.skip("cannot create local node_modules link")
    (workspace / "package.json").write_text('{"type":"module"}\n', encoding="utf-8")
    (workspace / "failure.test.mjs").write_text(
        "import { test, expect } from 'vitest';\n"
        "test('fails with signature', () => { throw new Error('FailureSignature vitest'); });\n",
        encoding="utf-8",
    )
    (workspace / "unrelated.txt").write_text("remove\n", encoding="utf-8")
    git(workspace, "add", ".gitignore", "package.json", "failure.test.mjs", "unrelated.txt")
    git(workspace, "commit", "-m", "vitest fixture")
    payload = {
        "workspaceRoot": str(workspace),
        "command": [shutil.which("node") or "node", str(shared_modules / "vitest" / "vitest.mjs"), "run", "failure.test.mjs"],
        "predicate": {"type": "exit_nonzero", "required_output": ["FailureSignature vitest"]},
        "signature": {"required": ["FailureSignature vitest"]},
        "budget": {"preset": "fast", "stability_attempts": 1, "minimum_matches": 1, "max_executions": 12, "timeout_sec": 30},
        "candidates": [{"kind": "file", "reference": "unrelated.txt"}],
    }
    result = run(FailureDistiller().distill(payload))
    assert result["ok"], result["baseline"]["runs"][0]["output"]
    assert result["reduction"]["removed_units"] == 1
    assert run(FailureDistiller().run(result["workspace_path"]))["status"] == "same_failure"

import asyncio
import hashlib
import importlib.util
import json
import shutil
import subprocess
import sys
from datetime import datetime, timedelta, timezone
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


def test_browser_observation_can_supply_an_attested_workspace_replay_command(workspace):
    payload = request(workspace, [{"kind": "file", "reference": "unrelated.txt"}])
    command = [sys.executable, "runner.py"]
    payload.pop("command")
    payload["observation"] = {
        "kind": "browser", "executedPaths": ["runner.py"],
        "replayCommand": command,
        "replayCommandSha256": hashlib.sha256(json.dumps(command, sort_keys=True, separators=(",", ":")).encode()).hexdigest(),
        "workflow": {"route": "/failure", "state_fixture": {}, "device": "desktop", "viewport": {"width": 1280, "height": 720}, "steps": ["submit"], "network_sequence": [], "dom_transitions": ["failure"], "source_events": ["runner.py:1"], "console": ["FailureSignature"]},
    }
    result = run(FailureDistiller().distill(payload))
    assert result["ok"]
    assert run(FailureDistiller().run(result["workspace_path"]))["status"] == "same_failure"


def test_browser_replay_command_rejects_a_bad_attestation_before_execution(workspace):
    payload = request(workspace, [])
    payload.pop("command")
    payload["observation"] = {
        "kind": "browser", "executedPaths": ["runner.py"],
        "replayCommand": [sys.executable, "runner.py"], "replayCommandSha256": "0" * 64,
        "workflow": {"route": "/failure", "state_fixture": {}, "device": "desktop", "viewport": {"width": 1280, "height": 720}, "steps": ["submit"], "network_sequence": [], "dom_transitions": ["failure"], "source_events": ["runner.py:1"], "console": []},
    }
    with pytest.raises(DistillationError, match="replay_command_sha256"):
        run(FailureDistiller().distill(payload))


@pytest.mark.skip(reason="Browser Failure Distiller remains experimental/adapter-only until a deterministic browser-failure-to-capsule round trip is available")
def test_browser_adapter_distills_a_real_playwright_chrome_failure(workspace):
    modules = Path(__file__).parents[3] / "node_modules"
    try:
        (workspace / "node_modules").symlink_to(modules, target_is_directory=True)
    except OSError:
        pytest.skip("cannot create local node_modules link")
    (workspace / ".gitignore").write_text("node_modules\n", encoding="utf-8")
    (workspace / "browser_failure.mjs").write_text(
        "import http from 'node:http'; import { chromium } from '@playwright/test';\n"
        "const server=http.createServer((req,res)=>{if(req.url==='/api/invite'){res.end('ok');return}res.end(`<button id=go>Submit</button><div id=result>open</div><script>document.querySelector('#go').onclick=async()=>{console.error('InviteModal.onSubmit');await fetch('/api/invite');document.querySelector('#result').textContent='closed'}</script>`)});\n"
        "await new Promise(r=>server.listen(0,'127.0.0.1',r)); const url=`http://127.0.0.1:${server.address().port}`; const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'}); const page=await browser.newPage(); const logs=[]; page.on('console',m=>logs.push(m.text())); await page.goto(url); await page.click('#go'); await page.waitForTimeout(30); const ok=await page.locator('#result').textContent()==='closed'; await browser.close(); await new Promise(r=>server.close(r)); if(ok&&logs.includes('InviteModal.onSubmit')){console.log('FailureSignature: browser real invite missing dispatch');process.exit(7)} process.exit(0);\n",
        encoding="utf-8",
    )
    git(workspace, "add", ".gitignore", "browser_failure.mjs")
    git(workspace, "commit", "-m", "real browser failure fixture")
    command = [shutil.which("node") or "node", "browser_failure.mjs"]
    payload = request(workspace, [{"kind": "file", "reference": "unrelated.txt"}])
    payload.update({"command": command, "signature": {"required": ["browser real invite missing dispatch"]}, "budget": {"preset": "fast", "stability_attempts": 1, "minimum_matches": 1, "max_executions": 8}})
    payload["observation"] = {"kind": "browser", "executedPaths": ["browser_failure.mjs"], "workflow": {"route": "/invite", "state_fixture": {}, "device": "desktop", "viewport": {"width": 1280, "height": 720}, "steps": ["submit"], "network_sequence": ["GET /api/invite"], "dom_transitions": ["open", "closed"], "source_events": ["browser_failure.mjs:2"], "console": ["InviteModal.onSubmit"]}}
    result = run(FailureDistiller().distill(payload))
    assert result["ok"], result
    assert result["baseline"]["matching_failures"] == 1


def test_durable_evaluation_cache_does_not_make_the_source_workspace_dirty(workspace):
    payload = request(workspace, [{"kind": "file", "reference": "unrelated.txt"}])
    first = run(FailureDistiller().distill(payload))
    assert first["ok"]
    assert (workspace / ".vectant" / "cache" / "evaluations.json").is_file()
    second = run(FailureDistiller().distill(payload))
    assert second["ok"]
    assert second["baseline"]["matches"] == 2


def test_budget_reserves_baseline_and_reports_untested_units(workspace):
    payload = request(workspace, [{"kind": "file", "reference": "unrelated.txt"}])
    payload["budget"] = {"preset": "fast", "stability_attempts": 3, "minimum_matches": 2, "max_executions": 2}
    result = run(FailureDistiller().distill(payload))
    assert result["status"] == "budget_exhausted"
    assert result["untested_units"] == ["file:unrelated.txt"]
    assert result["budget"]["reserved_baseline"] == 3


def test_cache_reuse_does_not_consume_current_execution_budget(workspace):
    payload = request(workspace, [{"kind": "file", "reference": "unrelated.txt"}])
    first = run(FailureDistiller().distill(payload))
    assert first["ok"]
    payload["budget"] = {"preset": "fast", "stability_attempts": 2, "minimum_matches": 2, "max_executions": 4}
    second = run(FailureDistiller().distill(payload))
    assert second["ok"]
    assert second["executions"] == 2


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
    assert validation["mismatch"]["classification"] == "patch_map_conflict"


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
    second = run(FailureDistiller().validate_patch({
        "capsulePath": result["workspace_path"],
        "edits": [{"path": "runner.py", "content": "print('fixed')\n"}],
    }))
    assert second["status"] == "validated"
    assert len(list((Path(result["workspace_path"]) / "evidence" / "validation-history").glob("*.json"))) == 2


def test_editable_capsule_overlay_is_a_real_patch_source(workspace):
    result = run(FailureDistiller().distill(request(workspace, [{"kind": "file", "reference": "unrelated.txt"}])))
    overlay_runner = Path(result["workspace_path"]) / "overlay" / "runner.py"
    assert overlay_runner.is_file()
    overlay_runner.write_text("print('fixed')\n", encoding="utf-8")
    validation = run(FailureDistiller().validate_patch({"capsulePath": result["workspace_path"]}))
    assert validation["status"] == "validated"
    assert validation["patch_mapping"]["mapped_files"] == ["runner.py"]


def test_patch_validation_runs_original_command_when_no_affected_check_is_supplied(workspace):
    result = run(FailureDistiller().distill(request(workspace, [{"kind": "file", "reference": "unrelated.txt"}])))
    validation = run(FailureDistiller().validate_patch({"capsulePath": result["workspace_path"], "edits": [{"path": "runner.py", "content": "print('fixed')\n"}]}))
    assert validation["status"] == "validated"
    assert validation["gates"]["affected_checks"][0]["source"] == "original_failure_command"
    assert validation["gates"]["affected_checks"][0]["run"]["exit_code"] == 0


def test_patch_round_trip_invalidates_a_capsule_when_removed_boundary_changes_fix_result(workspace):
    (workspace / "runner.py").write_text(
        "import sys\nprint('FailureSignature: boundary mismatch')\nsys.exit(7)\n",
        encoding="utf-8",
    )
    (workspace / "hidden-boundary.flag").write_text("present\n", encoding="utf-8")
    git(workspace, "add", "runner.py", "hidden-boundary.flag")
    git(workspace, "commit", "-m", "mismatch fixture")
    payload = request(workspace, [{"kind": "file", "reference": "hidden-boundary.flag"}])
    payload["signature"] = {"required": ["boundary mismatch"]}
    result = run(FailureDistiller().distill(payload))
    assert result["ok"]
    validation = run(FailureDistiller().validate_patch({
        "capsulePath": result["workspace_path"],
        "edits": [{"path": "runner.py", "content": "import pathlib, sys\nif pathlib.Path('hidden-boundary.flag').exists():\n print('FailureSignature: boundary mismatch'); sys.exit(7)\nprint('fixed')\n"}],
    }))
    assert validation["status"] == "original_validation_failed"
    assert validation["mismatch"]["classification"] == "weak_signature"
    assert validation["mismatch"]["boundary_action"] == "invalidate_and_expand"
    manifest = json.loads((Path(result["workspace_path"]) / "manifest.json").read_text())
    assert manifest["status"] == "boundary_invalidated"


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


def test_retention_collector_deletes_only_expired_capsules_with_an_audit_record(workspace):
    payload = request(workspace, [{"kind": "file", "reference": "unrelated.txt"}])
    payload["retentionSeconds"] = 60
    result = run(FailureDistiller().distill(payload))
    capsule = Path(result["workspace_path"])
    retained = json.loads((capsule / "manifest.json").read_text())
    assert retained["retention"]["seconds"] == 60
    purged = FailureDistiller().purge_expired(str(workspace), datetime.now(timezone.utc) + timedelta(seconds=61))
    assert purged["deleted"] == [result["capsule_id"]]
    assert not capsule.exists()
    assert result["capsule_id"] in (workspace / ".vectant" / "capsule-deletions.ndjson").read_text()


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
    assert run(FailureDistiller().run(materialized["workspace_path"]))["status"] == "same_failure"
    assert "vectant repro run ." in (destination / "CAPSULE.md").read_text(encoding="utf-8")
    assert not any(path.is_symlink() for path in destination.rglob("*"))
    assert (destination / ".vectant-runtime.json").is_file()
    assert (destination / ".vectant-integrity.json").is_file()


def test_materialized_capsule_rejects_tampering(workspace):
    result = run(FailureDistiller().distill(request(workspace, [{"kind": "file", "reference": "unrelated.txt"}])))
    materialized = run(FailureDistiller().materialize({"capsulePath": result["workspace_path"]}))
    destination = Path(materialized["workspace_path"])
    (destination / "runner.py").write_text("print('tampered')\n", encoding="utf-8")
    replay = run(FailureDistiller().run(str(destination)))
    assert replay["status"] == "boundary_not_isolatable"


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


@pytest.mark.skipif(importlib.util.find_spec("packaging") is None, reason="packaging runtime unavailable")
def test_materialization_vendors_imported_python_package_closure(workspace):
    (workspace / "runner.py").write_text(
        "from packaging.version import Version\nimport sys\n"
        "assert Version('1.0') < Version('2.0')\n"
        "print('FailureSignature: python package closure')\nsys.exit(7)\n",
        encoding="utf-8",
    )
    git(workspace, "add", "runner.py")
    git(workspace, "commit", "-m", "python dependency fixture")
    payload = request(workspace, [{"kind": "file", "reference": "unrelated.txt"}])
    payload["signature"] = {"required": ["python package closure"]}
    result = run(FailureDistiller().distill(payload))
    materialized = run(FailureDistiller().materialize({"capsulePath": result["workspace_path"]}))
    assert materialized["ok"]
    assert "packaging" in materialized["python_dependencies"]
    vendor = Path(materialized["workspace_path"]) / ".vectant" / "python" / "packaging"
    assert vendor.is_dir() and not vendor.is_symlink()
    assert run(FailureDistiller().run(materialized["workspace_path"]))["status"] == "same_failure"


@pytest.mark.skipif(not shutil.which("node"), reason="Node runtime unavailable")
def test_materialization_copies_required_node_package_closure_without_a_symlink(workspace):
    (workspace / ".gitignore").write_text("node_modules\n", encoding="utf-8")
    package = workspace / "node_modules" / "tiny-runtime"
    package.mkdir(parents=True)
    (package / "package.json").write_text('{"name":"tiny-runtime","version":"1.0.0","type":"module"}\n', encoding="utf-8")
    (package / "index.js").write_text("export const signature = 'node closure';\n", encoding="utf-8")
    (workspace / "runner.mjs").write_text("import { signature } from 'tiny-runtime';\nconsole.log(`FailureSignature: ${signature}`); process.exit(7);\n", encoding="utf-8")
    git(workspace, "add", ".gitignore", "runner.mjs")
    git(workspace, "commit", "-m", "node dependency fixture")
    payload = request(workspace, [{"kind": "file", "reference": "unrelated.txt"}])
    payload.update({"command": [shutil.which("node") or "node", "runner.mjs"], "signature": {"required": ["node closure"]}, "budget": {"preset": "fast", "stability_attempts": 1, "minimum_matches": 1, "max_executions": 8}})
    result = run(FailureDistiller().distill(payload))
    materialized = run(FailureDistiller().materialize({"capsulePath": result["workspace_path"]}))
    assert materialized["ok"]
    assert materialized["node_dependencies"] == ["tiny-runtime"]
    copied = Path(materialized["workspace_path"]) / "node_modules" / "tiny-runtime"
    assert copied.is_dir() and not copied.is_symlink()
    assert run(FailureDistiller().run(materialized["workspace_path"]))["status"] == "same_failure"


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
    ledger = (workspace / ".vectant" / "evidence-ledger.ndjson").read_text(encoding="utf-8")
    assert '"event":"vivarium_manifest_exported"' in ledger


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
    assert '"oracle_result":"original_world_patch_validated"' in (workspace / ".vectant" / "evidence-ledger.ndjson").read_text(encoding="utf-8")


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


def test_reduces_supported_python_function_units_without_text_heuristics(workspace):
    (workspace / "runner.py").write_text(
        "import sys\n"
        "def unused_helper():\n    return 'discard'\n"
        "def failure():\n    print('FailureSignature: source unit'); return 7\n"
        "sys.exit(failure())\n",
        encoding="utf-8",
    )
    git(workspace, "add", "runner.py")
    git(workspace, "commit", "-m", "source unit fixture")
    payload = request(workspace, [{"kind": "python_function", "reference": "runner.py#unused_helper"}])
    payload["signature"] = {"required": ["source unit"]}
    result = run(FailureDistiller().distill(payload))
    assert result["ok"]
    assert result["reduction"]["removed_units"] == 1
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
    assert '"operation":"coarse_group_remove"' in decisions


def test_confirmation_prefetches_independent_retained_candidates_safely(workspace):
    for name in ("a.flag", "b.flag", "c.flag"):
        (workspace / name).write_text("required\n", encoding="utf-8")
    (workspace / "runner.py").write_text(
        "import pathlib, sys\n"
        "if all(pathlib.Path(name).exists() for name in ('a.flag', 'b.flag', 'c.flag')):\n"
        " print('FailureSignature: parallel confirmation'); sys.exit(7)\n"
        "print('fixed')\n",
        encoding="utf-8",
    )
    git(workspace, "add", "runner.py", "a.flag", "b.flag", "c.flag")
    git(workspace, "commit", "-m", "parallel confirmation fixture")
    distiller = FailureDistiller()
    payload = request(workspace, [{"kind": "file", "reference": name} for name in ("a.flag", "b.flag", "c.flag")])
    payload["signature"] = {"required": ["parallel confirmation"]}
    payload["budget"] = {"preset": "standard", "stability_attempts": 1, "minimum_matches": 1, "max_executions": 30, "parallelism": 2}
    result = run(distiller.distill(payload))
    assert result["ok"] and result["reduction"]["retained_units"] == 3
    assert distiller.metrics()["cache_hits"] >= 2


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
    payload["observation"] = {"kind": "hmr", "eventRef": "hmr:42", "filePath": "runner.py", "message": "password=never-persist", "hmrEvents": ["check", "applied"]}
    result = run(FailureDistiller().distill(payload))
    capsule = Path(result["workspace_path"])
    repro = json.loads((capsule / "repro.json").read_text(encoding="utf-8"))
    provenance = json.loads((capsule / "provenance.json").read_text(encoding="utf-8"))
    assert repro["observation"] == {
        "kind": "hmr", "event_ref": "hmr:42", "file_path": "runner.py", "message": "password=<redacted>",
        "adapter": {"kind": "hmr", "recording": {"hmr_events": ["check", "applied"], "terminal": "applied"}, "candidate_groups": {"events": ["check", "applied"]}},
    }
    assert "runner.py" in provenance


def test_runtime_observation_builds_a_reduction_frontier_from_attested_paths(workspace):
    (workspace / "executed.py").write_text("# observed but noncausal\n", encoding="utf-8")
    (workspace / "fixture.json").write_text('{"state":"observed"}\n', encoding="utf-8")
    git(workspace, "add", "executed.py", "fixture.json")
    git(workspace, "commit", "-m", "runtime frontier fixture")
    payload = request(workspace, [])
    payload["autoDiscover"] = True
    payload["observation"] = {
        "kind": "gpu",
        "eventRef": "gpu-proof:17",
        "filePath": "runner.py",
        "deviceMarker": "test-device",
        "errorFingerprint": "gpu-fingerprint-17",
        "frameStates": ["frame:0", "frame:1:error"],
        "executedPaths": ["executed.py"],
        "fixturePaths": ["fixture.json"],
    }
    result = run(FailureDistiller().distill(payload))
    assert result["ok"]
    # The executable itself remains structural; the observed auxiliary paths
    # are the reducible frontier.
    assert result["reduction"]["candidate_units"] == 2
    capsule = Path(result["workspace_path"])
    repro = json.loads((capsule / "repro.json").read_text(encoding="utf-8"))
    assert repro["observation"]["executed_paths"] == ["executed.py"]
    assert repro["observation"]["fixture_paths"] == ["fixture.json"]
    provenance = json.loads((capsule / "provenance.json").read_text(encoding="utf-8"))
    assert {"runner.py", "executed.py", "fixture.json"} <= set(provenance)
    assert run(FailureDistiller().run(str(capsule)))["status"] == "same_failure"


def test_nested_json_pointer_reduction_escapes_slashes_and_tildes(workspace):
    (workspace / "fixture.json").write_text(json.dumps({"a/b": {"~flag": "discard", "required": "keep"}}), encoding="utf-8")
    (workspace / "runner.py").write_text(
        "import json, sys\n"
        "data=json.load(open('fixture.json', encoding='utf-8'))\n"
        "if data['a/b']['required'] == 'keep': print('FailureSignature: nested fixture'); sys.exit(7)\n"
        "print('fixed')\n",
        encoding="utf-8",
    )
    git(workspace, "add", "runner.py", "fixture.json")
    git(workspace, "commit", "-m", "nested fixture")
    payload = request(workspace, [{"kind": "json_key", "reference": "fixture.json#/a~1b/~0flag"}])
    payload["signature"] = {"required": ["nested fixture"]}
    result = run(FailureDistiller().distill(payload))
    assert result["reduction"]["removed_units"] == 1
    assert run(FailureDistiller().run(result["workspace_path"]))["status"] == "same_failure"


def test_runtime_auto_discovery_refuses_without_attested_frontier(workspace):
    payload = request(workspace, [])
    payload["autoDiscover"] = True
    payload["observation"] = {"kind": "native", "eventRef": "native:3"}
    with pytest.raises(DistillationError, match="boundary_not_isolatable"):
        run(FailureDistiller().distill(payload))


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


def test_capsule_normalizes_replay_environment_with_a_recorded_seed(workspace):
    payload = request(workspace, [{"kind": "file", "reference": "unrelated.txt"}])
    payload["seed"] = "incident-42"
    result = run(FailureDistiller().distill(payload))
    repro = json.loads((Path(result["workspace_path"]) / "repro.json").read_text(encoding="utf-8"))
    assert repro["environment"] == {
        "TZ": "UTC", "LANG": "C", "LC_ALL": "C", "PYTHONHASHSEED": "0", "VECTANT_FAILURE_SEED": "incident-42",
    }


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

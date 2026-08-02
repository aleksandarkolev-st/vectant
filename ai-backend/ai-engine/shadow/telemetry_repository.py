"""Durable, bounded counterfactual telemetry for one workspace.

The shadow runner is local-first, so this repository uses a workspace-scoped
JSON document instead of a process-global cache. Writes are atomic and records
contain compact telemetry only, never full source or raw command output.
"""

from __future__ import annotations

import json
import os
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional


_LOCK = threading.RLock()
_DIR = ".vectant"
_FILE = "counterfactual-telemetry.json"
_SCHEMA_VERSION = 1
_MAX_RUNS = 1000
_MAX_TEXT = 2_000
_MAX_COLLECTION = 200


def telemetry_path(repo: Path) -> Path:
    root = repo.resolve()
    path = (root / _DIR / _FILE).resolve()
    if root not in path.parents:
        raise ValueError("counterfactual telemetry path escaped workspace")
    return path


class TelemetryRepository:
    def __init__(self, repo: Path):
        self.repo = repo.resolve()
        self.path = telemetry_path(self.repo)

    def is_enabled(self) -> bool:
        return bool(self._read().get("enabled", True))

    def set_enabled(self, enabled: bool) -> bool:
        data = self._read()
        data["enabled"] = bool(enabled)
        self._write(data)
        return data["enabled"]

    def retention(self) -> Dict[str, int]:
        return dict(self._read()["retention"])

    def update_retention(self, *, fossil_days: Optional[int] = None, raw_trace_days: Optional[int] = None) -> Dict[str, int]:
        data = self._read()
        retention = data["retention"]
        for key, value in (("fossil_days", fossil_days), ("raw_trace_days", raw_trace_days)):
            if value is None:
                continue
            if not 1 <= value <= 3650:
                raise ValueError(f"{key} must be between 1 and 3650 days")
            retention[key] = int(value)
        self._prune(data)
        self._write(data)
        return dict(retention)

    def put_run(self, run: Dict[str, Any]) -> Dict[str, Any]:
        data = self._read()
        if not data["enabled"]:
            return run
        record = _compact(run)
        run_id = _required_id(record, "run_id")
        data["runs"][run_id] = record
        self._prune(data)
        self._write(data)
        return record

    def get_run(self, run_id: str) -> Optional[Dict[str, Any]]:
        return self._read()["runs"].get(run_id)

    def update_run(self, run_id: str, **changes: Any) -> Dict[str, Any]:
        data = self._read()
        record = data["runs"].get(run_id)
        if record is None:
            raise KeyError(f"unknown counterfactual run: {run_id}")
        if not data["enabled"]:
            return record
        record.update(_compact(changes))
        self._write(data)
        return record

    def put_branch(self, branch: Dict[str, Any]) -> Dict[str, Any]:
        data = self._read()
        if not data["enabled"]:
            return branch
        record = _compact(branch)
        branch_id = _required_id(record, "id")
        run_id = _required_id(record, "counterfactual_run_id")
        if run_id not in data["runs"]:
            raise KeyError(f"unknown counterfactual run: {run_id}")
        data["branches"][branch_id] = record
        self._write(data)
        return record

    def put_detector(self, detector: Dict[str, Any]) -> Dict[str, Any]:
        data = self._read()
        if not data["enabled"]:
            return detector
        record = _compact(detector)
        branch_id = _required_id(record, "branch_trace_id")
        if branch_id not in data["branches"]:
            raise KeyError(f"unknown branch trace: {branch_id}")
        data["detectors"][_required_id(record, "id")] = record
        self._write(data)
        return record

    def put_choice_scene(self, scene: Dict[str, Any]) -> Dict[str, Any]:
        data = self._read()
        if not data["enabled"]:
            return scene
        record = _compact(scene)
        run_id = _required_id(record, "counterfactual_run_id")
        if run_id not in data["runs"]:
            raise KeyError(f"unknown counterfactual run: {run_id}")
        data["choice_scenes"][_required_id(record, "id")] = record
        self._write(data)
        return record

    def put_policy_deltas(self, deltas: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
        data = self._read()
        if not data["enabled"]:
            return list(deltas)
        stored = []
        for delta in deltas:
            record = _compact(delta)
            _required_id(record, "id")
            _required_id(record, "source_counterfactual_run_id")
            data["policy_deltas"][record["id"]] = record
            stored.append(record)
        self._rebuild_niche_maps(data)
        self._write(data)
        return stored

    def list_policy_deltas(self, *, task_class: Optional[str] = None, active_only: bool = False) -> List[Dict[str, Any]]:
        now = time.time()
        values = list(self._read()["policy_deltas"].values())
        out = []
        for delta in values:
            if task_class and delta.get("task_class") != task_class:
                continue
            if active_only and (delta.get("status") in {"deleted", "contradicted"} or _expired(delta, now)):
                continue
            out.append(delta)
        return sorted(out, key=lambda value: value.get("id", ""))

    def delete_policy_delta(self, delta_id: str) -> bool:
        data = self._read()
        delta = data["policy_deltas"].get(delta_id)
        if not delta:
            return False
        delta["status"] = "deleted"
        self._rebuild_niche_maps(data)
        self._write(data)
        return True

    def put_fossil(self, fossil: Dict[str, Any]) -> Dict[str, Any]:
        data = self._read()
        if not data["enabled"]:
            return fossil
        record = _compact(fossil)
        data["fossils"][_required_id(record, "id")] = record
        self._prune(data)
        self._write(data)
        return record

    def put_mutation_trial(self, trial: Dict[str, Any]) -> Dict[str, Any]:
        if trial.get("auto_apply_allowed"):
            raise ValueError("Mutation Trials must never allow auto-apply")
        data = self._read()
        if not data["enabled"]:
            return trial
        record = _compact(trial)
        data["mutation_trials"][_required_id(record, "id")] = record
        self._write(data)
        return record

    def niche_map(self, task_class: str) -> Dict[str, Any]:
        return self._read()["niche_maps"].get(task_class, _empty_niche_map(str(self.repo), task_class))

    def forecast(self, *, task_class: str, request_summary: str, max_universes: int, max_cost_usd: float) -> List[Dict[str, Any]]:
        if not 1 <= max_universes <= 8 or max_cost_usd <= 0:
            raise ValueError("forecast budget is invalid")
        niche = self.niche_map(task_class)
        hints = niche.get("policy_hints", [])
        runtime_first = niche.get("runtime_depth_preference") == "raise_runtime_primitive"
        directions = [
            ("conservative_local_repair", "low", "low", "medium"),
            ("runtime_primitive", "high", "medium", "high" if runtime_first else "medium"),
            ("broad_platform_refactor", "high", "high", "low"),
        ][:max_universes]
        result = []
        for index, (label, novelty, risk, fit) in enumerate(directions):
            result.append({
                "direction_id": chr(ord("A") + index), "label": label,
                "runner_candidates": ["internal", "codex", "claude_code"],
                "expected_phenotype_vector": {"runtime_depth": 0.85 if label == "runtime_primitive" else 0.3},
                "proof_cost_estimate": "medium" if label == "runtime_primitive" else "low",
                "risk_estimate": risk, "novelty_estimate": novelty,
                "selection_fit_estimate": fit,
                "comparable_fossil_ids": niche.get("last_fossil_ids", [])[:5],
                "why": hints[0] if hints else f"Default direction for {task_class}; request: {request_summary[:160]}",
            })
        return result

    def _read(self) -> Dict[str, Any]:
        with _LOCK:
            if not self.path.exists():
                return _empty_document(str(self.repo))
            try:
                value = json.loads(self.path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                return _empty_document(str(self.repo))
            baseline = _empty_document(str(self.repo))
            if value.get("schema_version") != _SCHEMA_VERSION:
                return baseline
            for key, default in baseline.items():
                value.setdefault(key, default)
            return value

    def _write(self, data: Dict[str, Any]) -> None:
        with _LOCK:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            fd, temporary = tempfile.mkstemp(prefix="counterfactual-", suffix=".json", dir=self.path.parent)
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as handle:
                    json.dump(data, handle, sort_keys=True, separators=(",", ":"))
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(temporary, self.path)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)

    def _prune(self, data: Dict[str, Any]) -> None:
        now = time.time()
        fossil_days = int(data["retention"]["fossil_days"])
        cutoff = now - fossil_days * 86400
        data["fossils"] = {key: value for key, value in data["fossils"].items() if value.get("created_at", now) >= cutoff and not _expired(value, now)}
        runs = sorted(data["runs"].items(), key=lambda item: item[1].get("created_at", 0), reverse=True)
        keep = {key for key, _ in runs[:_MAX_RUNS]}
        data["runs"] = {key: value for key, value in data["runs"].items() if key in keep}
        # Raw runner transcripts are operational artifacts, not durable memory.
        # They remain local, bounded by the runner, and are removed separately
        # from compact branch summaries when their shorter retention expires.
        raw_cutoff = now - int(data["retention"]["raw_trace_days"]) * 86400
        artifact_root = self.repo / _DIR / "runner-artifacts"
        if artifact_root.exists():
            for artifact in artifact_root.rglob("*"):
                if artifact.is_file() and artifact.stat().st_mtime < raw_cutoff:
                    try:
                        artifact.unlink()
                    except OSError:
                        pass

    def _rebuild_niche_maps(self, data: Dict[str, Any]) -> None:
        now = time.time()
        buckets: Dict[str, List[Dict[str, Any]]] = {}
        for delta in data["policy_deltas"].values():
            if delta.get("status") in {"deleted", "contradicted"} or _expired(delta, now):
                continue
            buckets.setdefault(str(delta.get("task_class") or "unknown"), []).append(delta)
        maps = {}
        for task_class, deltas in buckets.items():
            hints = [str(delta.get("after") or "") for delta in deltas][-5:]
            maps[task_class] = {
                **_empty_niche_map(str(self.repo), task_class),
                "policy_hints": hints,
                "patch_size_bias": "smaller_when_proof_close" if any("size" in hint.lower() or "smaller" in hint.lower() for hint in hints) else "neutral",
                "runtime_depth_preference": "raise_runtime_primitive" if any("runtime" in hint.lower() for hint in hints) else "neutral",
                "confidence": "medium" if len(deltas) >= 1 else "low",
                "sample_count": len(deltas),
                "last_fossil_ids": [ref for delta in deltas[-5:] for ref in delta.get("evidence_refs", [])[:1]],
                "updated_at": now,
            }
        data["niche_maps"] = maps


def _empty_document(workspace_id: str) -> Dict[str, Any]:
    return {"schema_version": _SCHEMA_VERSION, "workspace_id": workspace_id, "enabled": True,
            "retention": {"fossil_days": 365, "raw_trace_days": 30}, "runs": {}, "branches": {},
            "detectors": {}, "choice_scenes": {}, "fossils": {}, "policy_deltas": {},
            "niche_maps": {}, "mutation_trials": {}}


def _empty_niche_map(workspace_id: str, task_class: str) -> Dict[str, Any]:
    return {"workspace_id": workspace_id, "task_class": task_class, "policy_hints": [],
            "patch_size_bias": "neutral", "runtime_depth_preference": "neutral", "confidence": "low",
            "sample_count": 0, "last_fossil_ids": [], "updated_at": None}


def _required_id(value: Dict[str, Any], key: str) -> str:
    item = str(value.get(key) or "").strip()
    if not item or len(item) > 256:
        raise ValueError(f"{key} is required and must be at most 256 characters")
    return item


def _expired(record: Dict[str, Any], now: float) -> bool:
    expiry = record.get("expiry") or record.get("decay_after")
    return expiry is not None and float(expiry) <= now


def _compact(value: Any, *, depth: int = 0) -> Any:
    if depth > 8:
        return "[truncated]"
    if isinstance(value, str):
        return value.replace("\x00", "")[:_MAX_TEXT]
    if isinstance(value, dict):
        return {str(key)[:128]: _compact(item, depth=depth + 1) for key, item in list(value.items())[:_MAX_COLLECTION]}
    if isinstance(value, (list, tuple, set)):
        return [_compact(item, depth=depth + 1) for item in list(value)[:_MAX_COLLECTION]]
    if value is None or isinstance(value, (bool, int, float)):
        return value
    return _compact(str(value), depth=depth + 1)

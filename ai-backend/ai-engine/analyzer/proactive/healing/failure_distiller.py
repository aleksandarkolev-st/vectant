"""Evidence-backed reduction of a failing command into a logical capsule.

The reducer deliberately owns no language semantics.  It runs a supplied test
command in a disposable git worktree, uses an explicit predicate plus a
signature matcher as its oracle, and only removes declared file/environment
units.  This makes a useful, auditable first reduction boundary for pytest and
Vitest without pretending to minimise arbitrary programs.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple
from uuid import uuid4


STATUSES = {
    "distilled", "stable_partial", "not_reproducible", "unstable_baseline",
    "predicate_ambiguous", "boundary_not_isolatable", "budget_exhausted",
    "unsupported_runtime", "unsafe_external_boundary", "patch_mapping_conflict",
}
SECRET_NAME = re.compile(r"(?:token|secret|password|passwd|api[_-]?key|credential|private[_-]?key)", re.I)
DEFAULT_BUDGETS = {
    "fast": {"max_executions": 100, "stability_attempts": 3, "minimum_matches": 3, "timeout_sec": 30},
    "standard": {"max_executions": 1000, "stability_attempts": 5, "minimum_matches": 5, "timeout_sec": 60},
    "deep": {"max_executions": 5000, "stability_attempts": 10, "minimum_matches": 9, "timeout_sec": 90},
}


class DistillationError(ValueError):
    """A request is invalid or cannot safely be isolated."""


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)


def _safe_relative(root: Path, raw_path: str) -> Path:
    candidate = (root / raw_path).resolve()
    try:
        return candidate.relative_to(root.resolve())
    except ValueError as exc:
        raise DistillationError("candidate path escapes workspace") from exc


def _git(root: Path, *args: str) -> str:
    result = subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True, check=False)
    if result.returncode:
        raise DistillationError((result.stderr or "git command failed").strip())
    return result.stdout.strip()


@dataclass(frozen=True)
class Budget:
    max_executions: int
    stability_attempts: int
    minimum_matches: int
    timeout_sec: int

    @classmethod
    def from_request(cls, raw: Any) -> "Budget":
        if isinstance(raw, str):
            values = DEFAULT_BUDGETS.get(raw)
            if not values:
                raise DistillationError("unknown budget preset")
        elif isinstance(raw, dict):
            preset = DEFAULT_BUDGETS.get(str(raw.get("preset", "standard")))
            if not preset:
                raise DistillationError("unknown budget preset")
            values = {**preset, **{k: v for k, v in raw.items() if k != "preset"}}
        else:
            values = DEFAULT_BUDGETS["standard"]
        budget = cls(**{key: int(values[key]) for key in cls.__dataclass_fields__})
        if budget.max_executions < 1 or budget.stability_attempts < 1 or budget.minimum_matches < 1:
            raise DistillationError("budget values must be positive")
        if budget.minimum_matches > budget.stability_attempts:
            raise DistillationError("minimum_matches cannot exceed stability_attempts")
        return budget


@dataclass(frozen=True)
class Predicate:
    type: str = "exit_nonzero"
    required_output: Tuple[str, ...] = ()
    forbidden_output: Tuple[str, ...] = ()

    @classmethod
    def from_request(cls, raw: Any) -> "Predicate":
        raw = raw or {"type": "exit_nonzero"}
        if not isinstance(raw, dict) or raw.get("type", "exit_nonzero") != "exit_nonzero":
            raise DistillationError("only exit_nonzero predicates are currently supported")
        return cls(
            required_output=tuple(str(x) for x in raw.get("required_output", raw.get("requiredOutput", []))),
            forbidden_output=tuple(str(x) for x in raw.get("forbidden_output", raw.get("forbiddenOutput", []))),
        )

    def matches(self, exit_code: int, output: str) -> bool:
        return exit_code != 0 and all(re.search(pattern, output, re.M) for pattern in self.required_output) and not any(re.search(pattern, output, re.M) for pattern in self.forbidden_output)

    def to_dict(self) -> Dict[str, Any]:
        return {"type": self.type, "required_output": list(self.required_output), "forbidden_output": list(self.forbidden_output)}


@dataclass(frozen=True)
class Signature:
    required: Tuple[str, ...] = ()
    forbidden: Tuple[str, ...] = ()

    @classmethod
    def from_request(cls, raw: Any) -> "Signature":
        raw = raw or {}
        if not isinstance(raw, dict):
            raise DistillationError("signature must be an object")
        return cls(tuple(str(x) for x in raw.get("required", [])), tuple(str(x) for x in raw.get("forbidden", [])))

    def matches(self, output: str) -> bool:
        return all(re.search(pattern, output, re.M) for pattern in self.required) and not any(re.search(pattern, output, re.M) for pattern in self.forbidden)

    def to_dict(self) -> Dict[str, Any]:
        return {"matcher": "regex_subset", "required": list(self.required), "forbidden": list(self.forbidden)}


@dataclass(frozen=True)
class Candidate:
    kind: str
    reference: str

    @classmethod
    def from_request(cls, raw: Any, root: Path) -> "Candidate":
        if not isinstance(raw, dict):
            raise DistillationError("candidate units must be objects")
        kind, reference = raw.get("kind"), raw.get("reference")
        if kind not in {"file", "env"} or not isinstance(reference, str) or not reference:
            raise DistillationError("candidate units require kind=file|env and reference")
        if kind == "file":
            reference = _safe_relative(root, reference).as_posix()
        if kind == "env" and SECRET_NAME.search(reference):
            raise DistillationError("secret-bearing environment variables cannot be reduced or persisted")
        return cls(kind, reference)

    @property
    def identifier(self) -> str:
        return f"{self.kind}:{self.reference}"


@dataclass
class Run:
    exit_code: int
    output: str
    duration_ms: int
    timed_out: bool = False

    def fingerprint(self) -> str:
        return _sha256(self.output.encode())


class FailureDistiller:
    """Creates logical capsules and validates patch round trips."""

    async def distill(self, request: Dict[str, Any]) -> Dict[str, Any]:
        root = Path(str(request.get("workspaceRoot", request.get("workspace_root", "")))).resolve()
        if not root.is_dir():
            raise DistillationError("workspaceRoot must be an existing directory")
        _git(root, "rev-parse", "--show-toplevel")
        command = self._command(request.get("command"))
        if not command:
            raise DistillationError("command is required")
        if request.get("networkPolicy", request.get("network_policy", "deny")) != "deny":
            return self._state("unsafe_external_boundary", "live external boundaries are not supported by this reducer")

        budget = Budget.from_request(request.get("budget"))
        predicate, signature = Predicate.from_request(request.get("predicate")), Signature.from_request(request.get("signature"))
        candidates = [Candidate.from_request(item, root) for item in request.get("candidates", [])]
        if len({candidate.identifier for candidate in candidates}) != len(candidates):
            raise DistillationError("candidate units must be unique")
        environment = self._environment(request.get("environment", request.get("env", {})))
        baseline = await self._stability(root, command, environment, predicate, signature, budget)
        if baseline["matches"] < budget.minimum_matches:
            return self._state("unstable_baseline" if baseline["matches"] else "not_reproducible", "baseline did not meet its configured same-failure threshold", baseline=baseline)

        capsule_id = f"capsule_{uuid4().hex[:10]}"
        source_revision = _git(root, "rev-parse", "HEAD")
        dirty = bool(_git(root, "status", "--porcelain"))
        executions, evidence, removed, retained = baseline["attempts"], [], [], []
        active = list(candidates)
        cache: Dict[str, Dict[str, Any]] = {}
        for candidate in list(candidates):
            if executions >= budget.max_executions:
                retained.extend((item, "budget_not_tested") for item in active if item not in [r[0] for r in retained])
                break
            proposed = [*removed, candidate]
            key = self._world_hash(proposed, environment, command, source_revision)
            evaluation = cache.get(key)
            if evaluation is None:
                evaluation = await self._evaluate(root, command, environment, proposed, predicate, signature, budget)
                cache[key] = evaluation
            executions += evaluation["attempts"]
            decision = "removed" if evaluation["matches"] >= budget.minimum_matches else "retained"
            evidence.append({"candidate": candidate.identifier, "operation": "remove", "world_hash": key, "predicate": "fail" if evaluation["predicate_matches"] else "pass", "signature": "match" if evaluation["signature_matches"] else "mismatch", "runs": {"matching_failures": evaluation["matches"], "attempts": evaluation["attempts"]}, "decision": decision})
            if decision == "removed":
                removed.append(candidate)
                active = [item for item in active if item != candidate]
            else:
                retained.append((candidate, "causal_required" if evaluation["predicate_matches"] is False or evaluation["signature_matches"] is False else "unstable_when_removed"))

        status = "distilled" if not active else "stable_partial"
        artifact = self._write_capsule(root, capsule_id, command, environment, predicate, signature, budget, source_revision, dirty, baseline, active, removed, retained, evidence, status)
        return {"ok": True, "capsule_id": capsule_id, "capsuleId": capsule_id, "workspace_path": str(artifact), "workspacePath": str(artifact), "run": f"vectant repro run {capsule_id}", "status": status, "baseline": baseline, "reduction": {"candidate_units": len(candidates), "removed_units": len(removed), "retained_units": len(active), "minimality": "1-minimal_under_declared_units" if executions < budget.max_executions else "budget_limited"}, "limits": ["logical capsule: source files remain in the original workspace", "network denied; external interactions are unsupported"], "executions": executions}

    async def run(self, capsule_path: str) -> Dict[str, Any]:
        capsule = Path(capsule_path).resolve()
        repro = self._read_json(capsule / "repro.json")
        root = Path(repro["workspace_root"]).resolve()
        if not root.is_dir():
            return self._state("boundary_not_isolatable", "source workspace is no longer available")
        predicate, signature = Predicate.from_request(repro["predicate"]), Signature.from_request(repro["signature"])
        run = await self._run(self._command(repro["command"]), root, repro["environment"], int(repro["budget"]["timeout_sec"]))
        return {"ok": True, "status": "same_failure" if predicate.matches(run.exit_code, run.output) and signature.matches(run.output) else "different_outcome", "run": self._run_dict(run)}

    async def validate_patch(self, request: Dict[str, Any]) -> Dict[str, Any]:
        capsule = Path(str(request.get("capsulePath", request.get("capsule_path", "")))).resolve()
        repro, provenance = self._read_json(capsule / "repro.json"), self._read_json(capsule / "provenance.json")
        root = Path(repro["workspace_root"]).resolve()
        edits = request.get("edits", [])
        if not isinstance(edits, list) or not edits:
            raise DistillationError("edits are required")
        conflicts = []
        for edit in edits:
            path = str(edit.get("path", ""))
            entry = provenance.get(path)
            if not entry or entry.get("kind") != "file":
                conflicts.append({"path": path, "reason": "missing_or_nonproduction_provenance"})
                continue
            target = root / entry["origin"]
            if not target.is_file() or _sha256(target.read_bytes()) != entry["sha256"]:
                conflicts.append({"path": path, "reason": "source_revision_or_hash_mismatch"})
        if conflicts:
            return {"ok": False, "status": "patch_mapping_conflict", "conflicts": conflicts}
        with tempfile.TemporaryDirectory(prefix="vectant-patch-") as temp:
            worktree = Path(temp) / "worktree"
            self._create_worktree(root, worktree)
            try:
                for edit in edits:
                    entry, content = provenance[str(edit["path"])], edit.get("content")
                    if not isinstance(content, str):
                        raise DistillationError("edit content must be a string")
                    target = worktree / entry["origin"]
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_text(content, encoding="utf-8")
                predicate, signature = Predicate.from_request(repro["predicate"]), Signature.from_request(repro["signature"])
                run = await self._run(self._command(repro["command"]), worktree, repro["environment"], int(repro["budget"]["timeout_sec"]))
            finally:
                self._remove_worktree(root, worktree)
        passed = not predicate.matches(run.exit_code, run.output)
        return {"ok": passed, "status": "validated" if passed else "capsule_still_fails", "signature_after_patch": "match" if signature.matches(run.output) else "changed", "run": self._run_dict(run)}

    def _command(self, raw: Any) -> List[str]:
        if isinstance(raw, str):
            import shlex
            command = shlex.split(raw, posix=os.name != "nt")
        elif isinstance(raw, list) and all(isinstance(item, str) for item in raw):
            command = list(raw)
        else:
            command = []
        if command and any("\x00" in part for part in command):
            raise DistillationError("command contains a null byte")
        return command

    def _environment(self, raw: Any) -> Dict[str, str]:
        if not isinstance(raw, dict):
            raise DistillationError("environment must be an object")
        values = {str(key): str(value) for key, value in raw.items()}
        forbidden = [name for name in values if SECRET_NAME.search(name)]
        if forbidden:
            raise DistillationError("environment contains secret-bearing keys: " + ", ".join(forbidden))
        return values

    async def _stability(self, root: Path, command: Sequence[str], env: Dict[str, str], predicate: Predicate, signature: Signature, budget: Budget) -> Dict[str, Any]:
        runs = [await self._run(command, root, env, budget.timeout_sec) for _ in range(budget.stability_attempts)]
        matches = [run for run in runs if predicate.matches(run.exit_code, run.output) and signature.matches(run.output)]
        return {"matching_failures": len(matches), "matches": len(matches), "attempts": len(runs), "runs": [self._run_dict(run) for run in runs]}

    async def _evaluate(self, root: Path, command: Sequence[str], env: Dict[str, str], active: Sequence[Candidate], predicate: Predicate, signature: Signature, budget: Budget) -> Dict[str, Any]:
        with tempfile.TemporaryDirectory(prefix="vectant-reduce-") as temp:
            worktree = Path(temp) / "worktree"
            self._create_worktree(root, worktree)
            try:
                reduced_env = dict(env)
                for candidate in active:
                    if candidate.kind == "file":
                        target = worktree / candidate.reference
                        if target.exists():
                            target.unlink()
                    else:
                        reduced_env.pop(candidate.reference, None)
                runs = [await self._run(command, worktree, reduced_env, budget.timeout_sec) for _ in range(budget.stability_attempts)]
            finally:
                self._remove_worktree(root, worktree)
        matches = [run for run in runs if predicate.matches(run.exit_code, run.output) and signature.matches(run.output)]
        return {"matches": len(matches), "attempts": len(runs), "predicate_matches": any(predicate.matches(run.exit_code, run.output) for run in runs), "signature_matches": any(signature.matches(run.output) for run in runs)}

    def _create_worktree(self, root: Path, destination: Path) -> None:
        _git(root, "worktree", "add", "--detach", "--force", str(destination), "HEAD")
        # A worktree does not own dependencies. Link only its local install, never copy credentials.
        modules = root / "node_modules"
        if modules.is_dir() and not (destination / "node_modules").exists():
            try:
                os.symlink(modules, destination / "node_modules", target_is_directory=True)
            except OSError:
                # Node can still resolve workspace-level modules in many package layouts.
                pass

    def _remove_worktree(self, root: Path, destination: Path) -> None:
        try:
            _git(root, "worktree", "remove", "--force", str(destination))
        except DistillationError:
            shutil.rmtree(destination, ignore_errors=True)

    async def _run(self, command: Sequence[str], cwd: Path, env: Dict[str, str], timeout_sec: int) -> Run:
        started = time.perf_counter()
        runtime_env = {"PATH": os.environ.get("PATH", ""), "HOME": str(cwd), "TMPDIR": tempfile.gettempdir(), **env}
        try:
            process = await asyncio.create_subprocess_exec(*command, cwd=str(cwd), env=runtime_env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout_sec)
            return Run(process.returncode or 0, (stdout + stderr).decode("utf-8", "replace"), int((time.perf_counter() - started) * 1000))
        except asyncio.TimeoutError:
            process.kill()
            await process.communicate()
            return Run(-1, "command timed out", int((time.perf_counter() - started) * 1000), True)
        except FileNotFoundError:
            return Run(-2, "command not found", int((time.perf_counter() - started) * 1000))

    def _write_capsule(self, root: Path, capsule_id: str, command: Sequence[str], environment: Dict[str, str], predicate: Predicate, signature: Signature, budget: Budget, revision: str, dirty: bool, baseline: Dict[str, Any], active: Sequence[Candidate], removed: Sequence[Candidate], retained: Sequence[Tuple[Candidate, str]], evidence: Sequence[Dict[str, Any]], status: str) -> Path:
        capsule = root / ".vectant" / "capsules" / capsule_id
        capsule.mkdir(parents=True, exist_ok=False)
        provenance: Dict[str, Any] = {}
        for candidate in active:
            if candidate.kind == "file":
                file_path = root / candidate.reference
                if file_path.is_file():
                    provenance[candidate.reference] = {"kind": "file", "origin": candidate.reference, "revision": revision, "sha256": _sha256(file_path.read_bytes())}
        manifest = {"schema_version": "vectant.failure_capsule.v1", "capsule_id": capsule_id, "source_revision": revision, "dirty_workspace": dirty, "runtime": {"python": sys.version.split()[0], "platform": sys.platform}, "entrypoint": f"vectant repro run {capsule_id}", "status": status, "created_at": _utcnow()}
        repro = {"workspace_root": str(root), "command": list(command), "environment": environment, "predicate": predicate.to_dict(), "signature": signature.to_dict(), "budget": budget.__dict__, "baseline": baseline, "active_units": [item.__dict__ for item in active]}
        validation = {"status": "not_run", "required_gates": ["capsule_fails_before_patch", "capsule_passes_after_patch", "original_world_passes_after_mapping", "affected_checks_pass"]}
        self._write_json(capsule / "manifest.json", manifest)
        self._write_json(capsule / "repro.json", repro)
        self._write_json(capsule / "provenance.json", provenance)
        self._write_json(capsule / "evidence" / "baseline.json", baseline)
        self._write_json(capsule / "evidence" / "signature.json", signature.to_dict())
        self._write_json(capsule / "evidence" / "validation.json", validation)
        with (capsule / "reduction.ndjson").open("w", encoding="utf-8") as handle:
            for item in evidence:
                handle.write(_json(item) + "\n")
            for item, reason in retained:
                handle.write(_json({"candidate": item.identifier, "decision": "retained", "reason": reason}) + "\n")
        (capsule / "CAPSULE.md").write_text(f"# Failure capsule {capsule_id}\n\nRun: `vectant repro run {capsule_id}`\n\nStatus: {status}\n", encoding="utf-8")
        return capsule

    def _world_hash(self, active: Sequence[Candidate], env: Dict[str, str], command: Sequence[str], revision: str) -> str:
        return "sha256:" + _sha256(_json({"active": [item.identifier for item in active], "environment": env, "command": list(command), "revision": revision}).encode())

    def _run_dict(self, run: Run) -> Dict[str, Any]:
        return {"exit_code": run.exit_code, "duration_ms": run.duration_ms, "timed_out": run.timed_out, "output": run.output[-20_000:], "output_sha256": run.fingerprint()}

    def _state(self, status: str, reason: str, **extra: Any) -> Dict[str, Any]:
        return {"ok": False, "status": status, "reason": reason, **extra}

    def _write_json(self, path: Path, value: Any) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    def _read_json(self, path: Path) -> Dict[str, Any]:
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError) as exc:
            raise DistillationError(f"invalid capsule artifact: {path.name}") from exc


_failure_distiller: Optional[FailureDistiller] = None


def get_failure_distiller() -> FailureDistiller:
    global _failure_distiller
    if _failure_distiller is None:
        _failure_distiller = FailureDistiller()
    return _failure_distiller

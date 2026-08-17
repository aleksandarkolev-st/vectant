"""Evidence-backed reduction of a failing command into a logical capsule.

The reducer deliberately owns no language semantics.  It runs a supplied test
command in a disposable git worktree, uses an explicit predicate plus a
signature matcher as its oracle, and only removes declared file/environment
units.  This makes a useful, auditable first reduction boundary for pytest and
Vitest without pretending to minimise arbitrary programs.
"""

from __future__ import annotations

import asyncio
import ast
import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple
from uuid import uuid4

from .failure_distiller_adapters import AdapterContractError, normalize_adapter_observation
from .failure_distiller_execution import ContainerExecutor, ExecutionResult, IsolationError, LocalTestExecutor


STATUSES = {
    "distilled", "stable_partial", "not_reproducible", "unstable_baseline",
    "predicate_ambiguous", "boundary_not_isolatable", "budget_exhausted",
    "unsupported_runtime", "unsafe_external_boundary", "patch_mapping_conflict",
}
SECRET_NAME = re.compile(r"(?:token|secret|password|passwd|api[_-]?key|credential|private[_-]?key)", re.I)
SECRET_VALUE = re.compile(r"(?P<key>\b(?:token|secret|password|passwd|api[_-]?key|credential|private[_-]?key)\b\s*(?:=|:|is)\s*)(?P<value>[^\s,;]+)", re.I)
BEARER_VALUE = re.compile(r"\bBearer\s+[A-Za-z0-9._~+\-/=]+", re.I)
SECRET_COMMAND_ARGUMENT = re.compile(r"(?:^|[-_/])(token|secret|password|passwd|api[_-]?key|credential|private[_-]?key)(?:$|=|:)", re.I)
DEFAULT_BUDGETS = {
    "fast": {"max_executions": 100, "stability_attempts": 3, "minimum_matches": 3, "timeout_sec": 30, "parallelism": 1},
    "standard": {"max_executions": 1000, "stability_attempts": 5, "minimum_matches": 5, "timeout_sec": 60, "parallelism": 4},
    "deep": {"max_executions": 5000, "stability_attempts": 10, "minimum_matches": 9, "timeout_sec": 90, "parallelism": 8},
}


class DistillationError(ValueError):
    """A request is invalid or cannot safely be isolated."""


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)


def _oracle_events(output: str) -> Dict[str, List[str]]:
    """Read bounded, explicit runner evidence without guessing from logs.

    Supported runners may emit ``VECTANT_ORACLE:{...}`` lines.  The adapter
    intentionally ignores malformed/untyped values, so a log line cannot turn
    into network, DOM, or signal evidence by accident.
    """
    result: Dict[str, List[str]] = {"diagnostics": [], "network": [], "events": [], "dom": [], "signals": [], "stack_frames": [], "source_spans": []}
    for line in output.splitlines():
        if not line.startswith("VECTANT_ORACLE:"):
            continue
        try:
            event = json.loads(line.removeprefix("VECTANT_ORACLE:"))
        except json.JSONDecodeError:
            continue
        if not isinstance(event, dict):
            continue
        for key, target in (("diagnostic", "diagnostics"), ("network", "network"), ("event", "events"), ("dom", "dom"), ("signal", "signals"), ("stack_frame", "stack_frames"), ("source_span", "source_spans")):
            value = event.get(key)
            if isinstance(value, str) and value and len(result[target]) < 128:
                result[target].append(value)
    return result


def _redact(value: str) -> str:
    """Remove common credentials before output is persisted in capsule evidence."""
    value = SECRET_VALUE.sub(lambda match: match.group("key") + "<redacted>", value)
    return BEARER_VALUE.sub("Bearer <redacted>", value)


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
    parallelism: int

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
        if budget.max_executions < 1 or budget.stability_attempts < 1 or budget.minimum_matches < 1 or budget.parallelism < 1:
            raise DistillationError("budget values must be positive")
        if budget.minimum_matches > budget.stability_attempts:
            raise DistillationError("minimum_matches cannot exceed stability_attempts")
        return budget


@dataclass(frozen=True)
class Predicate:
    type: str = "exit_nonzero"
    required_output: Tuple[str, ...] = ()
    forbidden_output: Tuple[str, ...] = ()
    expected_exit_code: Optional[int] = None
    expected_event: Optional[str] = None
    expected_state: Optional[str] = None

    @classmethod
    def from_request(cls, raw: Any) -> "Predicate":
        raw = raw or {"type": "exit_nonzero"}
        if not isinstance(raw, dict):
            raise DistillationError("predicate must be an object")
        kind = str(raw.get("type", "exit_nonzero"))
        if kind not in {"exit_nonzero", "exit_code", "timeout", "diagnostic", "network_presence", "network_absence", "ordered_events", "dom_state", "process_signal"}:
            raise DistillationError("unsupported predicate type")
        expected_exit = raw.get("exit_code", raw.get("exitCode"))
        if expected_exit is not None and not isinstance(expected_exit, int):
            raise DistillationError("predicate exit_code must be an integer")
        expected_event = raw.get("event", raw.get("eventId", raw.get("network")))
        expected_state = raw.get("state", raw.get("domState", raw.get("signal")))
        if kind in {"diagnostic", "network_presence", "network_absence", "process_signal"} and (not isinstance(expected_event or expected_state, str) or not (expected_event or expected_state)):
            raise DistillationError(f"predicate {kind} requires a typed event, diagnostic, network, or signal value")
        return cls(
            type=kind,
            required_output=tuple(str(x) for x in raw.get("required_output", raw.get("requiredOutput", []))),
            forbidden_output=tuple(str(x) for x in raw.get("forbidden_output", raw.get("forbiddenOutput", []))),
            expected_exit_code=expected_exit,
            expected_event=expected_event if isinstance(expected_event, str) else None,
            expected_state=expected_state if isinstance(expected_state, str) else None,
        )

    def matches(self, exit_code: int, output: str, timed_out: bool = False) -> bool:
        events = _oracle_events(output)
        if self.type == "exit_nonzero":
            type_match = exit_code != 0
        elif self.type == "exit_code":
            type_match = exit_code == self.expected_exit_code
        elif self.type == "timeout":
            type_match = timed_out
        elif self.type == "diagnostic":
            type_match = self.expected_event in events.get("diagnostics", [])
        elif self.type == "network_presence":
            type_match = self.expected_event in events.get("network", [])
        elif self.type == "network_absence":
            type_match = self.expected_event not in events.get("network", [])
        elif self.type == "ordered_events":
            required = tuple(self.required_output)
            sequence = events.get("events", [])
            position = 0
            for value in sequence:
                if position < len(required) and value == required[position]:
                    position += 1
            type_match = bool(required) and position == len(required)
        elif self.type == "dom_state":
            type_match = self.expected_state in events.get("dom", [])
        else:  # process_signal
            type_match = self.expected_state in events.get("signals", [])
        return type_match and all(re.search(pattern, output, re.M) for pattern in self.required_output) and not any(re.search(pattern, output, re.M) for pattern in self.forbidden_output)

    def to_dict(self) -> Dict[str, Any]:
        return {"type": self.type, "required_output": list(self.required_output), "forbidden_output": list(self.forbidden_output), "exit_code": self.expected_exit_code, "event": self.expected_event, "state": self.expected_state}


@dataclass(frozen=True)
class Signature:
    required: Tuple[str, ...] = ()
    forbidden: Tuple[str, ...] = ()
    stack_frames: Tuple[str, ...] = ()
    source_spans: Tuple[str, ...] = ()
    event_ids: Tuple[str, ...] = ()
    network_sequence: Tuple[str, ...] = ()

    @classmethod
    def from_request(cls, raw: Any) -> "Signature":
        raw = raw or {}
        if not isinstance(raw, dict):
            raise DistillationError("signature must be an object")
        def strings(value: Any, field: str) -> Tuple[str, ...]:
            if value is None:
                return ()
            if not isinstance(value, list) or not all(isinstance(item, str) and item for item in value):
                raise DistillationError(f"signature {field} must be a list of non-empty strings")
            return tuple(value)
        return cls(
            strings(raw.get("required", []), "required"), strings(raw.get("forbidden", []), "forbidden"),
            strings(raw.get("stack_frames", raw.get("stackFrames", [])), "stack_frames"),
            strings(raw.get("source_spans", raw.get("sourceSpans", [])), "source_spans"),
            strings(raw.get("event_ids", raw.get("eventIds", [])), "event_ids"),
            strings(raw.get("network_sequence", raw.get("networkSequence", [])), "network_sequence"),
        )

    def matches(self, output: str) -> bool:
        events = _oracle_events(output)
        def ordered(expected: Tuple[str, ...], actual: List[str]) -> bool:
            index = 0
            for value in actual:
                if index < len(expected) and value == expected[index]:
                    index += 1
            return index == len(expected)
        return (all(re.search(pattern, output, re.M) for pattern in self.required)
            and not any(re.search(pattern, output, re.M) for pattern in self.forbidden)
            and all(frame in events["stack_frames"] for frame in self.stack_frames)
            and all(span in events["source_spans"] for span in self.source_spans)
            and ordered(self.event_ids, events["events"])
            and ordered(self.network_sequence, events["network"]))

    def to_dict(self) -> Dict[str, Any]:
        return {"matcher": "typed_subset", "required": list(self.required), "forbidden": list(self.forbidden), "stack_frames": list(self.stack_frames), "source_spans": list(self.source_spans), "event_ids": list(self.event_ids), "network_sequence": list(self.network_sequence)}


@dataclass(frozen=True)
class Candidate:
    kind: str
    reference: str

    @classmethod
    def from_request(cls, raw: Any, root: Path) -> "Candidate":
        if not isinstance(raw, dict):
            raise DistillationError("candidate units must be objects")
        kind, reference = raw.get("kind"), raw.get("reference")
        if kind not in {"file", "env", "json_key", "json_record", "command_arg", "python_function", "python_statement"} or not isinstance(reference, str) or not reference:
            raise DistillationError("candidate units require a supported file, config, input, or Python source-unit kind and reference")
        if kind == "file":
            reference = _safe_relative(root, reference).as_posix()
        if kind in {"json_key", "json_record"}:
            if "#" not in reference:
                raise DistillationError("JSON candidate references must be file.json#path")
            raw_file, selector = reference.split("#", 1)
            if not selector:
                raise DistillationError("JSON candidate selector is required")
            reference = f"{_safe_relative(root, raw_file).as_posix()}#{selector}"
        if kind in {"python_function", "python_statement"}:
            if "#" not in reference:
                raise DistillationError("Python source-unit references must be file.py#selector")
            raw_file, selector = reference.split("#", 1)
            relative = _safe_relative(root, raw_file)
            if relative.suffix != ".py" or not selector:
                raise DistillationError("Python source units require a .py file and selector")
            try:
                tree = ast.parse((root / relative).read_text(encoding="utf-8"))
            except (OSError, SyntaxError) as exc:
                raise DistillationError("Python source unit cannot be parsed") from exc
            if kind == "python_function" and not any(isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == selector for node in ast.walk(tree)):
                raise DistillationError("Python function candidate does not exist")
            if kind == "python_statement":
                try:
                    line = int(selector)
                except ValueError as exc:
                    raise DistillationError("Python statement selector must be a line number") from exc
                if not any(isinstance(node, ast.stmt) and getattr(node, "lineno", -1) == line for node in ast.walk(tree)):
                    raise DistillationError("Python statement candidate does not exist")
            reference = f"{relative.as_posix()}#{selector}"
        if kind == "env" and SECRET_NAME.search(reference):
            raise DistillationError("secret-bearing environment variables cannot be reduced or persisted")
        if kind == "command_arg":
            try:
                if int(reference) < 1:
                    raise ValueError
            except ValueError as exc:
                raise DistillationError("command_arg reference must be an argument index greater than zero") from exc
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
    output_sha256: str = ""
    output_truncated: bool = False

    def fingerprint(self) -> str:
        return _sha256(self.output.encode())


class FailureDistiller:
    """Creates logical capsules and validates patch round trips."""

    def __init__(self, production: bool = False) -> None:
        self._metrics = {"distillation_requests": 0, "accepted_capsules": 0, "candidate_executions": 0, "candidate_units": 0, "removed_units": 0, "cache_hits": 0, "validation_requests": 0, "validated_patches": 0, "materialization_requests": 0, "materialized_capsules": 0}
        self._production = production
        self._executor: Any = LocalTestExecutor()
        self._isolation_profile: Dict[str, Any] = {"mode": "local_test_only"}

    async def distill(self, request: Dict[str, Any]) -> Dict[str, Any]:
        self._metrics["distillation_requests"] += 1
        isolation_failure = await self._configure_execution_or_state(request)
        if isolation_failure:
            return isolation_failure
        root = Path(str(request.get("workspaceRoot", request.get("workspace_root", "")))).resolve()
        if not root.is_dir():
            raise DistillationError("workspaceRoot must be an existing directory")
        _git(root, "rev-parse", "--show-toplevel")
        command = self._command(request.get("command"))
        if not command:
            command = self._browser_replay_command(request.get("observation"), root)
        if not command:
            raise DistillationError("command is required")
        if request.get("networkPolicy", request.get("network_policy", "deny")) != "deny":
            return self._state("unsafe_external_boundary", "live external boundaries are not supported by this reducer")

        source_revision = _git(root, "rev-parse", "HEAD")
        dirty = self._workspace_dirty(root)
        if dirty:
            return self._state("boundary_not_isolatable", "dirty workspaces are not reduced because worktree candidates would not match the observed baseline; commit or stash changes first", source_revision=source_revision, dirty_workspace=True)

        budget = Budget.from_request(request.get("budget"))
        retention_seconds = int(request.get("retentionSeconds", request.get("retention_seconds", 30 * 24 * 60 * 60)))
        if retention_seconds < 60 or retention_seconds > 365 * 24 * 60 * 60:
            raise DistillationError("retentionSeconds must be between 60 seconds and 365 days")
        predicate, signature = Predicate.from_request(request.get("predicate")), Signature.from_request(request.get("signature"))
        environment_input = request.get("environment", request.get("env", {}))
        environment = self._environment(environment_input, request.get("seed"), source_revision)
        observation = self._observation(request.get("observation"), root)
        candidates = [Candidate.from_request(item, root) for item in request.get("candidates", [])]
        if request.get("autoDiscover", request.get("auto_discover", False)):
            candidates.extend(self._discover_candidates(root, command, candidates, observation, environment_input, budget))
        if len({candidate.identifier for candidate in candidates}) != len(candidates):
            raise DistillationError("candidate units must be unique")
        if budget.stability_attempts > budget.max_executions:
            return self._state("budget_exhausted", "baseline stability reservation exceeds max_executions", budget={"max_executions": budget.max_executions, "reserved_baseline": budget.stability_attempts}, untested_units=[item.identifier for item in candidates])
        baseline = await self._stability(root, command, environment, predicate, signature, budget)
        if baseline["matches"] < budget.minimum_matches:
            return self._state("unstable_baseline" if baseline["matches"] else "not_reproducible", "baseline did not meet its configured same-failure threshold", baseline=baseline)
        if not signature.required and not signature.forbidden:
            signature = self._derive_signature(baseline)
            if not signature.required:
                return self._state("predicate_ambiguous", "baseline has no stable observable signature; provide signature.required explicitly", baseline=baseline)

        capsule_id = f"capsule_{uuid4().hex[:10]}"
        runtime = self._runtime_identity(command, environment)
        executions, evidence, removed, retained = baseline["attempts"], [], [], []
        active = list(candidates)
        cache = self._load_evaluation_cache(root)
        # Coarse-to-fine reduction starts with independently meaningful
        # workflow/input/fixture/config/source groups.  A failed group is not
        # called required: the fine pass below must establish that evidence.
        coarse_complete = True
        for group_name, group in self._coarse_groups(active):
            if len(group) < 2:
                continue
            proposed = [*removed, *group]
            key = self._world_hash(proposed, environment, command, source_revision, runtime)
            evaluation = cache.get(key)
            if evaluation is None and executions + budget.stability_attempts > budget.max_executions:
                coarse_complete = False
                break
            executed_now = evaluation is None
            if evaluation is None:
                evaluation = await self._evaluate(root, command, environment, proposed, predicate, signature, budget)
                cache[key] = evaluation
                self._save_evaluation_cache(root, cache)
            else:
                self._metrics["cache_hits"] += 1
            if executed_now:
                executions += evaluation["attempts"]
            decision = "removed" if evaluation["matches"] >= budget.minimum_matches else "retained"
            evidence.append({"candidate_group": group_name, "candidates": [item.identifier for item in group], "operation": "coarse_group_remove", "world_hash": key, "predicate": "fail" if evaluation["predicate_matches"] else "pass", "signature": "match" if evaluation["signature_matches"] else "mismatch", "runs": {"matching_failures": evaluation["matches"], "attempts": evaluation["attempts"]}, "decision": decision})
            if decision == "removed":
                removed.extend(group)
                active = [item for item in active if item not in group]
        for candidate in list(candidates):
            if candidate not in active:
                continue
            proposed = [*removed, candidate]
            key = self._world_hash(proposed, environment, command, source_revision, runtime)
            evaluation = cache.get(key)
            if evaluation is None and executions + budget.stability_attempts > budget.max_executions:
                retained.extend((item, "budget_not_tested") for item in active if item not in [r[0] for r in retained])
                break
            executed_now = evaluation is None
            if evaluation is None:
                evaluation = await self._evaluate(root, command, environment, proposed, predicate, signature, budget)
                cache[key] = evaluation
                self._save_evaluation_cache(root, cache)
            else:
                self._metrics["cache_hits"] += 1
            if executed_now:
                executions += evaluation["attempts"]
            decision = "removed" if evaluation["matches"] >= budget.minimum_matches else "retained"
            evidence.append({"candidate": candidate.identifier, "operation": "remove", "world_hash": key, "predicate": "fail" if evaluation["predicate_matches"] else "pass", "signature": "match" if evaluation["signature_matches"] else "mismatch", "runs": {"matching_failures": evaluation["matches"], "attempts": evaluation["attempts"]}, "decision": decision})
            if decision == "removed":
                removed.append(candidate)
                active = [item for item in active if item != candidate]
            else:
                retained.append((candidate, "causal_required" if evaluation["predicate_matches"] is False or evaluation["signature_matches"] is False else "unstable_when_removed"))

        # The primary pass is order-sensitive. A candidate that was necessary
        # before another accepted removal can become removable afterwards, so
        # confirm 1-minimality against the final reduced world.
        confirmation_complete = coarse_complete
        confirmation_prefetch: Dict[str, Dict[str, Any]] = {}
        confirmation_index = 0
        while confirmation_index < len(active):
            candidate = active[confirmation_index]
            proposed = [*removed, candidate]
            key = self._world_hash(proposed, environment, command, source_revision, runtime)
            prefetched = confirmation_prefetch.pop(key, None)
            evaluation = prefetched or cache.get(key)
            if evaluation is None and executions + budget.stability_attempts > budget.max_executions:
                confirmation_complete = False
                retained.extend((item, "budget_not_tested") for item in active[confirmation_index:] if item not in [r[0] for r in retained])
                break
            executed_now = evaluation is None
            if evaluation is None:
                evaluation = await self._evaluate(root, command, environment, proposed, predicate, signature, budget)
                cache[key] = evaluation
                self._save_evaluation_cache(root, cache)
            else:
                self._metrics["cache_hits"] += 1
            if executed_now:
                executions += evaluation["attempts"]
            decision = "removed" if evaluation["matches"] >= budget.minimum_matches else "retained"
            evidence.append({"candidate": candidate.identifier, "operation": "confirm_remove", "world_hash": key, "predicate": "fail" if evaluation["predicate_matches"] else "pass", "signature": "match" if evaluation["signature_matches"] else "mismatch", "runs": {"matching_failures": evaluation["matches"], "attempts": evaluation["attempts"]}, "decision": decision})
            if decision == "removed":
                removed.append(candidate)
                active.remove(candidate)
                retained = [entry for entry in retained if entry[0] != candidate]
                # All remaining prefetches refer to the prior reduction world.
                # They must never influence a later greedy decision.
                confirmation_prefetch.clear()
                continue
            confirmation_index += 1
            if confirmation_prefetch or budget.parallelism == 1:
                continue
            remaining_runs = max(0, budget.max_executions - executions)
            parallel_count = min(budget.parallelism, (remaining_runs // budget.stability_attempts), len(active) - confirmation_index)
            if parallel_count < 1:
                continue
            batch = active[confirmation_index:confirmation_index + parallel_count]
            batch_keys = [self._world_hash([*removed, item], environment, command, source_revision, runtime) for item in batch]
            missing = [(item, world_key) for item, world_key in zip(batch, batch_keys) if world_key not in cache]
            if missing:
                evaluated = await asyncio.gather(*[self._evaluate(root, command, environment, [*removed, item], predicate, signature, budget) for item, _ in missing])
                for (_, world_key), result in zip(missing, evaluated):
                    cache[world_key] = result
                    confirmation_prefetch[world_key] = result
                    executions += result["attempts"]
                self._save_evaluation_cache(root, cache)
            for world_key in batch_keys:
                if world_key in cache:
                    confirmation_prefetch.setdefault(world_key, cache[world_key])

        status = "budget_exhausted" if (active and executions + budget.stability_attempts > budget.max_executions) else ("distilled" if not active else "stable_partial")
        artifact = self._write_capsule(root, capsule_id, command, environment, observation, predicate, signature, budget, source_revision, dirty, baseline, active, removed, retained, evidence, status, retention_seconds)
        self._metrics["accepted_capsules"] += 1
        self._metrics["candidate_executions"] += executions
        self._metrics["candidate_units"] += len(candidates)
        self._metrics["removed_units"] += len(removed)
        return {"ok": True, "capsule_id": capsule_id, "capsuleId": capsule_id, "workspace_path": str(artifact), "workspacePath": str(artifact), "run": f"vectant repro run {capsule_id}", "status": status, "baseline": baseline, "reduction": {"candidate_units": len(candidates), "removed_units": len(removed), "retained_units": len(active), "minimality": "1-minimal_under_declared_units" if confirmation_complete else "budget_limited"}, "limits": ["logical capsule: source files remain in the original workspace", "outbound network is not granted by this API but must be blocked by the configured host/container sandbox", "external interactions are unsupported without a validated replay or contract boundary"], "executions": executions}

    async def run(self, capsule_path: str) -> Dict[str, Any]:
        capsule = Path(capsule_path).resolve()
        repro_path = capsule / "repro.json"
        if not repro_path.is_file():
            repro_path = capsule / ".vectant-materialized-repro.json"
        repro = self._read_json(repro_path)
        isolation_failure = await self._configure_execution_or_state(repro)
        if isolation_failure:
            return isolation_failure
        root = Path(repro["workspace_root"]).resolve()
        if not root.is_dir():
            return self._state("boundary_not_isolatable", "source workspace is no longer available")
        predicate, signature = Predicate.from_request(repro["predicate"]), Signature.from_request(repro["signature"])
        if repro.get("mode") == "materialized":
            integrity_path = root / ".vectant-integrity.json"
            if not integrity_path.is_file() or self._read_json(integrity_path) != self._materialized_integrity(root):
                return self._state("boundary_not_isolatable", "materialized capsule integrity check failed")
            run = await self._run(self._command(repro["command"]), root, repro["environment"], int(repro["budget"]["timeout_sec"]))
            return {"ok": True, "status": "same_failure" if predicate.matches(run.exit_code, run.output, run.timed_out) and signature.matches(run.output) else "different_outcome", "run": self._run_dict(run)}
        with self._temporary_worktree_root(root) as temp:
            worktree = Path(temp) / "w"
            self._create_worktree(root, worktree)
            try:
                removed = [Candidate(**item) for item in repro.get("removed_units", [])]
                environment = self._apply_reductions(worktree, repro["environment"], removed)
                run = await self._run(self._reduced_command(self._command(repro["command"]), removed), worktree, environment, int(repro["budget"]["timeout_sec"]))
            finally:
                self._remove_worktree(root, worktree)
        return {"ok": True, "status": "same_failure" if predicate.matches(run.exit_code, run.output, run.timed_out) and signature.matches(run.output) else "different_outcome", "run": self._run_dict(run)}

    async def materialize(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """Create a portable physical capsule from a verified logical capsule.

        The destination is created once and never overwritten.  Source is
        copied from a detached worktree, then the recorded reductions are
        applied before a same-signature replay proves the exported workspace.
        """
        self._metrics["materialization_requests"] += 1
        capsule = Path(str(request.get("capsulePath", request.get("capsule_path", "")))).resolve()
        repro = self._read_json(capsule / "repro.json")
        isolation_failure = await self._configure_execution_or_state(repro)
        if isolation_failure:
            return isolation_failure
        root = Path(repro["workspace_root"]).resolve()
        if not root.is_dir():
            return self._state("boundary_not_isolatable", "source workspace is no longer available")
        destination_raw = request.get("destination")
        destination = Path(str(destination_raw)).resolve() if destination_raw else capsule / "materialized"
        if destination.exists():
            raise DistillationError("materialized capsule destination already exists")
        try:
            destination.relative_to(capsule.parent if not destination_raw else root.parent)
        except ValueError as exc:
            raise DistillationError("materialized destination must remain below the capsule store or workspace parent") from exc
        with self._temporary_worktree_root(root) as temp:
            worktree = Path(temp) / "w"
            self._create_worktree(root, worktree)
            try:
                reduced_env = self._apply_reductions(worktree, repro["environment"], [Candidate(**item) for item in repro.get("removed_units", [])])
                provenance = self._read_json(capsule / "provenance.json")
                retained_paths = self._materialized_paths(worktree, repro, provenance)
                self._copy_materialized_paths(worktree, destination, retained_paths)
                node_dependencies = self._copy_node_dependency_closure(root, worktree, destination, retained_paths)
                python_dependencies = self._copy_python_dependency_closure(worktree, destination, retained_paths)
                if python_dependencies:
                    vendor = str(destination / ".vectant" / "python")
                    reduced_env["PYTHONPATH"] = vendor + (os.pathsep + reduced_env["PYTHONPATH"] if reduced_env.get("PYTHONPATH") else "")
                predicate, signature = Predicate.from_request(repro["predicate"]), Signature.from_request(repro["signature"])
                portable_command = self._portable_command(self._reduced_command(self._command(repro["command"]), [Candidate(**item) for item in repro.get("removed_units", [])]), worktree, destination)
                run = await self._run(portable_command, destination, reduced_env, int(repro["budget"]["timeout_sec"]))
            except Exception:
                shutil.rmtree(destination, ignore_errors=True)
                raise
            finally:
                self._remove_worktree(root, worktree)
        if not predicate.matches(run.exit_code, run.output) or not signature.matches(run.output):
            shutil.rmtree(destination, ignore_errors=True)
            return self._state("boundary_not_isolatable", "materialized workspace did not reproduce the same failure", run=self._run_dict(run))
        materialized_repro = {**repro, "workspace_root": str(destination), "command": portable_command, "environment": reduced_env, "mode": "materialized"}
        self._write_json(destination / ".vectant-materialized-repro.json", materialized_repro)
        self._write_json(destination / ".vectant-runtime.json", {
            "schema_version": "vectant.failure_capsule.runtime.v1", "runtime": repro["runtime"],
            "dependency_policy": {"network_install": "denied", "lifecycle_scripts": "denied", "source_workspace_dependency": "forbidden"},
            "integrity": {"algorithm": "sha256", "manifest": ".vectant-integrity.json"},
        })
        (destination / "CAPSULE.md").write_text(
            "# Materialized failure capsule\n\n"
            "This workspace was verified against its source capsule.\n\n"
            "Run: `vectant repro run .`\n",
            encoding="utf-8",
        )
        integrity = self._materialized_integrity(destination)
        self._write_json(destination / ".vectant-integrity.json", integrity)
        self._metrics["materialized_capsules"] += 1
        return {"ok": True, "status": "materialized", "workspace_path": str(destination), "workspacePath": str(destination), "run": self._run_dict(run), "retained_paths": sorted(retained_paths), "node_dependencies": node_dependencies, "python_dependencies": python_dependencies, "integrity_path": str(destination / ".vectant-integrity.json"), "limits": ["dependency installation and lifecycle scripts are denied", "source closure is conservative and verified by same-signature replay"]}

    def export_vivarium_manifest(self, capsule_path: str) -> Dict[str, Any]:
        """Export a sanitized, deterministic handoff contract for Agent Dojo Vivarium.

        The manifest is deliberately a handoff only: it cannot replace the
        original capsule oracle or original-world patch validation.  A Vivarium
        consumer must revalidate its synthetic-world oracle against this
        baseline before it can be used for regression or practice.
        """
        capsule = Path(capsule_path).resolve()
        repro = self._read_json(capsule / "repro.json")
        manifest = self._read_json(capsule / "manifest.json")
        capsule_id = str(manifest.get("capsule_id", ""))
        if not capsule_id:
            raise DistillationError("capsule manifest is missing capsule_id")
        command = self._command(repro.get("command"))
        if any(SECRET_COMMAND_ARGUMENT.search(part) for part in command):
            return self._state("unsafe_external_boundary", "capsule command contains a secret-bearing argument and cannot cross into Vivarium")
        units = [Candidate(**item) for item in repro.get("active_units", [])]
        fixture_kinds = sorted({
            "fake_database_state" if unit.kind in {"file", "json_key", "json_record"} else
            "synthetic_page_route" if unit.kind == "command_arg" else
            "fake_validation_errors"
            for unit in units
        }) or ["fake_database_state"]
        seed = _sha256(_json({"capsule_id": capsule_id, "source_revision": manifest.get("source_revision"), "removed_units": repro.get("removed_units", [])}).encode())[:32]
        scenario_id = f"distiller_{capsule_id}"
        scenario = {
            "schema_version": "synthi.dojo.failureCapsuleScenario.v1",
            "scenario_id": scenario_id,
            "capsule": {
                "capsule_id": capsule_id,
                "source_revision": manifest.get("source_revision"),
                "world_hash": _sha256(_json({"revision": manifest.get("source_revision"), "command": command, "removed": repro.get("removed_units", [])}).encode()),
                "run_command": command,
            },
            "synthetic_fixture_requirements": [
                {"fixture_id": f"{scenario_id}_{kind}", "kind": kind, "synthetic_data_only": True, "required": True}
                for kind in fixture_kinds
            ],
            "boundary_mocks": [],
            "reset_profile": {"reset_profile_id": f"reset_{scenario_id}", "strategy": "deterministic_seed", "seed": seed},
            "oracle": {"predicate": repro["predicate"], "failure_signature": repro["signature"], "baseline": repro["baseline"]},
            "evidence": {"capsule_id": capsule_id, "scenario_id": scenario_id, "source_revision": manifest.get("source_revision"), "fixture_manifest_sha256": _sha256(_json(fixture_kinds).encode()), "redaction": "capsule_output_and_environment_secret_policy"},
            "limits": ["synthetic Vivarium materialization must match this capsule predicate and signature before use", "original-world validation remains required for every candidate patch", "production credentials, production write authority, and unredacted production data are prohibited"],
        }
        path = capsule / "vivarium.scenario.json"
        self._write_json(path, scenario)
        self._append_vivarium_evidence(capsule, {
            "event": "vivarium_manifest_exported",
            "capsule_id": capsule_id,
            "scenario_id": scenario_id,
            "source_revision": manifest.get("source_revision"),
            "world_hash": scenario["capsule"]["world_hash"],
            "fixture_manifest_sha256": scenario["evidence"]["fixture_manifest_sha256"],
            "oracle_result": "not_run",
            "redaction": scenario["evidence"]["redaction"],
        })
        return {"ok": True, "status": "vivarium_manifest_exported", "capsule_id": capsule_id, "capsuleId": capsule_id, "scenario_id": scenario_id, "scenarioId": scenario_id, "manifest_path": str(path), "manifestPath": str(path), "manifest": scenario}

    def promote_vivarium_scenario(self, capsule_path: str, mode: str = "regression") -> Dict[str, Any]:
        """Version a validated capsule as a Vivarium regression or practice artifact."""
        if mode not in {"regression", "practice"}:
            raise DistillationError("Vivarium promotion mode must be regression or practice")
        capsule = Path(capsule_path).resolve()
        validation = self._read_json(capsule / "evidence" / "validation.json")
        if validation.get("status") != "validated":
            return self._state("boundary_not_isolatable", "Vivarium promotion requires a capsule patch validated in the original world", validation_status=validation.get("status", "not_run"))
        source = capsule / "vivarium.scenario.json"
        if not source.is_file():
            exported = self.export_vivarium_manifest(str(capsule))
            if not exported.get("ok"):
                return exported
        scenario = self._read_json(source)
        revision = _sha256(_json({"scenario": scenario, "validation": validation, "mode": mode}).encode())[:16]
        promoted = {
            "schema_version": "synthi.dojo.failureCapsulePromotion.v1",
            "promotion_id": f"promotion_{scenario['scenario_id']}_{revision}",
            "kind": mode,
            "scenario": scenario,
            "source_validation": {"status": validation["status"], "validated_at": validation.get("validated_at"), "patch_mapping": validation.get("patch_mapping", {})},
            "version": {"source_revision": scenario["capsule"]["source_revision"], "artifact_revision": revision},
            "limits": ["This is a synthetic regression/practice artifact, not the original incident evidence", "original-world validation remains authoritative for production patches"],
        }
        destination = capsule / "vivarium" / mode / f"{revision}.json"
        self._write_json(destination, promoted)
        self._append_vivarium_evidence(capsule, {
            "event": "vivarium_promoted",
            "capsule_id": scenario["capsule"]["capsule_id"],
            "scenario_id": scenario["scenario_id"],
            "source_revision": scenario["capsule"]["source_revision"],
            "world_hash": scenario["capsule"]["world_hash"],
            "fixture_manifest_sha256": scenario["evidence"]["fixture_manifest_sha256"],
            "oracle_result": "original_world_patch_validated",
            "redaction": scenario["evidence"]["redaction"],
            "promotion_id": promoted["promotion_id"],
        })
        return {"ok": True, "status": "vivarium_promoted", "promotion_id": promoted["promotion_id"], "promotionId": promoted["promotion_id"], "mode": mode, "artifact_path": str(destination), "artifactPath": str(destination), "artifact": promoted}

    def discard(self, capsule_path: str) -> Dict[str, Any]:
        """Permanently delete a capsule only from its source workspace store."""
        capsule = Path(capsule_path).resolve()
        try:
            repro = self._read_json(capsule / "repro.json")
            root = Path(repro["workspace_root"]).resolve()
            store = (root / ".vectant" / "capsules").resolve()
            capsule.relative_to(store)
        except (DistillationError, KeyError, ValueError) as exc:
            raise DistillationError("capsulePath must identify a capsule in its source workspace store") from exc
        if capsule.parent != store or not capsule.is_dir():
            raise DistillationError("capsulePath must identify one direct capsule directory")
        capsule_id = capsule.name
        audit = root / ".vectant" / "capsule-deletions.ndjson"
        with audit.open("a", encoding="utf-8") as handle:
            handle.write(_json({"capsule_id": capsule_id, "deleted_at": _utcnow(), "event": "capsule_deleted"}) + "\n")
        shutil.rmtree(capsule)
        return {"ok": True, "status": "deleted", "capsule_id": capsule_id, "capsuleId": capsule_id, "audit_path": str(audit)}

    def explain(self, capsule_path: str, unit: str) -> Dict[str, Any]:
        capsule = Path(capsule_path).resolve()
        if not isinstance(unit, str) or not unit.strip():
            raise DistillationError("unit is required")
        entries = []
        try:
            for line in (capsule / "reduction.ndjson").read_text(encoding="utf-8").splitlines():
                row = json.loads(line)
                if row.get("candidate") in {unit, f"file:{unit}", f"env:{unit}", f"python_function:{unit}", f"python_statement:{unit}"}:
                    entries.append(row)
        except (OSError, json.JSONDecodeError) as exc:
            raise DistillationError("invalid capsule reduction evidence") from exc
        return {"ok": bool(entries), "capsule_path": str(capsule), "unit": unit, "evidence": entries, "reason": None if entries else "unit_not_found"}

    def purge_expired(self, workspace_root: str, now: Optional[datetime] = None) -> Dict[str, Any]:
        """Delete only expired direct capsule entries and retain an audit trail."""
        root = Path(workspace_root).resolve()
        store = root / ".vectant" / "capsules"
        if not root.is_dir() or not store.is_dir():
            return {"ok": True, "status": "no_capsules", "deleted": []}
        current = now or datetime.now(timezone.utc)
        deleted = []
        for capsule in sorted(store.iterdir()):
            if not capsule.is_dir() or capsule.is_symlink():
                continue
            try:
                manifest = self._read_json(capsule / "manifest.json")
                expires_at = datetime.fromisoformat(str(manifest["retention"]["expires_at"]))
                if expires_at.tzinfo is None or expires_at > current:
                    continue
                result = self.discard(str(capsule))
                deleted.append(result["capsule_id"])
            except (KeyError, ValueError, DistillationError):
                continue
        return {"ok": True, "status": "purged", "deleted": deleted}

    async def validate_patch(self, request: Dict[str, Any]) -> Dict[str, Any]:
        self._metrics["validation_requests"] += 1
        capsule = Path(str(request.get("capsulePath", request.get("capsule_path", "")))).resolve()
        repro, provenance = self._read_json(capsule / "repro.json"), self._read_json(capsule / "provenance.json")
        isolation_failure = await self._configure_execution_or_state(repro)
        if isolation_failure:
            return isolation_failure
        root = Path(repro["workspace_root"]).resolve()
        edits = request.get("edits", [])
        if not edits:
            overlay = Path(str(repro.get("editable_workspace", capsule / "overlay"))).resolve()
            edits = []
            for relative, entry in provenance.items():
                candidate = overlay / relative
                if candidate.is_file() and _sha256(candidate.read_bytes()) != entry.get("sha256"):
                    edits.append({"path": relative, "content": candidate.read_text(encoding="utf-8")})
        if not isinstance(edits, list) or not edits:
            raise DistillationError("edits are required, or edit retained files under the capsule overlay")
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
            return {"ok": False, "status": "patch_mapping_conflict", "conflicts": conflicts, "mismatch": {"classification": "patch_map_conflict", "message": "The editable capsule path cannot be mapped safely to the recorded production revision."}}
        predicate, signature = Predicate.from_request(repro["predicate"]), Signature.from_request(repro["signature"])
        before = await self.run(str(capsule))
        if before.get("status") != "same_failure":
            return self._record_validation(capsule, {"ok": False, "status": "capsule_baseline_invalid", "gates": {"capsule_fails_before_patch": before}})
        with self._temporary_worktree_root(root) as temp:
            capsule_worktree, original_worktree = Path(temp) / "c", Path(temp) / "o"
            self._create_worktree(root, capsule_worktree)
            self._create_worktree(root, original_worktree)
            try:
                for edit in edits:
                    entry, content = provenance[str(edit["path"])], edit.get("content")
                    if not isinstance(content, str):
                        raise DistillationError("edit content must be a string")
                    for worktree in (capsule_worktree, original_worktree):
                        target = worktree / entry["origin"]
                        target.parent.mkdir(parents=True, exist_ok=True)
                        target.write_text(content, encoding="utf-8")
                capsule_env = self._apply_reductions(capsule_worktree, repro["environment"], [Candidate(**item) for item in repro.get("removed_units", [])])
                capsule_run = await self._run(self._reduced_command(self._command(repro["command"]), [Candidate(**item) for item in repro.get("removed_units", [])]), capsule_worktree, capsule_env, int(repro["budget"]["timeout_sec"]))
                original_run = await self._run(self._command(repro["command"]), original_worktree, repro["environment"], int(repro["budget"]["timeout_sec"]))
                affected = []
                requested_checks = request.get("affectedChecks", request.get("affected_checks", []))
                if not isinstance(requested_checks, list):
                    raise DistillationError("affected checks must be a command list")
                # Gate four cannot be silently skipped.  When callers have no
                # richer impact selection yet, replay the original command as
                # the conservative affected-check baseline.
                affected_source = "caller_selected" if requested_checks else "original_failure_command"
                for raw_command in (requested_checks or [repro["command"]]):
                    check_command = self._command(raw_command)
                    if not check_command:
                        raise DistillationError("affected checks must be non-empty commands")
                    affected_run = await self._run(check_command, original_worktree, repro["environment"], int(repro["budget"]["timeout_sec"]))
                    affected.append({"command": check_command, "source": affected_source, "run": self._run_dict(affected_run)})
            finally:
                self._remove_worktree(root, capsule_worktree)
                self._remove_worktree(root, original_worktree)
        # A disappeared signature is not a fixed world if the runner itself
        # now fails (for example, an invalid test file or a load error).
        capsule_passes = capsule_run.exit_code == 0 and not predicate.matches(capsule_run.exit_code, capsule_run.output)
        original_passes = original_run.exit_code == 0 and not predicate.matches(original_run.exit_code, original_run.output)
        failed_checks = [check for check in affected if check["run"]["exit_code"] != 0]
        status = "validated" if capsule_passes and original_passes and not failed_checks else ("capsule_fix_failed" if not capsule_passes else "original_validation_failed" if not original_passes else "affected_checks_failed")
        if status == "validated":
            self._metrics["validated_patches"] += 1
        mismatch = None
        if capsule_passes and not original_passes:
            mismatch = {
                "classification": self._classify_validation_mismatch(repro, capsule_run, original_run, signature),
                "boundary_action": "invalidate_and_expand",
                "removed_units_to_restore": repro.get("removed_units", []),
                "message": "The mapped patch passes the capsule but not the original envelope; the capsule is not a sufficient validation boundary.",
            }
            manifest = self._read_json(capsule / "manifest.json")
            manifest["status"] = "boundary_invalidated"
            manifest["invalidated_at"] = _utcnow()
            self._write_json(capsule / "manifest.json", manifest)
        return self._record_validation(capsule, {"ok": status == "validated", "status": status, "gates": {"capsule_fails_before_patch": before, "capsule_passes_after_patch": self._run_dict(capsule_run), "original_failure_passes_after_mapping": self._run_dict(original_run), "affected_checks": affected}, "patch_mapping": {"mapped_files": [provenance[str(edit["path"])]["origin"] for edit in edits]}, "signature_after_patch": "match" if signature.matches(original_run.output) else "changed", "mismatch": mismatch})

    def _classify_validation_mismatch(self, repro: Dict[str, Any], capsule_run: Run, original_run: Run, signature: Signature) -> str:
        output = original_run.output.lower()
        if re.search(r"(?:modulenotfounderror|importerror|cannot find module|no module named)", output):
            return "missing_dependency"
        removed = repro.get("removed_units", [])
        if any("mock" in str(item.get("reference", "")).lower() or "fixture" in str(item.get("reference", "")).lower() for item in removed if isinstance(item, dict)):
            return "invalid_mock"
        if signature.matches(original_run.output):
            return "weak_signature"
        if not removed:
            return "environment_drift"
        return "missing_causal_dependency"

    def metrics(self) -> Dict[str, Any]:
        accepted = self._metrics["accepted_capsules"]
        candidates = self._metrics["candidate_units"]
        return {**self._metrics, "reduction_ratio": self._metrics["removed_units"] / candidates if candidates else 0.0, "cache_hit_rate": self._metrics["cache_hits"] / (self._metrics["cache_hits"] + self._metrics["candidate_executions"]) if (self._metrics["cache_hits"] + self._metrics["candidate_executions"]) else 0.0, "patch_validation_rate": self._metrics["validated_patches"] / self._metrics["validation_requests"] if self._metrics["validation_requests"] else 0.0, "average_candidate_executions": self._metrics["candidate_executions"] / accepted if accepted else 0.0}

    async def _configure_execution(self, request: Dict[str, Any]) -> None:
        if not self._production:
            return
        try:
            profile = request.get("isolation", request.get("isolation_profile"))
            self._executor = ContainerExecutor.from_request(profile)
            if not shutil.which(self._executor.engine):
                raise IsolationError(f"required isolation engine is unavailable: {self._executor.engine}")
            probe = await asyncio.create_subprocess_exec(self._executor.engine, "info", stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
            if await probe.wait() != 0:
                raise IsolationError(f"required isolation engine is not running: {self._executor.engine}")
            self._isolation_profile = {"mode": "container", "engine": self._executor.engine, "image": self._executor.image, "network": "deny", "memory_mb": self._executor.memory_mb, "cpu_count": self._executor.cpu_count, "process_limit": self._executor.process_limit, "package_install": "deny", "lifecycle_scripts": "deny"}
        except IsolationError as exc:
            raise DistillationError(f"unsafe_external_boundary: {exc}") from exc

    async def _configure_execution_or_state(self, request: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        try:
            await self._configure_execution(request)
        except DistillationError as exc:
            message = str(exc)
            if message.startswith("unsafe_external_boundary:"):
                return self._state("unsafe_external_boundary", message.split(":", 1)[1].strip(), isolation_profile=request.get("isolation", request.get("isolation_profile")))
            raise
        return None

    def _workspace_dirty(self, root: Path) -> bool:
        """Treat Vectant's own durable evidence store as outside source state."""
        entries = _git(root, "status", "--porcelain", "--untracked-files=all").splitlines()
        for entry in entries:
            path = entry[3:].replace("\\", "/") if len(entry) > 3 else entry
            if not path.startswith(".vectant/") and path != ".vectant":
                return True
        return False

    def _evaluation_cache_path(self, root: Path) -> Path:
        return root / ".vectant" / "cache" / "evaluations.json"

    def _load_evaluation_cache(self, root: Path) -> Dict[str, Dict[str, Any]]:
        path = self._evaluation_cache_path(root)
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except (OSError, json.JSONDecodeError):
            return {}

    def _save_evaluation_cache(self, root: Path, cache: Dict[str, Dict[str, Any]]) -> None:
        """Persist only content-addressed boolean/oracle outcomes atomically."""
        path = self._evaluation_cache_path(root)
        path.parent.mkdir(parents=True, exist_ok=True)
        # Bound cache growth and avoid persisting raw command output.
        retained = dict(list(cache.items())[-10_000:])
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps(retained, sort_keys=True, separators=(",", ":")), encoding="utf-8")
        os.replace(temporary, path)

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
        if any(SECRET_COMMAND_ARGUMENT.search(part) for part in command):
            raise DistillationError("command contains a secret-bearing argument")
        return command

    def _browser_replay_command(self, raw: Any, root: Path) -> List[str]:
        """Accept only a digest-attested replay command from a browser trace."""
        if not isinstance(raw, dict) or str(raw.get("kind", raw.get("type", ""))).lower() != "browser":
            return []
        command = self._command(raw.get("replay_command", raw.get("replayCommand")))
        digest = raw.get("replay_command_sha256", raw.get("replayCommandSha256"))
        if not command:
            return []
        if not isinstance(digest, str) or digest != _sha256(_json(command).encode()):
            raise DistillationError("browser replay command requires a matching replay_command_sha256 attestation")
        for part in command[1:]:
            value = Path(part)
            if value.is_absolute():
                try:
                    value.resolve().relative_to(root)
                except ValueError as exc:
                    raise DistillationError("browser replay command may not reference files outside the workspace") from exc
        return command

    def _reduced_command(self, command: Sequence[str], reductions: Sequence[Candidate]) -> List[str]:
        indexes = sorted({int(item.reference) for item in reductions if item.kind == "command_arg"}, reverse=True)
        reduced = list(command)
        for index in indexes:
            if index < len(reduced):
                reduced.pop(index)
        return reduced

    def _environment(self, raw: Any, seed: Any = None, source_revision: str = "") -> Dict[str, str]:
        if not isinstance(raw, dict):
            raise DistillationError("environment must be an object")
        values = {str(key): str(value) for key, value in raw.items()}
        forbidden = [name for name in values if SECRET_NAME.search(name)]
        if forbidden:
            raise DistillationError("environment contains secret-bearing keys: " + ", ".join(forbidden))
        if seed is not None and (not isinstance(seed, (str, int)) or not str(seed).strip()):
            raise DistillationError("seed must be a non-empty string or integer")
        # These are process-level controls available to common Python/Node test
        # runners. The source-derived seed preserves replay identity without
        # persisting host state; callers may explicitly override any control.
        normalized = {
            "TZ": "UTC",
            "LANG": "C",
            "LC_ALL": "C",
            "PYTHONHASHSEED": "0",
            "VECTANT_FAILURE_SEED": str(seed).strip() if seed is not None else _sha256(source_revision.encode())[:32],
        }
        return {**normalized, **values}

    def _observation(self, raw: Any, root: Path) -> Dict[str, Any]:
        """Normalize a small, redacted observed-failure envelope for provenance."""
        if raw is None:
            return {}
        if not isinstance(raw, dict):
            raise DistillationError("observation must be an object")
        kind = str(raw.get("kind", raw.get("type", "command"))).strip().lower()
        if kind not in {"command", "test", "hmr", "browser", "native", "gpu"}:
            raise DistillationError("unsupported observation kind")
        observation = {"kind": kind}
        for key in ("event_ref", "eventRef", "message"):
            value = raw.get(key)
            if isinstance(value, str) and value.strip():
                target = "event_ref" if key in {"event_ref", "eventRef"} else "message"
                observation[target] = _redact(value.strip())[:2_000]
        file_path = raw.get("file_path", raw.get("filePath"))
        if isinstance(file_path, str) and file_path.strip():
            observation["file_path"] = _safe_relative(root, file_path.strip()).as_posix()
        path_fields = {
            "executed_paths": raw.get("executed_paths", raw.get("executedPaths", [])),
            "fixture_paths": raw.get("fixture_paths", raw.get("fixturePaths", [])),
            "config_paths": raw.get("config_paths", raw.get("configPaths", [])),
        }
        for key, values in path_fields.items():
            if values is None:
                continue
            if not isinstance(values, list) or not all(isinstance(value, str) and value.strip() for value in values):
                raise DistillationError(f"observation {key} must be a list of workspace-relative paths")
            normalized = sorted({_safe_relative(root, value.strip()).as_posix() for value in values})
            if len(normalized) > 500:
                raise DistillationError(f"observation {key} exceeds the 500-path limit")
            if normalized:
                observation[key] = normalized
        # Runtime adapters must receive an attested recording rather than a
        # free-form message.  The generic reducer persists the normalised
        # adapter contract and uses its paths as the only auto-discovery
        # frontier; it never invents browser/native/GPU evidence.
        if kind in {"browser", "native", "hmr", "gpu"}:
            try:
                envelope = normalize_adapter_observation(raw)
            except AdapterContractError as exc:
                raise DistillationError(f"boundary_not_isolatable: {exc}") from exc
            observation["adapter"] = {"kind": envelope.kind, "recording": envelope.recording, "candidate_groups": envelope.candidate_groups}
            if kind == "browser":
                linked_paths = []
                for event in envelope.recording.get("source_events", []):
                    if isinstance(event, str):
                        path = event.rsplit(":", 1)[0]
                        if path and (root / path).is_file():
                            linked_paths.append(_safe_relative(root, path).as_posix())
                if linked_paths:
                    observation["executed_paths"] = sorted(set(observation.get("executed_paths", []) + linked_paths))
        return observation

    def _runtime_identity(self, command: Sequence[str], environment: Dict[str, str]) -> Dict[str, Any]:
        """Capture reproducibility-relevant runtime facts without inheriting secrets."""
        executable = shutil.which(command[0]) if command else None
        version = ""
        if executable:
            try:
                probe = subprocess.run([executable, "--version"], capture_output=True, text=True, timeout=5, check=False)
                version = _redact((probe.stdout or probe.stderr).strip())[:1_000]
            except (OSError, subprocess.SubprocessError):
                version = "unavailable"
        return {
            "command_executable": executable or (command[0] if command else ""),
            "command_version": version or "unavailable",
            "python": sys.version.split()[0],
            "platform": sys.platform,
            "timezone": time.tzname[0] if time.tzname else "unknown",
            "locale": os.environ.get("LANG") or os.environ.get("LC_ALL") or "unspecified",
            "declared_environment_keys": sorted(environment),
        }

    def _derive_signature(self, baseline: Dict[str, Any]) -> Signature:
        """Derive a conservative output signature shared by baseline failures."""
        outputs = [str(run.get("output", "")) for run in baseline.get("runs", [])]
        normalized_sets = []
        for output in outputs:
            lines = []
            for line in output.splitlines():
                line = re.sub(r"\b(?:[A-Za-z]:)?[/\\][^\s:]+", "<path>", line.strip())
                line = re.sub(r":\d+(?::\d+)?\b", ":<line>", line)
                if line and (re.search(r"fail|error|exception|assert|traceback|signature", line, re.I) or len(lines) < 1):
                    lines.append(line)
            normalized_sets.append(set(lines[:8]))
        shared = set.intersection(*normalized_sets) if normalized_sets else set()
        selected = sorted(shared, key=lambda value: ("FailureSignature" not in value, len(value)))[:3]
        return Signature(tuple(re.escape(value) for value in selected))

    async def _stability(self, root: Path, command: Sequence[str], env: Dict[str, str], predicate: Predicate, signature: Signature, budget: Budget) -> Dict[str, Any]:
        runs = [await self._run(command, root, env, budget.timeout_sec) for _ in range(budget.stability_attempts)]
        matches = [run for run in runs if predicate.matches(run.exit_code, run.output, run.timed_out) and signature.matches(run.output)]
        return {"matching_failures": len(matches), "matches": len(matches), "attempts": len(runs), "runs": [self._run_dict(run) for run in runs]}

    async def _evaluate(self, root: Path, command: Sequence[str], env: Dict[str, str], active: Sequence[Candidate], predicate: Predicate, signature: Signature, budget: Budget) -> Dict[str, Any]:
        with self._temporary_worktree_root(root) as temp:
            worktree = Path(temp) / "w"
            self._create_worktree(root, worktree)
            try:
                reduced_env = self._apply_reductions(worktree, env, active)
                reduced_command = self._reduced_command(command, active)
                runs = [await self._run(reduced_command, worktree, reduced_env, budget.timeout_sec) for _ in range(budget.stability_attempts)]
            finally:
                self._remove_worktree(root, worktree)
        matches = [run for run in runs if predicate.matches(run.exit_code, run.output, run.timed_out) and signature.matches(run.output)]
        return {"matches": len(matches), "attempts": len(runs), "predicate_matches": any(predicate.matches(run.exit_code, run.output, run.timed_out) for run in runs), "signature_matches": any(signature.matches(run.output) for run in runs)}

    def _create_worktree(self, root: Path, destination: Path) -> None:
        _git(root, "worktree", "add", "--detach", "--force", str(destination), "HEAD")

    def _temporary_worktree_root(self, root: Path):
        """Prefer a very short temp root on Windows for deep repository paths."""
        directory = root.anchor if os.name == "nt" and root.anchor else None
        return tempfile.TemporaryDirectory(prefix="vfd-", dir=directory)

    def _remove_worktree(self, root: Path, destination: Path) -> None:
        try:
            _git(root, "worktree", "remove", "--force", str(destination))
        except DistillationError:
            shutil.rmtree(destination, ignore_errors=True)

    def _apply_reductions(self, worktree: Path, environment: Dict[str, str], reductions: Sequence[Candidate]) -> Dict[str, str]:
        """Apply declared, reversible reduction operations only inside a worktree."""
        reduced_env = dict(environment)
        for candidate in reductions:
            if candidate.kind == "env":
                reduced_env.pop(candidate.reference, None)
                continue
            if candidate.kind == "command_arg":
                continue
            if candidate.kind == "file":
                target = worktree / candidate.reference
                if target.is_file() or target.is_symlink():
                    target.unlink()
                continue
            if candidate.kind in {"python_function", "python_statement"}:
                raw_file, selector = candidate.reference.split("#", 1)
                self._remove_python_unit(worktree / raw_file, candidate.kind, selector)
                continue
            file_ref, selector = candidate.reference.split("#", 1)
            target = worktree / file_ref
            if not target.is_file():
                continue
            try:
                data = json.loads(target.read_text(encoding="utf-8"))
                parent, key = self._json_parent(data, selector)
            except (json.JSONDecodeError, KeyError, IndexError, ValueError):
                continue
            if isinstance(parent, dict):
                parent.pop(key, None)
            elif isinstance(parent, list):
                try:
                    parent.pop(int(key))
                except (ValueError, IndexError):
                    continue
            target.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        return reduced_env

    def _json_parent(self, data: Any, selector: str) -> Tuple[Any, str]:
        parts = [part.replace("~1", "/").replace("~0", "~") for part in selector.strip("/").split("/") if part]
        if not parts:
            raise ValueError("JSON selector cannot name the document root")
        current = data
        for part in parts[:-1]:
            current = current[int(part)] if isinstance(current, list) else current[part]
        return current, parts[-1]

    def _remove_python_unit(self, target: Path, kind: str, selector: str) -> None:
        """Remove a precise AST span while retaining diagnostic line numbers."""
        try:
            source = target.read_text(encoding="utf-8")
            tree = ast.parse(source)
        except (OSError, SyntaxError) as exc:
            raise DistillationError("Python source unit cannot be reduced after materialization") from exc
        selected = None
        for node in ast.walk(tree):
            if kind == "python_function" and isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == selector:
                selected = node
                break
            if kind == "python_statement" and isinstance(node, ast.stmt) and getattr(node, "lineno", -1) == int(selector):
                selected = node
                break
        if selected is None or not getattr(selected, "end_lineno", None):
            raise DistillationError("Python source unit no longer has a safe source span")
        if kind == "python_statement" and not isinstance(selected, (ast.Expr, ast.Assign, ast.AnnAssign, ast.AugAssign)):
            raise DistillationError("only simple Python statements are supported for reduction")
        lines = source.splitlines(keepends=True)
        start, end = selected.lineno - 1, selected.end_lineno
        lines[start:end] = ["\n" for _ in lines[start:end]]
        target.write_text("".join(lines), encoding="utf-8")

    def _materialized_paths(self, worktree: Path, repro: Dict[str, Any], provenance: Dict[str, Any]) -> set[str]:
        """Build a conservative file closure for portable materialization."""
        paths = {str(item["origin"]).replace("\\", "/") for item in provenance.values() if isinstance(item, dict) and isinstance(item.get("origin"), str)}
        for unit in repro.get("active_units", []):
            if unit.get("kind") == "file":
                paths.add(str(unit.get("reference", "")).replace("\\", "/"))
            elif unit.get("kind") in {"json_key", "json_record"}:
                paths.add(str(unit.get("reference", "")).split("#", 1)[0].replace("\\", "/"))
            elif unit.get("kind") in {"python_function", "python_statement"}:
                paths.add(str(unit.get("reference", "")).split("#", 1)[0].replace("\\", "/"))
        for part in repro.get("command", []):
            if isinstance(part, str) and not Path(part).is_absolute() and self._looks_like_path(part) and (worktree / part).is_file():
                paths.add(part.replace("\\", "/"))
        for name in ("package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "pyproject.toml", "pytest.ini", "tox.ini", "setup.cfg", "vitest.config.ts", "vitest.config.js"):
            if (worktree / name).is_file():
                paths.add(name)
        # Runtime-read fixtures are not reliably visible from static imports.
        # Retain all still-present tracked non-code assets; explicitly reduced
        # assets have already been removed from this worktree and stay absent.
        for value in _git(worktree, "ls-files").splitlines():
            relative = value.replace("\\", "/")
            if Path(relative).suffix.lower() not in {".py", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"} and (worktree / relative).is_file():
                paths.add(relative)
        frontier = list(paths)
        while frontier:
            relative = frontier.pop()
            path = worktree / relative
            if not path.is_file() or path.suffix.lower() not in {".py", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"}:
                continue
            try:
                text = path.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                continue
            # A dynamic specifier cannot be proven part of a portable closure
            # by source inspection. Refuse export instead of leaving an ambient
            # dependency on the original workspace or host runtime.
            if re.search(r"\bimport\s*\(\s*(?![\"'])", text):
                raise DistillationError(f"materialization cannot resolve dynamic Node import in {relative}")
            for target in self._relative_import_targets(relative, text):
                if target not in paths and (worktree / target).is_file():
                    paths.add(target)
                    frontier.append(target)
        return {path for path in paths if path and not Path(path).is_absolute() and (worktree / path).is_file()}

    def _relative_import_targets(self, relative: str, text: str) -> set[str]:
        parent = Path(relative).parent
        targets: set[str] = set()
        for match in re.finditer(r"(?:from\s+|import\s+)([A-Za-z_][\w.]*)", text):
            module = match.group(1)
            candidate = Path(*module.split("."))
            targets.add((parent / f"{candidate}.py").as_posix())
            targets.add((parent / candidate / "__init__.py").as_posix())
        for match in re.finditer(r"(?:from\s+|import\s*\(?\s*)[\"'](\.{1,2}/[^\"']+)[\"']", text):
            value = match.group(1)
            target = (parent / value).as_posix()
            targets.update({target, f"{target}.js", f"{target}.mjs", f"{target}.ts", f"{target}.tsx", f"{target}/index.js", f"{target}/index.ts"})
        return {str(Path(target)) for target in targets}

    def _coarse_groups(self, candidates: Sequence[Candidate]) -> List[Tuple[str, List[Candidate]]]:
        """Return deterministic coarse reduction groups before unit testing.

        Grouping mirrors the declared reduction boundary rather than filesystem
        order: input arguments, fixture/config entries, environment, source
        files, then supported Python units.  The subsequent fine pass proves
        individual necessity and preserves the 1-minimal contract.
        """
        buckets: Dict[Tuple[int, str], List[Candidate]] = {}
        priority = {"command_arg": 0, "json_record": 1, "json_key": 1, "env": 2, "file": 3, "python_function": 4, "python_statement": 4}
        for candidate in candidates:
            if candidate.kind in {"json_record", "json_key", "python_function", "python_statement"}:
                boundary = candidate.reference.split("#", 1)[0]
            elif candidate.kind == "file":
                boundary = Path(candidate.reference).parent.as_posix()
            else:
                boundary = candidate.kind
            buckets.setdefault((priority[candidate.kind], f"{candidate.kind}:{boundary}"), []).append(candidate)
        return [(name, values) for (_, name), values in sorted(buckets.items(), key=lambda item: item[0])]

    def _copy_materialized_paths(self, source: Path, destination: Path, paths: Iterable[str]) -> None:
        destination.mkdir(parents=True, exist_ok=False)
        for relative in sorted(set(paths)):
            src = source / relative
            if not src.is_file():
                continue
            dest = destination / relative
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dest)

    def _copy_node_dependency_closure(self, source_root: Path, source: Path, destination: Path, paths: Iterable[str]) -> List[str]:
        """Copy only packages imported by retained JS/TS source and their runtime deps.

        Package managers and lifecycle scripts are never invoked.  The closure
        is copied from an already-installed local surface, dereferencing any
        links, so the materialized workspace cannot resolve through its source
        workspace's ``node_modules``.
        """
        modules = source_root / "node_modules"
        if not modules.is_dir():
            return []
        requested: List[str] = []
        for relative in paths:
            path = source / relative
            if path.suffix.lower() not in {".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"} or not path.is_file():
                continue
            try:
                text = path.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                continue
            for specifier in re.findall(r"(?:from\s+|import\s*\(?\s*|require\()\s*[\"']([^\"']+)[\"']", text):
                if not specifier.startswith((".", "/")) and not specifier.startswith("node:"):
                    parts = specifier.split("/")
                    requested.append("/".join(parts[:2]) if specifier.startswith("@") and len(parts) > 1 else parts[0])
        copied: List[str] = []
        pending = list(dict.fromkeys(requested))
        while pending:
            package = pending.pop(0)
            if package in copied:
                continue
            package_source = modules / package
            if not package_source.is_dir():
                raise DistillationError(f"materialization cannot resolve required Node package: {package}")
            package_destination = destination / "node_modules" / package
            package_destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(package_source, package_destination, symlinks=False, ignore=shutil.ignore_patterns(".cache", ".bin"))
            copied.append(package)
            try:
                manifest = json.loads((package_source / "package.json").read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                manifest = {}
            for dependency in {**manifest.get("dependencies", {}), **manifest.get("optionalDependencies", {})}:
                if isinstance(dependency, str) and dependency not in copied and dependency not in pending:
                    pending.append(dependency)
        return copied

    def _copy_python_dependency_closure(self, source: Path, destination: Path, paths: Iterable[str]) -> List[str]:
        """Vendor imported non-stdlib Python modules for a portable replay.

        Resolution is intentionally performed without package installation.  A
        package that cannot be resolved from the declared runtime fails closed
        instead of leaving a hidden dependency on the source workspace.
        """
        requested: set[str] = set()
        for relative in paths:
            path = source / relative
            if path.suffix != ".py" or not path.is_file():
                continue
            try:
                tree = ast.parse(path.read_text(encoding="utf-8"))
            except (OSError, SyntaxError, UnicodeDecodeError):
                continue
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    requested.update(alias.name.split(".", 1)[0] for alias in node.names)
                elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                    requested.add(node.module.split(".", 1)[0])
                elif isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "import_module":
                    if not node.args or not isinstance(node.args[0], ast.Constant) or not isinstance(node.args[0].value, str):
                        raise DistillationError(f"materialization cannot resolve dynamic Python import in {relative}")
                    requested.add(node.args[0].value.split(".", 1)[0])
        vendor = destination / ".vectant" / "python"
        copied: list[str] = []
        stdlib = getattr(sys, "stdlib_module_names", set())
        for module in sorted(requested):
            if module in stdlib or (source / f"{module}.py").is_file() or (source / module).is_dir():
                continue
            spec = importlib.util.find_spec(module)
            if spec is None or not spec.origin or spec.origin in {"built-in", "frozen"}:
                raise DistillationError(f"materialization cannot resolve required Python package: {module}")
            origin = Path(spec.origin).resolve()
            try:
                origin.relative_to(source.resolve())
                continue
            except ValueError:
                pass
            vendor.mkdir(parents=True, exist_ok=True)
            if spec.submodule_search_locations:
                package_root = Path(next(iter(spec.submodule_search_locations))).resolve()
                shutil.copytree(package_root, vendor / module, symlinks=False, dirs_exist_ok=True, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
            else:
                shutil.copy2(origin, vendor / f"{module}.py")
            copied.append(module)
        return copied

    def _portable_command(self, command: Sequence[str], source: Path, destination: Path) -> List[str]:
        """Map workspace paths into a standalone capsule; reject hidden host links.

        An executable resolved from the platform is intentionally retained as a
        runtime requirement.  Every *file argument* must either be inside the
        materialized workspace or be copied there.  Arbitrary absolute host
        files are not safe portable dependencies and fail closed.
        """
        portable: List[str] = []
        for index, part in enumerate(command):
            value = Path(part)
            if index == 0:
                portable.append(part)
                continue
            if value.is_absolute():
                try:
                    relative = value.resolve().relative_to(source.resolve())
                except ValueError as exc:
                    raise DistillationError("materialization cannot retain an absolute dependency outside the capsule workspace") from exc
                copied = destination / relative
                if not copied.is_file():
                    copied.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(value, copied)
                portable.append(str(copied))
            else:
                portable.append(part)
        return portable

    def _materialized_integrity(self, destination: Path) -> Dict[str, Any]:
        files = {}
        for path in sorted(destination.rglob("*")):
            if path.is_file() and path.name != ".vectant-integrity.json":
                files[path.relative_to(destination).as_posix()] = _sha256(path.read_bytes())
            elif path.is_symlink():
                raise DistillationError("materialized capsule may not contain symlinks")
        return {"schema_version": "vectant.failure_capsule.integrity.v1", "files": files, "root_sha256": _sha256(_json(files).encode())}

    def _discover_candidates(self, root: Path, command: Sequence[str], existing: Sequence[Candidate], observation: Dict[str, Any], environment_input: Any, budget: Budget) -> List[Candidate]:
        """Discover conservative, file-level units for pytest/Vitest repos.

        Runtime tracing is optional in both runners, so this adapter begins with
        their explicit test target and tracked JSON/fixture/source files.  The
        reduction oracle decides necessity; discovery never silently claims a
        static graph is causal.
        """
        runner = self._supported_runner(command)
        existing_ids = {item.identifier for item in existing}
        target_paths = {part.replace("\\", "/") for part in command if self._looks_like_path(part)}
        discovered: List[Candidate] = []
        observed_paths = {
            str(path) for key in ("executed_paths", "fixture_paths", "config_paths")
            for path in observation.get(key, []) if isinstance(path, str)
        }
        if observation.get("file_path"):
            observed_paths.add(str(observation["file_path"]))
        # For runtime adapters (HMR/browser/native/GPU), the trace is the
        # frontier.  Unlike test runners, do not guess across the entire repo.
        if not runner or observation.get("kind") in {"hmr", "browser", "native", "gpu"}:
            for path in sorted(observed_paths):
                if path not in target_paths and (root / path).is_file():
                    discovered.append(Candidate("file", path))
            discovered.extend(Candidate("env", str(name)) for name in environment_input if not SECRET_NAME.search(str(name)))
            if not observed_paths:
                raise DistillationError("automatic discovery for non-test commands requires observed executed, fixture, config, or source paths")
            return [item for item in discovered if item.identifier not in existing_ids]
        tracked = [Path(value) for value in _git(root, "ls-files").splitlines() if value]
        for relative in tracked:
            path = relative.as_posix()
            if path in target_paths or path.startswith(".vectant/") or relative.name.startswith("."):
                continue
            if relative.suffix.lower() == ".json":
                discovered.extend(self._json_candidates(root, relative))
            elif relative.suffix.lower() in {".py", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".yaml", ".yml", ".toml", ".ini", ".txt", ".csv"}:
                discovered.append(Candidate("file", path))
                if budget.max_executions >= DEFAULT_BUDGETS["deep"]["max_executions"] and relative.suffix == ".py":
                    discovered.extend(self._python_source_candidates(root, relative))
        discovered.extend(Candidate("env", str(name)) for name in environment_input if not SECRET_NAME.search(str(name)))
        return [item for item in discovered if item.identifier not in existing_ids]

    def _python_source_candidates(self, root: Path, relative: Path) -> List[Candidate]:
        """Expose only AST-addressable units during the deep reduction pass."""
        try:
            tree = ast.parse((root / relative).read_text(encoding="utf-8"))
        except (OSError, SyntaxError):
            return []
        candidates: List[Candidate] = []
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                candidates.append(Candidate("python_function", f"{relative.as_posix()}#{node.name}"))
            elif isinstance(node, (ast.Expr, ast.Assign, ast.AnnAssign, ast.AugAssign)) and getattr(node, "lineno", None):
                candidates.append(Candidate("python_statement", f"{relative.as_posix()}#{node.lineno}"))
        return candidates

    def _supported_runner(self, command: Sequence[str]) -> Optional[str]:
        joined = " ".join(command).lower()
        if "pytest" in joined or (command and Path(command[0]).name.lower().startswith("python") and any(part.endswith(".py") for part in command[1:])):
            return "pytest"
        if "vitest" in joined:
            return "vitest"
        return None

    def _looks_like_path(self, value: str) -> bool:
        return "/" in value or "\\" in value or Path(value).suffix.lower() in {".py", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"}

    def _json_candidates(self, root: Path, relative: Path) -> List[Candidate]:
        try:
            data = json.loads((root / relative).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return [Candidate("file", relative.as_posix())]
        candidates: List[Candidate] = []

        def escape(value: Any) -> str:
            return str(value).replace("~", "~0").replace("/", "~1")

        def visit(value: Any, pointer: str) -> None:
            if isinstance(value, dict):
                for key, child in value.items():
                    child_pointer = f"{pointer}/{escape(key)}"
                    candidates.append(Candidate("json_key", f"{relative.as_posix()}#{child_pointer}"))
                    visit(child, child_pointer)
            elif isinstance(value, list):
                for index, child in enumerate(value):
                    child_pointer = f"{pointer}/{index}"
                    candidates.append(Candidate("json_record", f"{relative.as_posix()}#{child_pointer}"))
                    visit(child, child_pointer)

        visit(data, "")
        return candidates or [Candidate("file", relative.as_posix())]

    async def _run(self, command: Sequence[str], cwd: Path, env: Dict[str, str], timeout_sec: int) -> Run:
        try:
            result: ExecutionResult = await self._executor.run(command, cwd, env, timeout_sec)
            return Run(result.exit_code, result.output, result.duration_ms, result.timed_out, result.output_sha256, result.output_truncated)
        except IsolationError as exc:
            raise DistillationError(f"unsafe_external_boundary: {exc}") from exc

    def _write_capsule(self, root: Path, capsule_id: str, command: Sequence[str], environment: Dict[str, str], observation: Dict[str, Any], predicate: Predicate, signature: Signature, budget: Budget, revision: str, dirty: bool, baseline: Dict[str, Any], active: Sequence[Candidate], removed: Sequence[Candidate], retained: Sequence[Tuple[Candidate, str]], evidence: Sequence[Dict[str, Any]], status: str, retention_seconds: int) -> Path:
        capsule = root / ".vectant" / "capsules" / capsule_id
        capsule.mkdir(parents=True, exist_ok=False)
        provenance: Dict[str, Any] = {}
        provenance_paths = {candidate.reference for candidate in active if candidate.kind == "file"}
        provenance_paths.update(candidate.reference.split("#", 1)[0] for candidate in active if candidate.kind in {"python_function", "python_statement"})
        provenance_paths.update(part.replace("\\", "/") for part in command if self._looks_like_path(part) and (root / part).is_file())
        if observation.get("file_path"):
            provenance_paths.add(observation["file_path"])
        for key in ("executed_paths", "fixture_paths", "config_paths"):
            provenance_paths.update(path for path in observation.get(key, []) if isinstance(path, str))
        provenance_paths = {path for path in provenance_paths if not Path(path).is_absolute()}
        for origin in provenance_paths:
            file_path = root / origin
            if file_path.is_file():
                provenance[origin] = {"kind": "file", "origin": origin, "revision": revision, "sha256": _sha256(file_path.read_bytes())}
        # The retained source is an editable capsule-local workspace, never a
        # link into production.  Only this provenance map may map edits back.
        overlay = capsule / "overlay"
        for relative in sorted(provenance):
            source, target = root / relative, overlay / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
        runtime = self._runtime_identity(command, environment)
        created = datetime.now(timezone.utc)
        manifest = {"schema_version": "vectant.failure_capsule.v1", "capsule_id": capsule_id, "source_revision": revision, "dirty_workspace": dirty, "runtime": runtime, "observation": observation, "entrypoint": f"vectant repro run {capsule_id}", "status": status, "created_at": created.isoformat(), "retention": {"expires_at": (created + timedelta(seconds=retention_seconds)).isoformat(), "seconds": retention_seconds}}
        repro = {"workspace_root": str(root), "editable_workspace": str(overlay), "command": list(command), "environment": environment, "observation": observation, "runtime": runtime, "isolation": self._isolation_profile, "predicate": predicate.to_dict(), "signature": signature.to_dict(), "budget": budget.__dict__, "baseline": baseline, "active_units": [item.__dict__ for item in active], "removed_units": [item.__dict__ for item in removed]}
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

    def _record_validation(self, capsule: Path, result: Dict[str, Any]) -> Dict[str, Any]:
        record = {"validated_at": _utcnow(), **result}
        # Keep each validation immutable for audit and use validation.json only
        # as a convenience pointer to the latest attempt.
        history = capsule / "evidence" / "validation-history"
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        self._write_json(history / f"{stamp}-{uuid4().hex[:8]}.json", record)
        self._write_json(capsule / "evidence" / "validation.json", record)
        return record

    def _append_vivarium_evidence(self, capsule: Path, record: Dict[str, Any]) -> None:
        """Append interoperable, redacted Vivarium handoff metadata outside the capsule."""
        repro = self._read_json(capsule / "repro.json")
        root = Path(repro["workspace_root"]).resolve()
        ledger = root / ".vectant" / "evidence-ledger.ndjson"
        ledger.parent.mkdir(parents=True, exist_ok=True)
        with ledger.open("a", encoding="utf-8") as handle:
            handle.write(_json({"schema_version": "vectant.vivariumEvidence.v1", "recorded_at": _utcnow(), **record}) + "\n")

    def _world_hash(self, active: Sequence[Candidate], env: Dict[str, str], command: Sequence[str], revision: str, runtime: Dict[str, Any]) -> str:
        """Content-address the exact git world, overlay operations, command, and runtime."""
        return "sha256:" + _sha256(_json({"source_revision": revision, "reductions": sorted(item.identifier for item in active), "environment": env, "command": list(command), "runtime": runtime}).encode())

    def _run_dict(self, run: Run) -> Dict[str, Any]:
        return {"exit_code": run.exit_code, "duration_ms": run.duration_ms, "timed_out": run.timed_out, "output": _redact(run.output[-20_000:]), "output_sha256": run.output_sha256 or run.fingerprint(), "output_truncated": run.output_truncated}

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
        _failure_distiller = FailureDistiller(production=True)
    return _failure_distiller

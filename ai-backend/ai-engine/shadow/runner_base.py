"""Runner adapter contract for counterfactual branch telemetry.

Adapters normalize external agent runs into BranchTrace. They do not own
selection, proof gates, or policy learning; those stay in the counterfactual
control plane.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import shutil
import tempfile
import time
import re
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

from .counterfactual_types import (
    BranchTrace,
    CostTrace,
    ExposureLevel,
    LatencyTrace,
    PhenotypeVector,
    RiskTrace,
)


@dataclass
class RunnerInvocation:
    run_id: str
    universe_id: str
    runner_id: str
    direction_id: str
    direction_label: str
    declared_condition: str
    start_state_hash: str
    prompt_lineage: List[str] = field(default_factory=list)
    task_summary: str = ""
    policy_hints: List[str] = field(default_factory=list)
    budget_usd: Optional[float] = None
    timeout_seconds: int = 300


@dataclass
class RunnerArtifact:
    artifact_summary: str
    diff_summary: Dict[str, Any] = field(default_factory=dict)
    command_summary: Dict[str, Any] = field(default_factory=dict)
    tool_summary: Dict[str, Any] = field(default_factory=dict)
    detector_trace_ids: List[str] = field(default_factory=list)
    raw_log_ref: Optional[str] = None
    cost_estimated_usd: float = 0.0
    cost_actual_usd: Optional[float] = None
    latency_ms: int = 0
    timed_out: bool = False
    failed_hard_gates: List[str] = field(default_factory=list)
    risk_warnings: List[str] = field(default_factory=list)
    phenotype_vector: PhenotypeVector = field(default_factory=PhenotypeVector)
    novelty_vector: Dict[str, float] = field(default_factory=dict)
    proof_score: float = 0.0
    risk_score: float = 0.0
    end_state_hash: str = ""
    self_reported_rationale: str = ""


class BaseRunnerAdapter:
    runner_kind = "custom"

    def prepare_workspace_snapshot(self, workspace_path: Path) -> Dict[str, Any]:
        path = Path(workspace_path)
        digest = hashlib.sha256()
        file_count = 0
        for candidate in sorted(path.rglob("*"), key=lambda item: str(item).lower()):
            if not candidate.is_file() or ".git" in candidate.parts:
                continue
            relative = str(candidate.relative_to(path)).replace("\\", "/")
            digest.update(relative.encode("utf-8", errors="surrogateescape"))
            digest.update(b"\0")
            # Hash content without retaining it. A path-only hash cannot
            # distinguish a runner edit from an untouched worktree.
            with candidate.open("rb") as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                    digest.update(chunk)
            file_count += 1
        return {"workspace_path": str(path), "file_count": file_count, "state_hash": digest.hexdigest()}

    def prepare(self, workspace_snapshot: Dict[str, Any], invocation: RunnerInvocation) -> Dict[str, Any]:
        """Return the bounded runner contract passed to an external CLI.

        The control plane, not the runner, remains responsible for durable
        policy. Only the current task and at most five scoped hints are sent.
        """
        return {
            "run_id": invocation.run_id,
            "universe_id": invocation.universe_id,
            "direction_id": invocation.direction_id,
            "direction_label": invocation.direction_label,
            "declared_condition": invocation.declared_condition,
            "task_summary": invocation.task_summary[:4_000],
            "policy_hints": [hint[:320] for hint in invocation.policy_hints[:5]],
            "workspace_snapshot": {"state_hash": workspace_snapshot.get("state_hash"), "file_count": workspace_snapshot.get("file_count")},
            "budget_usd": invocation.budget_usd,
        }

    def run(self, *, workspace_path: Path, invocation: RunnerInvocation, command: List[str], artifact_root: Optional[Path] = None) -> RunnerArtifact:
        """Execute an explicit command without a shell and capture bounded evidence.

        Runner command construction lives in CodexRunner/ClaudeCodeRunner.
        This base layer intentionally rejects arbitrary shell strings and
        stores raw output locally by reference instead of embedding it in a
        BranchTrace.
        """
        if not command or not all(isinstance(item, str) and item.strip() for item in command):
            raise ValueError("runner command must be a non-empty argv list")
        if invocation.budget_usd is not None and not 0 < invocation.budget_usd <= 1000:
            raise ValueError("runner budget must be greater than zero and no more than $1000")
        root = Path(workspace_path).resolve()
        if not root.is_dir():
            raise ValueError("runner workspace must be an existing directory")
        timeout = max(1, min(int(invocation.timeout_seconds), 3600))
        started = time.monotonic()
        try:
            completed = subprocess.run(
                command, cwd=root, shell=False, capture_output=True, text=True,
                encoding="utf-8", errors="replace", timeout=timeout,
                env=_runner_environment(), check=False,
            )
            timed_out = False
        except subprocess.TimeoutExpired as error:
            completed = None
            timed_out = True
            stdout = error.stdout or ""
            stderr = error.stderr or ""
        elapsed_ms = int((time.monotonic() - started) * 1000)
        if completed is not None:
            stdout, stderr = completed.stdout or "", completed.stderr or ""
            exit_code = completed.returncode
        else:
            exit_code = None
        raw_log_ref = self._write_raw_log(artifact_root or root, invocation, command, stdout, stderr, exit_code, timed_out)
        return RunnerArtifact(
            artifact_summary=_artifact_summary(stdout, stderr, exit_code, timed_out),
            command_summary={
                "executable": Path(command[0]).name, "argument_count": len(command),
                "exit_code": exit_code, "timed_out": timed_out,
            },
            tool_summary={"runner": self.runner_kind}, raw_log_ref=raw_log_ref,
            latency_ms=elapsed_ms, timed_out=timed_out,
            cost_estimated_usd=float(invocation.budget_usd or 0),
            risk_warnings=["runner command failed"] if exit_code not in (0, None) else [],
            # Raw runner output stays solely in the short-lived raw artifact.
            # It is not duplicated into the normalized trace.
            self_reported_rationale="",
        )

    @contextmanager
    def isolated_chamber(self, workspace_path: Path, invocation: RunnerInvocation):
        """Create an isolated git worktree for one external runner invocation.

        The source workspace is never used as a runner cwd.  Failure to make a
        chamber is a safe failure, rather than a fallback to the source tree.
        """
        source = Path(workspace_path).resolve()
        if not (source / ".git").exists():
            raise ValueError("external runners require a git workspace for isolation")
        chamber_root = source / ".vectant" / "chambers"
        chamber_root.mkdir(parents=True, exist_ok=True)
        chamber = Path(tempfile.mkdtemp(prefix=f"{invocation.run_id}-{invocation.universe_id}-", dir=chamber_root))
        # git worktree add requires the destination not to exist.
        chamber.rmdir()
        try:
            created = subprocess.run(["git", "worktree", "add", "--detach", str(chamber), "HEAD"], cwd=source, shell=False, capture_output=True, text=True, check=False)
            if created.returncode != 0:
                raise RuntimeError(_bounded(created.stderr or "unable to create runner chamber", 1_000))
            yield chamber
        finally:
            subprocess.run(["git", "worktree", "remove", "--force", str(chamber)], cwd=source, shell=False, capture_output=True, text=True, check=False)
            if chamber.exists():
                shutil.rmtree(chamber, ignore_errors=True)

    def collect_artifacts(self, artifact: RunnerArtifact) -> Dict[str, Any]:
        return {"raw_log_ref": artifact.raw_log_ref, "self_reported_rationale": _bounded(artifact.self_reported_rationale, 1_000)}

    def collect_diff(self, workspace_path: Path, start_state_hash: str) -> Dict[str, Any]:
        end = self.prepare_workspace_snapshot(workspace_path)
        root = Path(workspace_path).resolve()
        try:
            changed = subprocess.run(
                ["git", "diff", "--numstat", "--", "."], cwd=root, shell=False,
                capture_output=True, text=True, encoding="utf-8", errors="replace", check=False,
            )
            files = subprocess.run(
                ["git", "diff", "--name-only", "--", "."], cwd=root, shell=False,
                capture_output=True, text=True, encoding="utf-8", errors="replace", check=False,
            )
            loc_added = loc_removed = 0
            for row in changed.stdout.splitlines()[:200]:
                parts = row.split("\t", 2)
                if len(parts) >= 2:
                    loc_added += int(parts[0]) if parts[0].isdigit() else 0
                    loc_removed += int(parts[1]) if parts[1].isdigit() else 0
            changed_files = [line[:512] for line in files.stdout.splitlines()[:200] if line]
        except OSError:
            loc_added = loc_removed = 0
            changed_files = []
        return {
            "start_state_hash": start_state_hash, "end_state_hash": end["state_hash"],
            "workspace_file_count": end["file_count"], "files_touched": len(changed_files),
            "changed_paths": changed_files, "loc_added": loc_added, "loc_removed": loc_removed,
        }

    def collect_detector_inputs(self, artifact: RunnerArtifact) -> Dict[str, Any]:
        return {"command_exit_code": artifact.command_summary.get("exit_code"), "timed_out": artifact.timed_out, "raw_log_ref": artifact.raw_log_ref}

    def _write_raw_log(
        self,
        workspace_path: Path,
        invocation: RunnerInvocation,
        command: List[str],
        stdout: str,
        stderr: str,
        exit_code: Optional[int],
        timed_out: bool,
    ) -> str:
        """Write a local raw-log artifact with a safe, deterministic path."""
        log_dir = workspace_path / ".vectant" / "runner-artifacts" / invocation.run_id
        log_dir.mkdir(parents=True, exist_ok=True)
        filename = f"{self.runner_kind}-{invocation.universe_id}.json"
        path = (log_dir / filename).resolve()
        root = workspace_path.resolve()
        if root not in path.parents:
            raise ValueError("runner artifact path escaped workspace")
        payload = {
            "runner_kind": self.runner_kind,
            "run_id": invocation.run_id,
            "universe_id": invocation.universe_id,
            "argv": [_redact(item) for item in command],
            "exit_code": exit_code,
            "timed_out": timed_out,
            "stdout": _redact(_bounded(stdout, 256_000)),
            "stderr": _redact(_bounded(stderr, 256_000)),
        }
        path.write_text(json.dumps(payload, sort_keys=True), encoding="utf-8")
        return str(path.relative_to(root)).replace("\\", "/")

    def collect_trace(self, invocation: RunnerInvocation, artifact: RunnerArtifact) -> BranchTrace:
        tool_summary = dict(artifact.tool_summary)
        if artifact.raw_log_ref:
            tool_summary["raw_log_ref"] = artifact.raw_log_ref
        novelty = artifact.novelty_vector or artifact.phenotype_vector.to_dict()
        return BranchTrace(
            id=f"br_{invocation.run_id}_{invocation.universe_id}",
            counterfactual_run_id=invocation.run_id,
            universe_id=invocation.universe_id,
            runner_id=invocation.runner_id,
            runner_kind=self.runner_kind,
            direction_id=invocation.direction_id,
            direction_label=invocation.direction_label,
            declared_condition=invocation.declared_condition,
            prompt_lineage=list(invocation.prompt_lineage),
            start_state_hash=invocation.start_state_hash,
            end_state_hash=artifact.end_state_hash or _hash_artifact(artifact),
            artifact_summary=artifact.artifact_summary,
            diff_summary=dict(artifact.diff_summary),
            tool_trace_summary=tool_summary,
            command_trace_summary=dict(artifact.command_summary),
            detector_trace_ids=list(artifact.detector_trace_ids),
            cost_trace=CostTrace(
                estimated_usd=artifact.cost_estimated_usd,
                actual_usd=artifact.cost_actual_usd,
            ),
            latency_trace=LatencyTrace(
                duration_ms=artifact.latency_ms,
                timed_out=artifact.timed_out,
            ),
            risk_trace=RiskTrace(
                failed_hard_gates=list(artifact.failed_hard_gates),
                warnings=list(artifact.risk_warnings),
            ),
            phenotype_vector=artifact.phenotype_vector,
            novelty_vector=novelty,
            proof_score=artifact.proof_score,
            risk_score=artifact.risk_score,
            exposure_level=ExposureLevel.GENERATED,
        )


def _hash_artifact(artifact: RunnerArtifact) -> str:
    payload = {
        "artifact_summary": artifact.artifact_summary,
        "diff_summary": artifact.diff_summary,
        "command_summary": artifact.command_summary,
        "detector_trace_ids": artifact.detector_trace_ids,
        "raw_log_ref": artifact.raw_log_ref,
    }
    return hashlib.sha1(json.dumps(payload, sort_keys=True).encode("utf-8")).hexdigest()


def _runner_environment() -> Dict[str, str]:
    """Pass a minimal non-secret environment to external runners."""
    allowed = ("PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "TEMP", "TMP", "LANG", "LC_ALL")
    return {key: value for key, value in os.environ.items() if key in allowed and value}


def _artifact_summary(stdout: str, stderr: str, exit_code: Optional[int], timed_out: bool) -> str:
    if timed_out:
        return "runner timed out before producing a complete branch artifact"
    if exit_code == 0:
        return "runner completed; raw output is retained only as a bounded artifact reference"
    return f"runner exited with code {exit_code}; raw output is retained only as a bounded artifact reference"


def _bounded(value: str, limit: int) -> str:
    return str(value or "").replace("\x00", "")[:limit]


_SECRET_ASSIGNMENT = re.compile(r"(?i)\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API[_-]?KEY|CREDENTIAL)[A-Z0-9_]*)\s*=\s*([^\s'\"]+)")
_BEARER_TOKEN = re.compile(r"(?i)\b(Bearer\s+)[A-Za-z0-9._~-]+")


def _redact(value: str) -> str:
    """Remove common credential material before durable runner-log storage."""
    value = _SECRET_ASSIGNMENT.sub(lambda match: f"{match.group(1)}=[REDACTED]", value)
    return _BEARER_TOKEN.sub(r"\1[REDACTED]", value)

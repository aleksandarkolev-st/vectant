"""Hidden markdown persistence for compact Regret Memory.

This module stores durable counterfactual lessons as bounded markdown inside
the workspace, while keeping machine-readable policy deltas in HTML comments.
It deliberately persists summaries and policy changes only, not source files
or full runner transcripts.
"""

from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Iterable, List

from .counterfactual_types import PolicyDelta, PolicyDeltaKind, PolicyDeltaStatus
from .policy_delta import make_policy_delta

MEMORY_DIR = ".vectant"
MEMORY_FILENAME = "regret-memory.md"
MAX_MARKDOWN_BYTES = 256_000
MAX_LEARNED_LINE_CHARS = 320
MAX_DELTA_TEXT_CHARS = 480
_COMMENT_PREFIX = "<!-- vectant:policy-delta "
_COMMENT_SUFFIX = " -->"
_COMMENT_RE = re.compile(r"<!--\s*vectant:policy-delta\s+({.*?})\s*-->", re.DOTALL)


def memory_path(repo: Path) -> Path:
    root = repo.resolve()
    path = (root / MEMORY_DIR / MEMORY_FILENAME).resolve()
    if root not in path.parents:
        raise ValueError("regret memory path escaped workspace")
    return path


def load_policy_deltas(repo: Path, task_class: str, workspace_id: str | None = None) -> List[PolicyDelta]:
    path = memory_path(repo)
    if not path.exists():
        return []
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return []
    if len(raw.encode("utf-8")) > MAX_MARKDOWN_BYTES:
        raw = raw.encode("utf-8")[-MAX_MARKDOWN_BYTES:].decode("utf-8", errors="ignore")

    deltas: List[PolicyDelta] = []
    for match in _COMMENT_RE.finditer(raw):
        try:
            payload = json.loads(match.group(1))
        except json.JSONDecodeError:
            continue
        if payload.get("task_class") != task_class:
            continue
        delta = _policy_delta_from_payload(payload, workspace_id or str(repo.resolve()))
        if delta is not None:
            deltas.append(delta)
    return _dedupe_deltas(deltas)


def append_session_memory(
    repo: Path,
    *,
    task_class: str,
    learned_lines: Iterable[str],
    policy_deltas: Iterable[PolicyDelta],
    run_id: str,
    now: float | None = None,
) -> Path | None:
    lines = [_bounded_text(line, MAX_LEARNED_LINE_CHARS) for line in learned_lines if str(line).strip()]
    deltas = list(policy_deltas)
    if not lines and not deltas:
        return None

    path = memory_path(repo)
    path.parent.mkdir(parents=True, exist_ok=True)
    existing = ""
    if path.exists():
        try:
            existing = path.read_text(encoding="utf-8")
        except OSError:
            existing = ""

    timestamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() if now is None else now))
    block = _render_session_block(
        timestamp=timestamp,
        task_class=task_class,
        run_id=run_id,
        learned_lines=lines,
        policy_deltas=deltas,
    )
    if existing.strip():
        content = f"{existing.rstrip()}\n\n{block}"
    else:
        content = f"# Vectant Regret Memory\n\n{_intro()}\n\n{block}"
    content = _trim_to_budget(content)
    path.write_text(content, encoding="utf-8")
    return path


def _intro() -> str:
    return (
        "Compact counterfactual telemetry for this workspace. "
        "Vectant reads this file at shadow-session start and appends bounded "
        "lessons after selections finish."
    )


def _render_session_block(
    *,
    timestamp: str,
    task_class: str,
    run_id: str,
    learned_lines: List[str],
    policy_deltas: List[PolicyDelta],
) -> str:
    out = [
        f"## Session {timestamp}",
        "",
        f"- run_id: `{_bounded_text(run_id, 96)}`",
        f"- task_class: `{_bounded_text(task_class, 80)}`",
    ]
    if learned_lines:
        out.append("- learned:")
        out.extend(f"  - {_escape_markdown(line)}" for line in learned_lines[:8])
    if policy_deltas:
        out.append("- policy_deltas:")
        for delta in policy_deltas[:12]:
            payload = json.dumps(_payload_from_delta(delta), sort_keys=True, separators=(",", ":"))
            out.append(f"  {_COMMENT_PREFIX}{payload}{_COMMENT_SUFFIX}")
            out.append(
                "  - "
                f"{delta.delta_kind.value}; confidence={_bounded_text(delta.confidence, 40)}; "
                f"after={_escape_markdown(_bounded_text(delta.after, MAX_DELTA_TEXT_CHARS))}"
            )
    return "\n".join(out)


def _payload_from_delta(delta: PolicyDelta) -> dict:
    return {
        "id": delta.id,
        "source_counterfactual_run_id": delta.source_counterfactual_run_id,
        "workspace_id": delta.workspace_id,
        "task_class": delta.task_class,
        "delta_kind": delta.delta_kind.value,
        "before": _bounded_text(delta.before, MAX_DELTA_TEXT_CHARS),
        "after": _bounded_text(delta.after, MAX_DELTA_TEXT_CHARS),
        "confidence": _bounded_text(delta.confidence, 40),
        "evidence_refs": [_bounded_text(ref, 128) for ref in delta.evidence_refs[:16]],
        "expiry": delta.expiry,
        "status": delta.status.value,
    }


def _policy_delta_from_payload(payload: dict, workspace_id: str) -> PolicyDelta | None:
    try:
        delta_kind = PolicyDeltaKind(str(payload["delta_kind"]))
        status = PolicyDeltaStatus(str(payload.get("status") or PolicyDeltaStatus.HYPOTHESIS.value))
    except (KeyError, ValueError):
        return None
    if status in {PolicyDeltaStatus.DELETED, PolicyDeltaStatus.CONTRADICTED}:
        return None
    delta = make_policy_delta(
        run_id=str(payload.get("source_counterfactual_run_id") or "markdown"),
        workspace_id=workspace_id,
        task_class=str(payload.get("task_class") or ""),
        delta_kind=delta_kind,
        before=_bounded_text(payload.get("before") or "", MAX_DELTA_TEXT_CHARS),
        after=_bounded_text(payload.get("after") or "", MAX_DELTA_TEXT_CHARS),
        confidence=_bounded_text(payload.get("confidence") or "low", 40),
        evidence_refs=[str(ref)[:128] for ref in payload.get("evidence_refs") or []],
        status=status,
        expiry=payload.get("expiry"),
    )
    delta.id = _bounded_text(payload.get("id") or delta.id, 96)
    return delta


def _dedupe_deltas(deltas: List[PolicyDelta]) -> List[PolicyDelta]:
    out: dict[str, PolicyDelta] = {}
    for delta in deltas:
        out[delta.id] = delta
    return list(out.values())


def _trim_to_budget(content: str) -> str:
    encoded = content.encode("utf-8")
    if len(encoded) <= MAX_MARKDOWN_BYTES:
        return content
    keep = encoded[-MAX_MARKDOWN_BYTES:].decode("utf-8", errors="ignore")
    first_header = keep.find("\n## Session ")
    if first_header >= 0:
        keep = keep[first_header + 1 :]
    return f"# Vectant Regret Memory\n\n{_intro()}\n\n{keep.lstrip()}"


def _bounded_text(value: object, limit: int) -> str:
    text = str(value or "").replace("\x00", "").strip()
    return text[:limit]


def _escape_markdown(value: str) -> str:
    return value.replace("\n", " ").replace("\r", " ").strip()

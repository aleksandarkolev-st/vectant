"""Normalize existing shadow diagnostics into detector telemetry."""

from __future__ import annotations

import hashlib
from typing import Any, Dict, List

from .counterfactual_types import DetectorKind, DetectorResult, DetectorStatus


def detector_results_from_evidence(branch_trace_id: str, evidence: Dict[str, Any]) -> List[DetectorResult]:
    diagnostics = evidence.get("diagnostics") or {}
    attacks = evidence.get("attacks") or {}
    results: List[DetectorResult] = []

    mapping = [
        ("lint", DetectorKind.LINT),
        ("types", DetectorKind.TYPECHECK),
        ("tests", DetectorKind.UNIT_TESTS),
        ("runtime", DetectorKind.RUNTIME_PROBE),
    ]
    for key, kind in mapping:
        raw = diagnostics.get(key, "skipped")
        results.append(_result(branch_trace_id, kind, raw))

    failed_attacks = attacks.get("failed") or []
    tested = int(attacks.get("tested") or 0)
    survived = int(attacks.get("survived") or 0)
    if tested <= 0:
        status = DetectorStatus.SKIPPED
        score = 0.0
        summary = "critic attacks skipped"
    elif failed_attacks:
        status = DetectorStatus.FAILED
        score = 0.0
        summary = f"{len(failed_attacks)} blocking attack(s) failed"
    else:
        status = DetectorStatus.PASSED
        score = 1.0
        summary = f"{survived}/{tested} attacks survived"
    results.append(DetectorResult(
        id=_detector_id(branch_trace_id, DetectorKind.HUMAN_READABILITY.value, summary),
        branch_trace_id=branch_trace_id,
        detector_kind=DetectorKind.HUMAN_READABILITY,
        status=status,
        score=score,
        evidence_summary=summary,
    ))
    return results


def has_failed_hard_gate(results: List[DetectorResult]) -> bool:
    hard = {DetectorKind.LINT, DetectorKind.TYPECHECK, DetectorKind.UNIT_TESTS, DetectorKind.RUNTIME_PROBE}
    return any(r.detector_kind in hard and r.status == DetectorStatus.FAILED for r in results)


def _result(branch_trace_id: str, kind: DetectorKind, raw: Any) -> DetectorResult:
    status, score, summary = _status(raw)
    return DetectorResult(
        id=_detector_id(branch_trace_id, kind.value, summary),
        branch_trace_id=branch_trace_id,
        detector_kind=kind,
        status=status,
        score=score,
        evidence_summary=summary,
    )


def _status(raw: Any) -> tuple[DetectorStatus, float, str]:
    if raw in (None, "", "skipped"):
        return DetectorStatus.SKIPPED, 0.0, "skipped"
    if raw == "clean":
        return DetectorStatus.PASSED, 1.0, "clean"
    if isinstance(raw, list):
        return (DetectorStatus.FAILED, 0.0, f"{len(raw)} diagnostic(s)") if raw else (
            DetectorStatus.PASSED,
            1.0,
            "clean",
        )
    text = str(raw)
    lower = text.lower()
    if "dirty" in lower or "failed" in lower or "error" in lower:
        return DetectorStatus.FAILED, 0.0, text
    if "/" in lower and "passed" in lower:
        try:
            passed, total = lower.split(" passed", 1)[0].split("/", 1)
            p, t = int(passed.strip()), int(total.strip())
            if t > 0 and p < t:
                return DetectorStatus.FAILED, p / t, text
            return DetectorStatus.PASSED, 1.0, text
        except ValueError:
            return DetectorStatus.PARTIAL, 0.5, text
    return DetectorStatus.PARTIAL, 0.5, text


def _detector_id(branch_trace_id: str, kind: str, summary: str) -> str:
    digest = hashlib.sha1(f"{branch_trace_id}:{kind}:{summary}".encode("utf-8")).hexdigest()[:10]
    return f"det_{digest}"

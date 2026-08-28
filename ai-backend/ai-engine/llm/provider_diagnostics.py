"""Allowlisted diagnostics for failures at external AI provider boundaries."""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any, Mapping, Optional


PROVIDER_DIAGNOSTIC_SCHEMA = "synthi.ai.provider_diagnostic.v1"
PROVIDER_DIAGNOSTIC_AUTHORITY = "provider_failure_diagnostic_only"
_REASON_CODES = frozenset(
    {
        "ai_provider_timeout",
        "ai_provider_account_suspended",
        "ai_provider_auth_denied",
        "ai_provider_rate_limited",
        "ai_provider_unavailable",
        "ai_provider_error",
    }
)
_STABLE_ID_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_.:-]{0,127}$")


def provider_failure_reason(value: Any) -> str:
    explicit = getattr(value, "reason_code", None)
    if isinstance(explicit, str) and explicit in _REASON_CODES:
        return explicit
    if isinstance(value, str) and value in _REASON_CODES:
        return value
    if isinstance(value, TimeoutError):
        return "ai_provider_timeout"

    lowered = f"{type(value).__name__} {value}".lower()
    if "timeout" in lowered:
        return "ai_provider_timeout"
    if "consumer_suspended" in lowered or "account suspended" in lowered or "has been suspended" in lowered:
        return "ai_provider_account_suspended"
    if (
        "permissiondenied" in lowered
        or "permission denied" in lowered
        or "unauthenticated" in lowered
        or "unauthorized" in lowered
        or "auth denied" in lowered
        or "invalid api key" in lowered
        or "api key not valid" in lowered
        or "403" in lowered
    ):
        return "ai_provider_auth_denied"
    if "rate limit" in lowered or "429" in lowered:
        return "ai_provider_rate_limited"
    if "unavailable" in lowered or "overload" in lowered or "503" in lowered:
        return "ai_provider_unavailable"
    return "ai_provider_error"


def _provider_error_class(value: Any, override: Optional[str]) -> str:
    candidate = str(override or type(value).__name__ or "ProviderError")
    return candidate if _STABLE_ID_RE.fullmatch(candidate) else "ProviderError"


def _provider_http_status(value: Any) -> Optional[int]:
    candidates = [getattr(value, "status_code", None), getattr(value, "code", None)]
    response = getattr(value, "response", None)
    candidates.append(getattr(response, "status_code", None))
    for candidate in candidates:
        if isinstance(candidate, int) and 100 <= candidate <= 599:
            return candidate
        if isinstance(candidate, str) and candidate.isdigit():
            numeric = int(candidate)
            if 100 <= numeric <= 599:
                return numeric
    return None


def build_provider_diagnostic(
    value: Any,
    *,
    endpoint_role: str,
    reason_code: Optional[str] = None,
    error_class: Optional[str] = None,
) -> Mapping[str, Any]:
    role = endpoint_role if _STABLE_ID_RE.fullmatch(str(endpoint_role or "")) else "provider_operation"
    reason = reason_code if reason_code in _REASON_CODES else provider_failure_reason(value)
    material = {
        "schemaVersion": PROVIDER_DIAGNOSTIC_SCHEMA,
        "reasonCode": reason,
        "errorClass": _provider_error_class(value, error_class),
        "httpStatus": _provider_http_status(value),
        "retryable": reason
        in {"ai_provider_timeout", "ai_provider_rate_limited", "ai_provider_unavailable"},
        "endpointRole": role,
        "proofAuthority": PROVIDER_DIAGNOSTIC_AUTHORITY,
        "acceptedForGpuHmr": False,
        "gpuHmrSuccess": False,
        "canSatisfyRuntimeProof": False,
    }
    digest = hashlib.sha256(
        json.dumps(material, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    return {**material, "diagnosticId": f"provider-diagnostic:sha256:{digest}"}


def format_provider_diagnostic(diagnostic: Mapping[str, Any]) -> str:
    return json.dumps(dict(diagnostic), sort_keys=True, separators=(",", ":"))

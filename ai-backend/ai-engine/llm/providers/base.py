from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import datetime, timezone
from typing import Any, Mapping, Optional, Sequence


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00",
        "Z",
    )


def _request_mode_name(mode: Optional[str], request_mode: Optional[str]) -> str:
    if request_mode:
        return request_mode
    mode_lower = mode.lower() if isinstance(mode, str) else ""
    if mode_lower == "split":
        return "split"
    if mode_lower == "delta":
        return "delta"
    return mode_lower or "unknown"


def provider_model_provenance(
    *,
    provider: str,
    requested_model: Optional[str],
    actual_model: Optional[str] = None,
    fallback_model: Optional[str] = None,
    fallback_used: bool = False,
    mode: Optional[str] = None,
    request_mode: Optional[str] = None,
    provider_model_status: str = "unknown",
    provider_model_alias_resolved_to: Optional[str] = None,
    provider_shutdown_or_deprecation_detected: bool = False,
    hard_infra_failure: bool = False,
    latency_ms: Optional[float] = None,
    error_type: Optional[str] = None,
) -> dict[str, Any]:
    metadata: dict[str, Any] = {
        "provider": provider,
        "requested_model": requested_model,
        "actual_model": actual_model,
        "fallback_model": fallback_model,
        "fallback_used": bool(fallback_used),
        "mode": mode,
        "request_mode": _request_mode_name(mode, request_mode),
        "provider_model_status": provider_model_status,
        "provider_model_alias_resolved_to": provider_model_alias_resolved_to,
        "provider_shutdown_or_deprecation_detected": bool(
            provider_shutdown_or_deprecation_detected
        ),
        "model_availability_checked_at": _utc_now_iso(),
        "model_availability_source": "provider_not_checked",
        "model_availability_check_time_ms": 0.0,
        "hard_infra_failure": bool(hard_infra_failure),
    }
    if latency_ms is not None:
        metadata["latency_ms"] = latency_ms
    if error_type:
        metadata["error_type"] = error_type
    return metadata


class AiProvider(ABC):
    name: str = "base_provider"
    _client: Optional[object] = None

    def __init__(self, name: str):
        self.name = name
        self.last_call_metadata: dict[str, Any] = {}

    @abstractmethod
    def _get_client(self) -> object:
        pass

    @abstractmethod
    async def ask_llm(
        self,
        code: str,
        lang: str,
        prompt: str = None,
        mode: str = None,
        files: Optional[Sequence[Mapping[str, Any]]] = None,
        focus: Optional[str] = None,
        request_mode: Optional[str] = None,
    ) -> str:
        pass

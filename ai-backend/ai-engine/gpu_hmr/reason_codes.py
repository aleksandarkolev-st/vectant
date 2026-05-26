"""Versioned GPU HMR reason-code registry."""

from __future__ import annotations

import json
from functools import lru_cache
from importlib import resources
from typing import Dict, Iterable, List, Literal

try:
    from pydantic import BaseModel, ConfigDict, Field

    _PYDANTIC_V2 = True
except ImportError:  # pragma: no cover - compatibility for older local envs
    from pydantic import BaseModel, Field  # type: ignore

    ConfigDict = None  # type: ignore
    _PYDANTIC_V2 = False


REASON_CODE_REGISTRY_SCHEMA_VERSION = "gpu-hmr-reason-code-registry-v1"
Severity = Literal["blocking", "advisory", "info"]


class UnknownReasonCodeError(ValueError):
    def __init__(self, unknown_codes: Iterable[str]):
        self.unknown_codes = sorted({str(code) for code in unknown_codes})
        super().__init__(f"unknown GPU HMR reason codes: {', '.join(self.unknown_codes)}")


class ReasonCodeEntry(BaseModel):
    code: str
    phase: str
    severity: Severity
    blocking: bool
    message: str
    requiredRemediation: str
    safeFallbackMode: str
    owner: str

    if _PYDANTIC_V2:
        model_config = ConfigDict(extra="forbid")
    else:

        class Config:
            extra = "forbid"


class ReasonCodeRegistry(BaseModel):
    schemaVersion: str = REASON_CODE_REGISTRY_SCHEMA_VERSION
    codes: List[ReasonCodeEntry] = Field(default_factory=list)

    if _PYDANTIC_V2:
        model_config = ConfigDict(extra="forbid")
    else:

        class Config:
            extra = "forbid"

    def by_code(self) -> Dict[str, ReasonCodeEntry]:
        entries: Dict[str, ReasonCodeEntry] = {}
        duplicates: set[str] = set()
        for entry in self.codes:
            if entry.code in entries:
                duplicates.add(entry.code)
            entries[entry.code] = entry
        if duplicates:
            raise ValueError(f"duplicate GPU HMR reason codes: {', '.join(sorted(duplicates))}")
        return entries


@lru_cache(maxsize=1)
def load_reason_code_registry() -> ReasonCodeRegistry:
    raw = resources.files("gpu_hmr").joinpath("reason_codes.json").read_text(encoding="utf-8")
    parsed = json.loads(raw)
    if _PYDANTIC_V2:
        registry = ReasonCodeRegistry.model_validate(parsed)
    else:
        registry = ReasonCodeRegistry(**parsed)  # type: ignore[call-arg]
    registry.by_code()
    return registry


def reason_code_map() -> Dict[str, ReasonCodeEntry]:
    return load_reason_code_registry().by_code()


def get_reason_code(code: str) -> ReasonCodeEntry | None:
    return reason_code_map().get(code)


def unknown_reason_codes(codes: Iterable[str]) -> List[str]:
    known = reason_code_map()
    return sorted({str(code) for code in codes if str(code) not in known})


def assert_registered_reason_codes(codes: Iterable[str]) -> None:
    unknown = unknown_reason_codes(codes)
    if unknown:
        raise UnknownReasonCodeError(unknown)


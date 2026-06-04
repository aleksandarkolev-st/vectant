"""Launch-indirection report for GPU split artifacts.

The runtime owns symbol lookup and generation-checked dispatch. AI-generated
host roles are only allowed to call the public `synthi_gpu_launch(...)` wrapper.
This module turns that static contract into a machine-readable report that the
worker can persist in the GPU HMR sidecar and run report.
"""

from __future__ import annotations

import re
from typing import Any, Mapping, Sequence


SCHEMA_VERSION = "synthi.gpu.launch_indirection.v1"
STALE_CHECK_SCHEMA_VERSION = "synthi.gpu.stale_launch_pointer_check.v1"

_BOUNDARY_LAUNCH_RE = re.compile(
    r"\bsynthi_gpu_launch(?:_original_host_path|_source_location)?\s*\(",
    re.DOTALL,
)
_BYPASS_RE = re.compile(
    r"\bsynthi_gpu_(?:launch_raw(?:_checked)?|launch_table|launch_generation)\s*\(",
    re.DOTALL,
)
_RAW_KERNEL_LAUNCH_RE = re.compile(
    r"\b(?P<name>[A-Za-z_][A-Za-z0-9_:]*)\s*<<<",
    re.DOTALL,
)
_VENDOR_SYMBOL_LOOKUP_RE = re.compile(
    r"\b(?:cuModuleGetFunction|hipModuleGetFunction|cuLaunchKernel|hipModuleLaunchKernel)\s*\(",
    re.DOTALL,
)


def build_launch_indirection_report(
    *,
    generated_files: Mapping[str, str],
    verification: Mapping[str, Any] | None = None,
) -> dict:
    host_items = [
        (path, source or "")
        for path, source in generated_files.items()
        if _is_host_role_path(path)
    ]
    boundary_launch_sites = []
    bypasses = []
    raw_launches = []
    vendor_lookups = []

    for path, source in host_items:
        boundary_launch_sites.extend(
            {"file": path, "offset": match.start()}
            for match in _BOUNDARY_LAUNCH_RE.finditer(source)
        )
        bypasses.extend(
            {
                "file": path,
                "symbol": match.group(0).split("(", 1)[0],
                "offset": match.start(),
            }
            for match in _BYPASS_RE.finditer(source)
        )
        raw_launches.extend(
            {
                "file": path,
                "symbol": match.group("name"),
                "offset": match.start(),
            }
            for match in _RAW_KERNEL_LAUNCH_RE.finditer(source)
        )
        vendor_lookups.extend(
            {
                "file": path,
                "symbol": match.group(0).split("(", 1)[0],
                "offset": match.start(),
            }
            for match in _VENDOR_SYMBOL_LOOKUP_RE.finditer(source)
        )

    verifier_rules = _verification_rules(verification)
    verifier_rejected = any(
        rule in {"launch_indirection_bypassed", "raw_launch_not_rewritten"}
        for rule in verifier_rules
    )
    failed = bool(bypasses or raw_launches or vendor_lookups or verifier_rejected)
    reason_codes: list[str] = []
    if raw_launches:
        reason_codes.append("raw_launch_not_rewritten")
    if bypasses:
        reason_codes.append("launch_indirection_bypassed")
    if vendor_lookups:
        reason_codes.append("loader_symbol_lookup_bypassed")
    if verifier_rejected:
        reason_codes.append("split_verifier_failed")
    if not reason_codes:
        reason_codes.extend(
            [
                "launch_indirection.host_roles_use_public_wrapper",
                "launch_indirection.runtime_generation_checked",
                "launch_indirection.loader_owns_symbol_lookup",
            ]
        )

    stale_checks = {
        "schemaVersion": STALE_CHECK_SCHEMA_VERSION,
        "status": "fail" if failed else "pass",
        "runtimeGenerationChecked": not failed,
        "failureReasonCode": "reload_failed.stale_launch_pointer",
        "reasonCodes": reason_codes,
    }

    return {
        "schemaVersion": SCHEMA_VERSION,
        "status": "fail" if failed else "pass",
        "tableVersion": 1,
        "launchSiteCount": len(boundary_launch_sites),
        "generatedLaunchSitesUseIndirection": not bool(raw_launches or bypasses),
        "directLaunchBypassCount": len(bypasses) + len(raw_launches),
        "loaderOwnsSymbolLookup": not bool(vendor_lookups),
        "vendorSymbolLookupBypassCount": len(vendor_lookups),
        "stalePointerRisk": "detected" if failed else "none",
        "staleLaunchPointerChecks": stale_checks,
        "reasonCodes": reason_codes,
        "evidence": {
            "boundaryLaunchSites": boundary_launch_sites,
            "rawLaunches": raw_launches,
            "directBypasses": bypasses,
            "vendorSymbolLookups": vendor_lookups,
            "verifierRules": verifier_rules,
        },
    }


def _is_host_role_path(path: str) -> bool:
    normalized = path.replace("\\", "/").lower()
    return any(
        token in normalized
        for token in (
            "/core.",
            "/gui.",
            "/host_runner.",
            "core.cpp",
            "gui.cpp",
            "host_runner.cpp",
        )
    )


def _verification_rules(verification: Mapping[str, Any] | None) -> list[str]:
    if not verification:
        return []
    violations = verification.get("violations")
    if not isinstance(violations, Sequence) or isinstance(violations, (str, bytes)):
        return []
    rules = []
    for item in violations:
        if isinstance(item, Mapping):
            rule = item.get("rule")
            if isinstance(rule, str):
                rules.append(rule)
    return rules

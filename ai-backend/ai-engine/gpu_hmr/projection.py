"""Target-scoped GPU HMR projection builder.

Projection building is deliberately compact. It packages target identity,
CodeIntel generation, build metadata hashes, source refs, and evidence refs for
the broker without copying source text or maintaining a second RAG store.
"""

from __future__ import annotations

from typing import Any, Dict, Iterable, List, Mapping, Optional

from gpu_hmr.broker import TARGET_SCOPED_PROJECTION_SCHEMA_VERSION
from gpu_hmr.canonical import GPU_HMR_IDENTITY_POLICY, canonical_hash
from gpu_hmr.reason_codes import assert_registered_reason_codes


TARGET_SCOPED_PROJECTION_BUILD_SCHEMA_VERSION = "gpu-hmr-target-scoped-projection-build-v1"


def build_target_scoped_projection(
    *,
    source_split_identity_hash: str,
    codeintel_generation: str,
    target_metadata: Mapping[str, Any],
    idempotency_key: Optional[str] = None,
    source_context_report: Optional[Mapping[str, Any]] = None,
    retrieval_evidence_refs: Optional[Iterable[Mapping[str, Any]]] = None,
) -> Dict[str, Any]:
    """Build a broker projection request from compact authority records."""

    blocking_reason_codes = _sorted_unique(str(code) for code in target_metadata.get("blockingReasonCodes") or [])
    advisory_reason_codes = _sorted_unique(str(code) for code in target_metadata.get("advisoryReasonCodes") or [])
    reason_codes = _sorted_unique([*blocking_reason_codes, *advisory_reason_codes])
    assert_registered_reason_codes(reason_codes)

    selected_target_hash = target_metadata.get("selectedTargetIdentityHash")
    build_metadata_hash = target_metadata.get("buildMetadataHash")
    if not selected_target_hash:
        blocking_reason_codes = _sorted_unique([*blocking_reason_codes, "target_resolution_unmatched"])
    if not build_metadata_hash:
        blocking_reason_codes = _sorted_unique([*blocking_reason_codes, "build_metadata_missing"])
    reason_codes = _sorted_unique([*blocking_reason_codes, *advisory_reason_codes])
    assert_registered_reason_codes(reason_codes)

    source_sets = _source_sets(target_metadata, source_context_report)
    build_toolchain_refs = [dict(ref) for ref in target_metadata.get("evidenceRefs") or [] if isinstance(ref, Mapping)]
    retrieval_refs = [dict(ref) for ref in retrieval_evidence_refs or [] if isinstance(ref, Mapping)]

    status = "blocked" if blocking_reason_codes else "ready"
    broker_request = None
    projection_hash = None
    if status == "ready":
        broker_request = {
            "sourceSplitIdentityHash": source_split_identity_hash,
            "selectedTargetIdentityHash": str(selected_target_hash),
            "codeIntelGeneration": codeintel_generation,
            "buildMetadataHash": str(build_metadata_hash),
            "idempotencyKey": idempotency_key
            or f"gpu-hmr:projection:{source_split_identity_hash}:{codeintel_generation}:{build_metadata_hash}",
            "sourceSets": source_sets,
            "retrievalEvidenceRefs": retrieval_refs,
            "buildToolchainEvidenceRefs": build_toolchain_refs,
            "reasonCodes": advisory_reason_codes,
        }
        projection_hash = canonical_hash(
            {
                "schemaVersion": TARGET_SCOPED_PROJECTION_SCHEMA_VERSION,
                "sourceSplitIdentityHash": broker_request["sourceSplitIdentityHash"],
                "selectedTargetIdentityHash": broker_request["selectedTargetIdentityHash"],
                "codeIntelGeneration": broker_request["codeIntelGeneration"],
                "buildMetadataHash": broker_request["buildMetadataHash"],
                "sourceSets": broker_request["sourceSets"],
                "retrievalEvidenceRefs": broker_request["retrievalEvidenceRefs"],
                "buildToolchainEvidenceRefs": broker_request["buildToolchainEvidenceRefs"],
                "reasonCodes": broker_request["reasonCodes"],
            },
            policy=GPU_HMR_IDENTITY_POLICY,
        )

    return {
        "schemaVersion": TARGET_SCOPED_PROJECTION_BUILD_SCHEMA_VERSION,
        "status": status,
        "projectionHash": projection_hash,
        "brokerRequest": broker_request,
        "sourceSplitIdentityHash": source_split_identity_hash,
        "selectedTargetIdentityHash": selected_target_hash,
        "codeIntelGeneration": codeintel_generation,
        "buildMetadataHash": build_metadata_hash,
        "sourceSets": source_sets,
        "retrievalEvidenceRefs": retrieval_refs,
        "buildToolchainEvidenceRefs": build_toolchain_refs,
        "blockingReasonCodes": blocking_reason_codes,
        "advisoryReasonCodes": advisory_reason_codes,
    }


def _source_sets(
    target_metadata: Mapping[str, Any],
    source_context_report: Optional[Mapping[str, Any]],
) -> Dict[str, Any]:
    selected = target_metadata.get("selectedTargetIdentity")
    target_input_files: List[str] = []
    if isinstance(selected, Mapping):
        target_input_files = _sorted_unique(str(path) for path in selected.get("sourceFiles") or [])

    included_refs: List[Dict[str, Any]] = []
    dropped_refs: List[Dict[str, Any]] = []
    report = source_context_report if isinstance(source_context_report, Mapping) else {}
    for item in report.get("included") or []:
        if not isinstance(item, Mapping):
            continue
        path = str(item.get("path") or "")
        if target_input_files and path not in target_input_files:
            continue
        included_refs.append(
            {
                "path": path,
                "contentHash": item.get("contentHash"),
                "reason": item.get("includeReason") or item.get("reason"),
                "truncated": bool(item.get("truncated")),
            }
        )
    for item in report.get("dropped") or []:
        if not isinstance(item, Mapping):
            continue
        path = str(item.get("path") or "")
        if target_input_files and path not in target_input_files:
            continue
        dropped_refs.append(
            {
                "path": path,
                "contentHash": item.get("contentHash"),
                "dropReason": item.get("dropReason"),
            }
        )

    return {
        "targetInputFiles": target_input_files,
        "includedSourceRefs": sorted(included_refs, key=lambda item: str(item.get("path") or "")),
        "droppedSourceRefs": sorted(dropped_refs, key=lambda item: str(item.get("path") or "")),
    }


def _sorted_unique(values: Iterable[str]) -> List[str]:
    return sorted({str(value) for value in values if str(value)})

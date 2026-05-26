"""In-process GPU HMR split-broker resource ledger.

The broker is a contract layer over existing CodeIntel, RAG, build metadata,
and verifier producers. It stores compact identities and lifecycle records; it
does not scan source trees or build a second retrieval/indexing system.
"""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass, field
from datetime import datetime, timezone
from threading import RLock
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

from pydantic import ValidationError

from gpu_hmr.canonical import GPU_HMR_IDENTITY_POLICY, CanonicalizationError, canonical_hash, normalize_workspace_path
from gpu_hmr.contracts import (
    AcceptedPointer,
    AcceptedPromotionRecord,
    CandidateSpecManifest,
    CandidateState,
    CandidateVerificationRecord,
    VerifierReport,
)
from gpu_hmr.reason_codes import UnknownReasonCodeError, assert_registered_reason_codes, get_reason_code


TARGET_SCOPED_PROJECTION_SCHEMA_VERSION = "gpu-hmr-target-scoped-projection-v1"
CANDIDATE_RESOURCE_SCHEMA_VERSION = "gpu-hmr-candidate-resource-v1"
JOB_RESOURCE_SCHEMA_VERSION = "gpu-hmr-job-resource-v1"
BROKER_TRACE_EVENT_SCHEMA_VERSION = "gpu-hmr-broker-trace-event-v1"
READINESS_RESPONSE_SCHEMA_VERSION = "gpu-hmr-readiness-response-v1"

MUTATING_OPERATION_SCHEMA_VERSION = "gpu-hmr-mutating-operation-v1"
PREPARED_CANDIDATE_ID_SCHEMA_VERSION = "gpu-hmr-prepared-candidate-id-v1"
JOB_ID_SCHEMA_VERSION = "gpu-hmr-job-id-v1"

VERIFICATION_KIND_TO_VERIFIER = {
    "schema": "schema",
    "scope": "role_scope",
    "dependency": "dependency",
    "mapping": "mapping",
    "abi": "abi",
    "compile": "compile",
    "runtime": "runtime",
}

PROOF_REQUIRED_KINDS = {"dependency", "abi", "compile", "runtime"}

VERIFIED_STATE_RANK: Dict[CandidateState, int] = {
    "schema_verified_candidate": 1,
    "compile_verified_candidate": 2,
    "runtime_verified_candidate": 3,
}


def _utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _hash_material(schema_version: str, material: Dict[str, Any]) -> str:
    return canonical_hash({"schemaVersion": schema_version, **material}, policy=GPU_HMR_IDENTITY_POLICY)


def _sorted_unique(values: Iterable[str]) -> List[str]:
    return sorted({str(value) for value in values})


def _model_dict(model: Any) -> Dict[str, Any]:
    if hasattr(model, "model_dump"):
        return model.model_dump(exclude_none=False)
    return model.dict(exclude_none=False)


def _candidate_verified_state_for_kinds(kinds: Iterable[str]) -> CandidateState:
    kind_set = {str(kind) for kind in kinds}
    if "runtime" in kind_set:
        return "runtime_verified_candidate"
    if "compile" in kind_set:
        return "compile_verified_candidate"
    return "schema_verified_candidate"


def _highest_verified_state(previous_state: CandidateState, requested_state: CandidateState) -> CandidateState:
    if VERIFIED_STATE_RANK.get(previous_state, 0) > VERIFIED_STATE_RANK.get(requested_state, 0):
        return previous_state
    return requested_state


@dataclass
class BrokerError(Exception):
    status_code: int
    reason_code: str
    message: Optional[str] = None
    details: Dict[str, Any] = field(default_factory=dict)

    def to_payload(self) -> Dict[str, Any]:
        entry = get_reason_code(self.reason_code)
        if entry is None:
            return {
                "error": {
                    "code": self.reason_code,
                    "message": self.message or "GPU HMR operation failed.",
                    "phase": "unknown",
                    "severity": "blocking",
                    "safeFallbackMode": "diagnostics_only",
                    "remediation": "Register this reason code before returning it from production code.",
                    "details": self.details,
                }
            }
        return {
            "error": {
                "code": entry.code,
                "message": self.message or entry.message,
                "phase": entry.phase,
                "severity": entry.severity,
                "safeFallbackMode": entry.safeFallbackMode,
                "remediation": entry.requiredRemediation,
                "details": self.details,
            }
        }


@dataclass
class TraceEvent:
    event: str
    phase: str
    reasonCodes: List[str] = field(default_factory=list)
    details: Dict[str, Any] = field(default_factory=dict)
    createdAt: str = field(default_factory=_utc_now)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "schemaVersion": BROKER_TRACE_EVENT_SCHEMA_VERSION,
            "event": self.event,
            "phase": self.phase,
            "reasonCodes": list(self.reasonCodes),
            "details": deepcopy(self.details),
            "createdAt": self.createdAt,
        }


@dataclass
class ProjectionRecord:
    projectionHash: str
    sourceSplitIdentityHash: str
    selectedTargetIdentityHash: str
    codeIntelGeneration: str
    buildMetadataHash: str
    status: str
    sourceSets: Dict[str, Any] = field(default_factory=dict)
    retrievalEvidenceRefs: List[Dict[str, Any]] = field(default_factory=list)
    buildToolchainEvidenceRefs: List[Dict[str, Any]] = field(default_factory=list)
    reasonCodes: List[str] = field(default_factory=list)
    createdAt: str = field(default_factory=_utc_now)
    updatedAt: str = field(default_factory=_utc_now)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "schemaVersion": TARGET_SCOPED_PROJECTION_SCHEMA_VERSION,
            "projectionHash": self.projectionHash,
            "sourceSplitIdentityHash": self.sourceSplitIdentityHash,
            "selectedTargetIdentityHash": self.selectedTargetIdentityHash,
            "codeIntelGeneration": self.codeIntelGeneration,
            "buildMetadataHash": self.buildMetadataHash,
            "status": self.status,
            "sourceSets": deepcopy(self.sourceSets),
            "retrievalEvidenceRefs": deepcopy(self.retrievalEvidenceRefs),
            "buildToolchainEvidenceRefs": deepcopy(self.buildToolchainEvidenceRefs),
            "reasonCodes": list(self.reasonCodes),
            "createdAt": self.createdAt,
            "updatedAt": self.updatedAt,
        }


@dataclass
class CandidateRecord:
    candidateId: str
    projectionHash: str
    sourceSplitIdentityHash: str
    selectedTargetIdentityHash: str
    requestedRoles: List[str]
    state: CandidateState
    candidateSpecManifestHash: Optional[str] = None
    candidateVerificationRecordHash: Optional[str] = None
    jobId: Optional[str] = None
    reasonCodes: List[str] = field(default_factory=list)
    generatedArtifactHash: Optional[str] = None
    roleGenerationPackageHashes: List[str] = field(default_factory=list)
    generatedRoles: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    sourceToGeneratedMappingHash: Optional[str] = None
    verifierReportHashes: List[str] = field(default_factory=list)
    createdAt: str = field(default_factory=_utc_now)
    updatedAt: str = field(default_factory=_utc_now)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "schemaVersion": CANDIDATE_RESOURCE_SCHEMA_VERSION,
            "candidateId": self.candidateId,
            "projectionHash": self.projectionHash,
            "sourceSplitIdentityHash": self.sourceSplitIdentityHash,
            "selectedTargetIdentityHash": self.selectedTargetIdentityHash,
            "requestedRoles": list(self.requestedRoles),
            "state": self.state,
            "candidateSpecManifestHash": self.candidateSpecManifestHash,
            "candidateVerificationRecordHash": self.candidateVerificationRecordHash,
            "jobId": self.jobId,
            "reasonCodes": list(self.reasonCodes),
            "generatedArtifactHash": self.generatedArtifactHash,
            "roleGenerationPackageHashes": list(self.roleGenerationPackageHashes),
            "generatedRoles": deepcopy(self.generatedRoles),
            "sourceToGeneratedMappingHash": self.sourceToGeneratedMappingHash,
            "verifierReportHashes": list(self.verifierReportHashes),
            "createdAt": self.createdAt,
            "updatedAt": self.updatedAt,
        }


@dataclass
class JobRecord:
    jobId: str
    jobKind: str
    status: str
    linkedResource: Dict[str, Optional[str]]
    phase: str
    reasonCodes: List[str] = field(default_factory=list)
    startedAt: str = field(default_factory=_utc_now)
    updatedAt: str = field(default_factory=_utc_now)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "schemaVersion": JOB_RESOURCE_SCHEMA_VERSION,
            "jobId": self.jobId,
            "jobKind": self.jobKind,
            "status": self.status,
            "linkedResource": deepcopy(self.linkedResource),
            "phase": self.phase,
            "reasonCodes": list(self.reasonCodes),
            "startedAt": self.startedAt,
            "updatedAt": self.updatedAt,
        }


@dataclass
class IdempotencyRecord:
    requestHash: str
    statusCode: int
    response: Dict[str, Any]


class GpuHmrBroker:
    def __init__(self) -> None:
        self._lock = RLock()
        self._reset_state()

    def _reset_state(self) -> None:
        self._promotion_lock_active = False
        self.projections: Dict[str, ProjectionRecord] = {}
        self.candidates: Dict[str, CandidateRecord] = {}
        self.candidates_by_spec: Dict[str, str] = {}
        self.jobs: Dict[str, JobRecord] = {}
        self.verifier_reports: Dict[str, Dict[str, Any]] = {}
        self.verification_records: Dict[str, Dict[str, Any]] = {}
        self.accepted_promotions: Dict[str, Dict[str, Any]] = {}
        self.accepted_pointer: Optional[Dict[str, Any]] = None
        self.traces: Dict[str, List[TraceEvent]] = {}
        self.job_traces: Dict[str, List[TraceEvent]] = {}
        self.idempotency: Dict[Tuple[str, str], IdempotencyRecord] = {}

    def reset_for_tests(self) -> None:
        with self._lock:
            self._reset_state()

    def readiness(self, request: Dict[str, Any]) -> Dict[str, Any]:
        selected_target_hash = request.get("selectedTargetIdentityHash")
        source_split_hash = request.get("sourceSplitIdentityHash")
        codeintel_generation = request.get("codeIntelGeneration")
        build_metadata_hash = request.get("buildMetadataHash")
        projection_hash = request.get("projectionHash")

        blocking: List[str] = []
        advisory: List[str] = []
        if not selected_target_hash:
            blocking.append("target_resolution_unmatched")
        if projection_hash and projection_hash not in self.projections:
            blocking.append("projection_not_found")
        if not projection_hash and not (source_split_hash and codeintel_generation and build_metadata_hash):
            blocking.append("build_metadata_missing")

        if projection_hash and projection_hash in self.projections:
            projection = self.projections[projection_hash]
            if selected_target_hash and projection.selectedTargetIdentityHash != selected_target_hash:
                blocking.append("projection.identity_mismatch")
            if source_split_hash and projection.sourceSplitIdentityHash != source_split_hash:
                blocking.append("candidate.stale_source_generation")
            if codeintel_generation and projection.codeIntelGeneration != codeintel_generation:
                blocking.append("candidate.stale_codeintel_generation")
            if build_metadata_hash and projection.buildMetadataHash != build_metadata_hash:
                blocking.append("projection.identity_mismatch")
            advisory.extend(projection.reasonCodes)

        assert_registered_reason_codes(blocking)
        assert_registered_reason_codes(advisory)
        projection_blockers = {
            "build_metadata_missing",
            "projection_not_found",
            "projection.identity_mismatch",
            "candidate.stale_codeintel_generation",
            "candidate.stale_source_generation",
        }

        return {
            "schemaVersion": READINESS_RESPONSE_SCHEMA_VERSION,
            "readiness": {
                "preflight": "blocked" if any(code.startswith("target_") for code in blocking) else "pass",
                "projection": "blocked" if any(code in projection_blockers for code in blocking) else "pass",
                "scope": "pass" if projection_hash and projection_hash in self.projections and not blocking else "blocked",
                "generation": "blocked",
                "compile": "blocked",
                "promotion": "blocked",
            },
            "blockingReasonCodes": _sorted_unique(blocking),
            "advisoryReasonCodes": _sorted_unique(advisory),
            "selectedTargetIdentityHash": selected_target_hash,
            "projectionHash": projection_hash,
        }

    def create_projection(self, request: Dict[str, Any]) -> Tuple[int, Dict[str, Any]]:
        return self._idempotent("create_projection", request, lambda: self._create_projection_unlocked(request))

    def get_projection(self, projection_hash: str) -> Dict[str, Any]:
        with self._lock:
            projection = self.projections.get(projection_hash)
            if not projection:
                raise BrokerError(404, "projection_not_found", details={"projectionHash": projection_hash})
            return projection.to_dict()

    def prepare_candidate(self, request: Dict[str, Any]) -> Tuple[int, Dict[str, Any]]:
        return self._idempotent("prepare_candidate", request, lambda: self._prepare_candidate_unlocked(request))

    def list_candidates(self, selected_target_hash: Optional[str] = None) -> Dict[str, Any]:
        with self._lock:
            candidates = [
                candidate.to_dict()
                for candidate in self.candidates.values()
                if not selected_target_hash or candidate.selectedTargetIdentityHash == selected_target_hash
            ]
            candidates.sort(key=lambda item: item["candidateId"])
            return {"schemaVersion": "gpu-hmr-candidate-list-v1", "candidates": candidates}

    def get_candidate(self, candidate_id: str) -> Dict[str, Any]:
        with self._lock:
            return self._candidate_or_error(candidate_id).to_dict()

    def get_candidate_trace(self, candidate_id: str) -> Dict[str, Any]:
        with self._lock:
            self._candidate_or_error(candidate_id)
            return {
                "schemaVersion": "gpu-hmr-candidate-trace-v1",
                "candidateId": candidate_id,
                "events": [event.to_dict() for event in self.traces.get(candidate_id, [])],
            }

    def verify_candidate(self, candidate_id: str, request: Dict[str, Any]) -> Tuple[int, Dict[str, Any]]:
        return self._idempotent(
            f"verify_candidate:{candidate_id}",
            request,
            lambda: self._verify_candidate_unlocked(candidate_id, request),
        )

    def promote_candidate(self, candidate_id: str, request: Dict[str, Any]) -> Tuple[int, Dict[str, Any]]:
        return self._idempotent(
            f"promote_candidate:{candidate_id}",
            request,
            lambda: self._promote_candidate_unlocked(candidate_id, request),
        )

    def cancel_candidate(self, candidate_id: str, request: Dict[str, Any]) -> Tuple[int, Dict[str, Any]]:
        return self._idempotent(
            f"cancel_candidate:{candidate_id}",
            request,
            lambda: self._cancel_candidate_unlocked(candidate_id),
        )

    def diagnose_candidate(self, candidate_id: str, request: Dict[str, Any]) -> Tuple[int, Dict[str, Any]]:
        return self._idempotent(
            f"diagnose_candidate:{candidate_id}",
            request,
            lambda: self._diagnose_candidate_unlocked(candidate_id),
        )

    def get_job(self, job_id: str) -> Dict[str, Any]:
        with self._lock:
            job = self.jobs.get(job_id)
            if not job:
                raise BrokerError(404, "job_not_found", details={"jobId": job_id})
            return job.to_dict()

    def get_job_trace(self, job_id: str) -> Dict[str, Any]:
        with self._lock:
            if job_id not in self.jobs:
                raise BrokerError(404, "job_not_found", details={"jobId": job_id})
            return {
                "schemaVersion": "gpu-hmr-job-trace-v1",
                "jobId": job_id,
                "events": [event.to_dict() for event in self.job_traces.get(job_id, [])],
            }

    def cancel_job(self, job_id: str, request: Dict[str, Any]) -> Tuple[int, Dict[str, Any]]:
        return self._idempotent(f"cancel_job:{job_id}", request, lambda: self._cancel_job_unlocked(job_id))

    def get_accepted_current(self) -> Dict[str, Any]:
        with self._lock:
            return {"schemaVersion": "gpu-hmr-accepted-current-v1", "acceptedPointer": deepcopy(self.accepted_pointer)}

    def _idempotent(
        self,
        operation: str,
        request: Dict[str, Any],
        producer: Callable[[], Tuple[int, Dict[str, Any]]],
    ) -> Tuple[int, Dict[str, Any]]:
        key = request.get("idempotencyKey")
        if not key:
            raise BrokerError(400, "gpu_hmr.idempotency_key_missing", details={"operation": operation})
        request_hash = canonical_hash(
            {"schemaVersion": MUTATING_OPERATION_SCHEMA_VERSION, "operation": operation, "request": request}
        )
        with self._lock:
            existing = self.idempotency.get((operation, key))
            if existing:
                if existing.requestHash != request_hash:
                    raise BrokerError(409, "gpu_hmr.idempotency_key_conflict", details={"operation": operation})
                return existing.statusCode, deepcopy(existing.response)
            status_code, response = producer()
            self.idempotency[(operation, key)] = IdempotencyRecord(
                requestHash=request_hash,
                statusCode=status_code,
                response=deepcopy(response),
            )
            return status_code, response

    def _create_projection_unlocked(self, request: Dict[str, Any]) -> Tuple[int, Dict[str, Any]]:
        required = ["sourceSplitIdentityHash", "selectedTargetIdentityHash", "codeIntelGeneration", "buildMetadataHash"]
        missing = [field for field in required if not request.get(field)]
        if missing:
            raise BrokerError(400, "gpu_hmr.request_invalid", details={"missing": missing})

        reason_codes = _sorted_unique(request.get("reasonCodes") or [])
        try:
            assert_registered_reason_codes(reason_codes)
        except UnknownReasonCodeError as exc:
            raise BrokerError(
                400,
                "gpu_hmr.request_invalid",
                details={"unknownReasonCodes": exc.unknown_codes},
            ) from exc
        projection_material = {
            "sourceSplitIdentityHash": request["sourceSplitIdentityHash"],
            "selectedTargetIdentityHash": request["selectedTargetIdentityHash"],
            "codeIntelGeneration": request["codeIntelGeneration"],
            "buildMetadataHash": request["buildMetadataHash"],
            "sourceSets": request.get("sourceSets") or {},
            "retrievalEvidenceRefs": request.get("retrievalEvidenceRefs") or [],
            "buildToolchainEvidenceRefs": request.get("buildToolchainEvidenceRefs") or [],
            "reasonCodes": reason_codes,
        }
        try:
            projection_hash = _hash_material(TARGET_SCOPED_PROJECTION_SCHEMA_VERSION, projection_material)
        except CanonicalizationError as exc:
            raise BrokerError(400, "gpu_hmr.request_invalid", details={"error": str(exc)}) from exc
        status = "blocked" if self._has_blocking_reason(reason_codes) else "ready"

        projection = self.projections.get(projection_hash)
        if projection is None:
            projection = ProjectionRecord(
                projectionHash=projection_hash,
                sourceSplitIdentityHash=request["sourceSplitIdentityHash"],
                selectedTargetIdentityHash=request["selectedTargetIdentityHash"],
                codeIntelGeneration=request["codeIntelGeneration"],
                buildMetadataHash=request["buildMetadataHash"],
                status=status,
                sourceSets=deepcopy(request.get("sourceSets") or {}),
                retrievalEvidenceRefs=deepcopy(request.get("retrievalEvidenceRefs") or []),
                buildToolchainEvidenceRefs=deepcopy(request.get("buildToolchainEvidenceRefs") or []),
                reasonCodes=reason_codes,
            )
            self.projections[projection_hash] = projection

        return 200, {"projectionHash": projection_hash, "jobId": None, "status": projection.status}

    def _prepare_candidate_unlocked(self, request: Dict[str, Any]) -> Tuple[int, Dict[str, Any]]:
        projection_hash = request.get("projectionHash")
        source_split_hash = request.get("sourceSplitIdentityHash")
        requested_roles = [str(role) for role in request.get("requestedRoles") or []]
        if not projection_hash or not source_split_hash or not requested_roles:
            raise BrokerError(
                400,
                "gpu_hmr.request_invalid",
                details={"required": ["projectionHash", "sourceSplitIdentityHash", "requestedRoles"]},
            )

        projection = self.projections.get(projection_hash)
        if not projection:
            raise BrokerError(404, "projection_not_found", details={"projectionHash": projection_hash})
        if projection.sourceSplitIdentityHash != source_split_hash:
            raise BrokerError(
                409,
                "candidate.stale_source_generation",
                details={
                    "projectionSourceSplitIdentityHash": projection.sourceSplitIdentityHash,
                    "requestSourceSplitIdentityHash": source_split_hash,
                },
            )
        if projection.status != "ready":
            raise BrokerError(422, "projection.identity_mismatch", details={"projectionStatus": projection.status})

        generated_artifact_hash = request.get("generatedArtifactHash")
        role_package_hashes = [str(value) for value in request.get("roleGenerationPackageHashes") or []]
        generated_roles_input = request.get("generatedRoles") or {}
        mapping_hash = request.get("sourceToGeneratedMappingHash")
        has_spec_inputs = any([generated_artifact_hash, role_package_hashes, generated_roles_input, mapping_hash])

        candidate_spec_hash: Optional[str] = None
        generated_roles: Dict[str, Dict[str, Any]] = {}
        if has_spec_inputs:
            missing_spec = []
            if not generated_artifact_hash:
                missing_spec.append("generatedArtifactHash")
            if not role_package_hashes:
                missing_spec.append("roleGenerationPackageHashes")
            if not generated_roles_input:
                missing_spec.append("generatedRoles")
            if not mapping_hash:
                missing_spec.append("sourceToGeneratedMappingHash")
            if missing_spec:
                raise BrokerError(422, "candidate.spec_manifest_missing", details={"missing": missing_spec})

            try:
                spec = CandidateSpecManifest(
                    sourceSplitIdentityHash=source_split_hash,
                    selectedTargetIdentityHash=projection.selectedTargetIdentityHash,
                    projectionHash=projection_hash,
                    roleGenerationPackageHashes=role_package_hashes,
                    generatedArtifactHash=str(generated_artifact_hash),
                    generatedRoles=generated_roles_input,
                    sourceToGeneratedMappingHash=str(mapping_hash),
                )
            except (TypeError, ValueError, ValidationError) as exc:
                raise BrokerError(400, "gpu_hmr.request_invalid", details={"error": str(exc)}) from exc
            candidate_id = spec.candidate_id()
            self._validate_generated_role_paths(candidate_id, spec)
            candidate_spec_hash = spec.contract_hash()
            generated_roles = {role: _model_dict(ref) for role, ref in spec.generatedRoles.items()}
            state: CandidateState = "generated_candidate"
        else:
            candidate_id = _hash_material(
                PREPARED_CANDIDATE_ID_SCHEMA_VERSION,
                {
                    "projectionHash": projection_hash,
                    "sourceSplitIdentityHash": source_split_hash,
                    "requestedRoles": _sorted_unique(requested_roles),
                },
            )
            state = "prepared_candidate"

        existing = self.candidates.get(candidate_id)
        if existing:
            return 202, {
                "candidateId": existing.candidateId,
                "candidateSpecManifestHash": existing.candidateSpecManifestHash,
                "jobId": existing.jobId,
                "state": existing.state,
            }

        job_id = self._new_job_id("prepare_candidate", candidate_id, request["idempotencyKey"])
        candidate = CandidateRecord(
            candidateId=candidate_id,
            projectionHash=projection_hash,
            sourceSplitIdentityHash=source_split_hash,
            selectedTargetIdentityHash=projection.selectedTargetIdentityHash,
            requestedRoles=_sorted_unique(requested_roles),
            state=state,
            candidateSpecManifestHash=candidate_spec_hash,
            jobId=job_id,
            generatedArtifactHash=str(generated_artifact_hash) if generated_artifact_hash else None,
            roleGenerationPackageHashes=_sorted_unique(role_package_hashes),
            generatedRoles=generated_roles,
            sourceToGeneratedMappingHash=str(mapping_hash) if mapping_hash else None,
        )
        self.candidates[candidate_id] = candidate
        if candidate_spec_hash:
            self.candidates_by_spec[candidate_spec_hash] = candidate_id
        self.traces[candidate_id] = [
            TraceEvent(
                event="candidate_prepared",
                phase="candidate_preparation",
                details={"projectionHash": projection_hash, "state": state},
            )
        ]

        job = JobRecord(
            jobId=job_id,
            jobKind="prepare_candidate",
            status="succeeded",
            linkedResource={"candidateId": candidate_id, "projectionHash": projection_hash},
            phase="completed",
        )
        self.jobs[job_id] = job
        self.job_traces[job_id] = [
            TraceEvent(
                event="job_completed",
                phase="candidate_preparation",
                details={"candidateId": candidate_id, "state": state},
            )
        ]

        return 202, {
            "candidateId": candidate_id,
            "candidateSpecManifestHash": candidate_spec_hash,
            "jobId": job_id,
            "state": state,
        }

    def _verify_candidate_unlocked(self, candidate_id: str, request: Dict[str, Any]) -> Tuple[int, Dict[str, Any]]:
        candidate = self._candidate_or_error(candidate_id)
        if candidate.state == "cancelled_candidate":
            raise BrokerError(409, "candidate.verification_cancelled", details={"candidateId": candidate_id})
        requested_spec_hash = request.get("candidateSpecManifestHash")
        if not candidate.candidateSpecManifestHash:
            raise BrokerError(422, "candidate.spec_manifest_missing", details={"candidateId": candidate_id})
        if requested_spec_hash != candidate.candidateSpecManifestHash:
            raise BrokerError(
                409,
                "candidate.spec_manifest_mismatch",
                details={
                    "candidateSpecManifestHash": candidate.candidateSpecManifestHash,
                    "requestCandidateSpecManifestHash": requested_spec_hash,
                },
            )

        kinds = [str(kind) for kind in request.get("verificationKinds") or []]
        unknown_kinds = sorted(set(kinds) - set(VERIFICATION_KIND_TO_VERIFIER))
        if not kinds or unknown_kinds:
            raise BrokerError(400, "gpu_hmr.request_invalid", details={"unknownVerificationKinds": unknown_kinds})

        reports: List[VerifierReport] = []
        blocking_reason_codes: List[str] = []
        for kind in kinds:
            report = self._run_verifier(candidate, kind, request.get("runtimeVerificationIdentityHash"))
            reports.append(report)
            if report.status == "fail" and report.blocking:
                blocking_reason_codes.extend(report.reasonCodes)

        report_hashes: List[str] = []
        for report in reports:
            report_hash = report.contract_hash()
            self.verifier_reports[report_hash] = _model_dict(report)
            report_hashes.append(report_hash)

        if blocking_reason_codes:
            next_state: CandidateState = "rejected_candidate"
        else:
            requested_state = _candidate_verified_state_for_kinds(kinds)
            next_state = _highest_verified_state(candidate.state, requested_state)

        previous_state = candidate.state
        requested_state_rank = VERIFIED_STATE_RANK.get(_candidate_verified_state_for_kinds(kinds), 0)
        next_state_rank = VERIFIED_STATE_RANK.get(next_state, 0)
        candidate_report_hashes = report_hashes
        if next_state == previous_state and next_state_rank > requested_state_rank:
            candidate_report_hashes = _sorted_unique([*candidate.verifierReportHashes, *report_hashes])
        record = CandidateVerificationRecord(
            candidateId=candidate.candidateId,
            candidateSpecManifestHash=candidate.candidateSpecManifestHash,
            state=next_state,
            verifierReportHashes=candidate_report_hashes,
            transitionHistory=[
                {
                    "from": previous_state,
                    "to": next_state,
                    "verificationKinds": kinds,
                    "reasonCodes": _sorted_unique(blocking_reason_codes),
                }
            ],
        )
        record_hash = record.contract_hash()
        self.verification_records[record_hash] = _model_dict(record)
        candidate.state = next_state
        candidate.candidateVerificationRecordHash = record_hash
        candidate.verifierReportHashes = candidate_report_hashes
        candidate.reasonCodes = _sorted_unique(blocking_reason_codes)
        candidate.updatedAt = _utc_now()
        self.traces.setdefault(candidate_id, []).append(
            TraceEvent(
                event="candidate_verified",
                phase="candidate_verification",
                reasonCodes=_sorted_unique(blocking_reason_codes),
                details={"state": next_state, "verifierReportHashes": report_hashes},
            )
        )

        return 200, {
            "candidateId": candidate_id,
            "candidateVerificationRecordHash": record_hash,
            "jobId": None,
            "state": next_state,
            "verifierReportHashes": candidate_report_hashes,
            "blockingReasonCodes": _sorted_unique(blocking_reason_codes),
        }

    def _promote_candidate_unlocked(self, candidate_id: str, request: Dict[str, Any]) -> Tuple[int, Dict[str, Any]]:
        candidate = self._candidate_or_error(candidate_id)
        if self._promotion_lock_active:
            raise BrokerError(409, "promotion.concurrent_transaction", details={"candidateId": candidate_id})
        if not candidate.candidateSpecManifestHash:
            raise BrokerError(422, "candidate.spec_manifest_missing", details={"candidateId": candidate_id})
        if request.get("candidateSpecManifestHash") != candidate.candidateSpecManifestHash:
            raise BrokerError(409, "candidate.spec_manifest_mismatch", details={"candidateId": candidate_id})
        if not candidate.candidateVerificationRecordHash:
            raise BrokerError(422, "candidate.verification_record_missing", details={"candidateId": candidate_id})
        if request.get("candidateVerificationRecordHash") != candidate.candidateVerificationRecordHash:
            raise BrokerError(409, "candidate.verification_record_mismatch", details={"candidateId": candidate_id})
        if candidate.state not in {"promotion_ready_candidate", "runtime_verified_candidate"}:
            raise BrokerError(
                422,
                "candidate.verification_failed_closed",
                details={"state": candidate.state, "requiredState": "runtime_verified_candidate"},
            )

        self._promotion_lock_active = True
        try:
            promotion = AcceptedPromotionRecord(
                candidateId=candidate.candidateId,
                candidateSpecManifestHash=candidate.candidateSpecManifestHash,
                candidateVerificationRecordHash=candidate.candidateVerificationRecordHash,
                promotionIdentityHash=str(request.get("promotionIdentityHash") or ""),
                requiredVerifierReportHashes=candidate.verifierReportHashes,
            )
            promotion_hash = promotion.contract_hash()
            pointer = AcceptedPointer(
                acceptedPromotionRecordHash=promotion_hash,
                candidateId=candidate.candidateId,
                candidateSpecManifestHash=candidate.candidateSpecManifestHash,
                selectedTargetIdentityHash=candidate.selectedTargetIdentityHash,
                candidatePath=f".synthi/gpu_hmr/candidates/{candidate.candidateId}",
            )
            self.accepted_promotions[promotion_hash] = _model_dict(promotion)
            self.accepted_pointer = _model_dict(pointer)
            candidate.state = "active_promoted_candidate"
            candidate.updatedAt = _utc_now()
            self.traces.setdefault(candidate_id, []).append(
                TraceEvent(
                    event="candidate_promoted",
                    phase="promotion",
                    details={"acceptedPromotionRecordHash": promotion_hash},
                )
            )
        finally:
            self._promotion_lock_active = False

        return 200, {
            "acceptedPromotionRecordHash": promotion_hash,
            "acceptedPointerPath": ".synthi/gpu_hmr/accepted/current.json",
            "state": candidate.state,
        }

    def _cancel_candidate_unlocked(self, candidate_id: str) -> Tuple[int, Dict[str, Any]]:
        candidate = self._candidate_or_error(candidate_id)
        if candidate.state == "active_promoted_candidate":
            raise BrokerError(409, "candidate.verification_failed_closed", details={"state": candidate.state})
        candidate.state = "cancelled_candidate"
        candidate.reasonCodes = _sorted_unique([*candidate.reasonCodes, "candidate.verification_cancelled"])
        candidate.updatedAt = _utc_now()
        self.traces.setdefault(candidate_id, []).append(
            TraceEvent(event="candidate_cancelled", phase="candidate_lifecycle", reasonCodes=["candidate.verification_cancelled"])
        )
        return 200, {"candidateId": candidate_id, "state": candidate.state}

    def _diagnose_candidate_unlocked(self, candidate_id: str) -> Tuple[int, Dict[str, Any]]:
        candidate = self._candidate_or_error(candidate_id)
        job_id = self._new_job_id("diagnose_candidate", candidate_id, candidate.updatedAt)
        job = JobRecord(
            jobId=job_id,
            jobKind="diagnose_candidate",
            status="succeeded",
            linkedResource={"candidateId": candidate_id, "projectionHash": candidate.projectionHash},
            phase="completed",
            reasonCodes=candidate.reasonCodes,
        )
        self.jobs[job_id] = job
        self.job_traces[job_id] = [
            TraceEvent(
                event="diagnostics_completed",
                phase="diagnostics",
                reasonCodes=candidate.reasonCodes,
                details={"state": candidate.state},
            )
        ]
        return 202, {
            "candidateId": candidate_id,
            "jobId": job_id,
            "state": candidate.state,
            "reasonCodes": list(candidate.reasonCodes),
        }

    def _cancel_job_unlocked(self, job_id: str) -> Tuple[int, Dict[str, Any]]:
        job = self.jobs.get(job_id)
        if not job:
            raise BrokerError(404, "job_not_found", details={"jobId": job_id})
        if job.status not in {"queued", "running"}:
            raise BrokerError(409, "job_not_cancellable", details={"jobId": job_id, "status": job.status})
        job.status = "cancelled"
        job.reasonCodes = _sorted_unique([*job.reasonCodes, "candidate.verification_cancelled"])
        job.updatedAt = _utc_now()
        self.job_traces.setdefault(job_id, []).append(
            TraceEvent(event="job_cancelled", phase=job.phase, reasonCodes=["candidate.verification_cancelled"])
        )
        return 200, job.to_dict()

    def _run_verifier(
        self,
        candidate: CandidateRecord,
        kind: str,
        runtime_verification_identity_hash: Optional[str],
    ) -> VerifierReport:
        projection = self.projections.get(candidate.projectionHash)
        input_snapshot = {
            "sourceSplitIdentityHash": candidate.sourceSplitIdentityHash,
            "compileCandidateIdentityHash": None,
            "runtimeVerificationIdentityHash": runtime_verification_identity_hash,
            "codeIntelGeneration": projection.codeIntelGeneration if projection else None,
            "retrievalTraceHashes": [],
        }
        verifier_name = VERIFICATION_KIND_TO_VERIFIER[kind]
        if kind in PROOF_REQUIRED_KINDS:
            return VerifierReport(
                verifierName=verifier_name,
                candidateId=candidate.candidateId,
                candidateSpecManifestHash=str(candidate.candidateSpecManifestHash),
                inputIdentitySnapshot=input_snapshot,
                status="fail",
                blocking=True,
                reasonCodes=["verifier.proof_unavailable"],
                proofRefs=[],
                toolVersion="gpu-hmr-broker-shell-v1",
            )

        reason_codes = self._local_verifier_reason_codes(candidate, kind)
        status = "fail" if reason_codes else "pass"
        proof_refs = []
        if not reason_codes:
            proof_refs.append(
                {
                    "kind": "broker_contract_check",
                    "hash": _hash_material(
                        "gpu-hmr-broker-contract-proof-v1",
                        {
                            "candidateId": candidate.candidateId,
                            "candidateSpecManifestHash": candidate.candidateSpecManifestHash,
                            "verificationKind": kind,
                        },
                    ),
                }
            )
        return VerifierReport(
            verifierName=verifier_name,
            candidateId=candidate.candidateId,
            candidateSpecManifestHash=str(candidate.candidateSpecManifestHash),
            inputIdentitySnapshot=input_snapshot,
            status=status,
            blocking=True,
            reasonCodes=reason_codes,
            proofRefs=proof_refs,
            toolVersion="gpu-hmr-broker-shell-v1",
        )

    def _local_verifier_reason_codes(self, candidate: CandidateRecord, kind: str) -> List[str]:
        if kind == "schema":
            if not candidate.generatedRoles:
                return ["candidate.spec_manifest_missing"]
            for role_ref in candidate.generatedRoles.values():
                if role_ref.get("internal") is not True:
                    return ["generated.path_traversal_rejected"]
            return []
        if kind == "scope":
            return [] if candidate.roleGenerationPackageHashes else ["candidate.verification_failed_closed"]
        if kind == "mapping":
            return [] if candidate.sourceToGeneratedMappingHash else ["candidate.verification_failed_closed"]
        return ["verifier.proof_unavailable"]

    def _validate_generated_role_paths(self, candidate_id: str, spec: CandidateSpecManifest) -> None:
        seen_casefolded: set[str] = set()
        expected_prefix = f".synthi/gpu_hmr/candidates/{candidate_id}/"
        for role, ref in spec.generatedRoles.items():
            try:
                path = normalize_workspace_path(ref.path)
            except CanonicalizationError as exc:
                message = str(exc)
                code = "generated.absolute_path_rejected" if "workspace-relative" in message else "generated.path_traversal_rejected"
                raise BrokerError(422, code, details={"role": role, "path": ref.path}) from exc
            if not path.startswith(expected_prefix):
                raise BrokerError(
                    422,
                    "generated.path_traversal_rejected",
                    details={"role": role, "path": path, "expectedPrefix": expected_prefix},
                )
            casefolded = path.casefold()
            if casefolded in seen_casefolded:
                raise BrokerError(422, "generated.case_collision_rejected", details={"path": path})
            seen_casefolded.add(casefolded)
            if ref.internal is not True:
                raise BrokerError(422, "generated.path_traversal_rejected", details={"role": role, "path": path})

    def _new_job_id(self, job_kind: str, resource_id: str, idempotency_key: str) -> str:
        return _hash_material(JOB_ID_SCHEMA_VERSION, {"jobKind": job_kind, "resourceId": resource_id, "idempotencyKey": idempotency_key})

    def _candidate_or_error(self, candidate_id: str) -> CandidateRecord:
        candidate = self.candidates.get(candidate_id)
        if not candidate:
            raise BrokerError(404, "candidate_not_found", details={"candidateId": candidate_id})
        return candidate

    def _has_blocking_reason(self, reason_codes: Iterable[str]) -> bool:
        for code in reason_codes:
            entry = get_reason_code(code)
            if entry and entry.blocking:
                return True
        return False


_BROKER = GpuHmrBroker()


def get_gpu_hmr_broker() -> GpuHmrBroker:
    return _BROKER


def reset_gpu_hmr_broker_for_tests() -> None:
    _BROKER.reset_for_tests()

"""FastAPI routes for GPU HMR split-broker resources."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from gpu_hmr.broker import BrokerError, get_gpu_hmr_broker

try:
    from pydantic import ConfigDict

    _PYDANTIC_V2 = True
except ImportError:  # pragma: no cover
    ConfigDict = None  # type: ignore
    _PYDANTIC_V2 = False


router = APIRouter(prefix="/gpu-hmr", tags=["gpu-hmr"])


class _StrictModel(BaseModel):
    if _PYDANTIC_V2:
        model_config = ConfigDict(extra="forbid")
    else:

        class Config:
            extra = "forbid"

    def payload(self) -> Dict[str, Any]:
        if hasattr(self, "model_dump"):
            return self.model_dump(exclude_none=False)
        return self.dict(exclude_none=False)  # type: ignore[attr-defined]


class ReadinessRequest(_StrictModel):
    workspaceRootDigest: Optional[str] = None
    entryFile: Optional[str] = None
    selectedTargetIdentityHash: Optional[str] = None
    sourceSplitIdentityHash: Optional[str] = None
    projectionHash: Optional[str] = None
    codeIntelGeneration: Optional[str] = None
    buildMetadataHash: Optional[str] = None
    operationMode: str = "normal"
    idempotencyKey: Optional[str] = None


class ProjectionRequest(_StrictModel):
    sourceSplitIdentityHash: str
    selectedTargetIdentityHash: str
    codeIntelGeneration: str
    buildMetadataHash: str
    idempotencyKey: str
    sourceSets: Dict[str, Any] = Field(default_factory=dict)
    retrievalEvidenceRefs: List[Dict[str, Any]] = Field(default_factory=list)
    buildToolchainEvidenceRefs: List[Dict[str, Any]] = Field(default_factory=list)
    reasonCodes: List[str] = Field(default_factory=list)


class PrepareCandidateRequest(_StrictModel):
    projectionHash: str
    sourceSplitIdentityHash: str
    requestedRoles: List[str]
    operationMode: str = "normal"
    idempotencyKey: str
    roleGenerationPackageHashes: List[str] = Field(default_factory=list)
    generatedArtifactHash: Optional[str] = None
    generatedRoles: Dict[str, Dict[str, Any]] = Field(default_factory=dict)
    sourceToGeneratedMappingHash: Optional[str] = None


class VerifyCandidateRequest(_StrictModel):
    candidateSpecManifestHash: str
    verificationKinds: List[str]
    runtimeVerificationIdentityHash: Optional[str] = None
    idempotencyKey: str


class PromoteCandidateRequest(_StrictModel):
    candidateSpecManifestHash: str
    candidateVerificationRecordHash: str
    promotionIdentityHash: str
    idempotencyKey: str


class IdempotentRequest(_StrictModel):
    idempotencyKey: str


def _response(status_code: int, payload: Dict[str, Any]) -> JSONResponse:
    return JSONResponse(status_code=status_code, content=payload)


def _handle(call):
    try:
        result = call()
        if isinstance(result, tuple):
            status_code, payload = result
            return _response(status_code, payload)
        return result
    except BrokerError as exc:
        return _response(exc.status_code, exc.to_payload())


@router.post("/readiness")
def readiness(request: ReadinessRequest):
    broker = get_gpu_hmr_broker()
    return _handle(lambda: broker.readiness(request.payload()))


@router.post("/projections")
def create_projection(request: ProjectionRequest):
    broker = get_gpu_hmr_broker()
    return _handle(lambda: broker.create_projection(request.payload()))


@router.get("/projections/{projection_hash}")
def get_projection(projection_hash: str):
    broker = get_gpu_hmr_broker()
    return _handle(lambda: broker.get_projection(projection_hash))


@router.post("/prepare-candidate")
def prepare_candidate(request: PrepareCandidateRequest):
    broker = get_gpu_hmr_broker()
    return _handle(lambda: broker.prepare_candidate(request.payload()))


@router.get("/candidates")
def list_candidates(selectedTargetIdentityHash: Optional[str] = None):
    broker = get_gpu_hmr_broker()
    return _handle(lambda: broker.list_candidates(selectedTargetIdentityHash))


@router.get("/candidates/{candidate_id}")
def get_candidate(candidate_id: str):
    broker = get_gpu_hmr_broker()
    return _handle(lambda: broker.get_candidate(candidate_id))


@router.get("/candidates/{candidate_id}/trace")
def get_candidate_trace(candidate_id: str):
    broker = get_gpu_hmr_broker()
    return _handle(lambda: broker.get_candidate_trace(candidate_id))


@router.post("/candidates/{candidate_id}/verify")
def verify_candidate(candidate_id: str, request: VerifyCandidateRequest):
    broker = get_gpu_hmr_broker()
    return _handle(lambda: broker.verify_candidate(candidate_id, request.payload()))


@router.post("/candidates/{candidate_id}/promote")
def promote_candidate(candidate_id: str, request: PromoteCandidateRequest):
    broker = get_gpu_hmr_broker()
    return _handle(lambda: broker.promote_candidate(candidate_id, request.payload()))


@router.post("/candidates/{candidate_id}/cancel")
def cancel_candidate(candidate_id: str, request: IdempotentRequest):
    broker = get_gpu_hmr_broker()
    return _handle(lambda: broker.cancel_candidate(candidate_id, request.payload()))


@router.post("/candidates/{candidate_id}/diagnose")
def diagnose_candidate(candidate_id: str, request: IdempotentRequest):
    broker = get_gpu_hmr_broker()
    return _handle(lambda: broker.diagnose_candidate(candidate_id, request.payload()))


@router.get("/jobs/{job_id}")
def get_job(job_id: str):
    broker = get_gpu_hmr_broker()
    return _handle(lambda: broker.get_job(job_id))


@router.get("/jobs/{job_id}/trace")
def get_job_trace(job_id: str):
    broker = get_gpu_hmr_broker()
    return _handle(lambda: broker.get_job_trace(job_id))


@router.post("/jobs/{job_id}/cancel")
def cancel_job(job_id: str, request: IdempotentRequest):
    broker = get_gpu_hmr_broker()
    return _handle(lambda: broker.cancel_job(job_id, request.payload()))


@router.get("/accepted/current")
def accepted_current():
    broker = get_gpu_hmr_broker()
    return _handle(lambda: broker.get_accepted_current())

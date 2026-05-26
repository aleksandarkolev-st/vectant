"""GPU HMR split-broker identity and manifest contracts.

These models are intentionally narrow: they give Milestone 1 producers one
place to construct hashable identity material without coupling the first patch
to API routing, AI generation, or verifier execution.
"""

from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional

try:
    from pydantic import BaseModel, ConfigDict, Field

    _PYDANTIC_V2 = True
except ImportError:  # pragma: no cover - compatibility for older local envs
    from pydantic import BaseModel, Field  # type: ignore

    ConfigDict = None  # type: ignore
    _PYDANTIC_V2 = False

from gpu_hmr.canonical import GPU_HMR_IDENTITY_POLICY, canonical_hash


SELECTED_TARGET_IDENTITY_SCHEMA_VERSION = "gpu-hmr-selected-target-identity-v1"
SOURCE_SPLIT_IDENTITY_SCHEMA_VERSION = "gpu-hmr-source-split-identity-v1"
COMPILE_CANDIDATE_IDENTITY_SCHEMA_VERSION = "gpu-hmr-compile-candidate-identity-v1"
RUNTIME_VERIFICATION_IDENTITY_SCHEMA_VERSION = "gpu-hmr-runtime-verification-identity-v1"
AI_GENERATION_IDENTITY_SCHEMA_VERSION = "gpu-hmr-ai-generation-identity-v1"
PROMOTION_IDENTITY_SCHEMA_VERSION = "gpu-hmr-promotion-identity-v1"
ROLE_SCOPE_PACKAGE_SCHEMA_VERSION = "gpu-hmr-role-scope-package-v1"
ROLE_GENERATION_PACKAGE_SCHEMA_VERSION = "gpu-hmr-role-generation-package-v1"
SOURCE_TO_GENERATED_MAPPING_SCHEMA_VERSION = "gpu-hmr-source-to-generated-mapping-v1"
CANDIDATE_SPEC_MANIFEST_SCHEMA_VERSION = "gpu-hmr-candidate-spec-manifest-v1"
CANDIDATE_VERIFICATION_RECORD_SCHEMA_VERSION = "gpu-hmr-candidate-verification-record-v1"
VERIFIER_REPORT_SCHEMA_VERSION = "gpu-hmr-verifier-report-v1"
ACCEPTED_PROMOTION_RECORD_SCHEMA_VERSION = "gpu-hmr-accepted-promotion-record-v1"
ACCEPTED_POINTER_SCHEMA_VERSION = "gpu-hmr-accepted-pointer-v1"

CandidateState = Literal[
    "prepared_candidate",
    "generated_candidate",
    "schema_verified_candidate",
    "compile_verified_candidate",
    "runtime_verified_candidate",
    "promotion_ready_candidate",
    "active_promoted_candidate",
    "rejected_candidate",
    "stale_candidate",
    "cancelled_candidate",
]

VerifierStatus = Literal[
    "pass",
    "fail",
    "warning",
    "not_required",
    "skipped_blocked_by_prior_failure",
]


class _StrictModel(BaseModel):
    if _PYDANTIC_V2:
        model_config = ConfigDict(extra="forbid")
    else:

        class Config:
            extra = "forbid"

    def contract_dict(self) -> Dict[str, Any]:
        if _PYDANTIC_V2:
            return self.model_dump(exclude_none=False)
        return self.dict(exclude_none=False)  # type: ignore[attr-defined]

    def contract_hash(self) -> str:
        return canonical_hash(self.contract_dict(), policy=GPU_HMR_IDENTITY_POLICY)


class SelectedTargetIdentity(_StrictModel):
    schemaVersion: str = SELECTED_TARGET_IDENTITY_SCHEMA_VERSION
    buildSystem: str
    buildRoot: str
    buildConfiguration: Optional[str] = None
    targetName: str
    targetType: str
    compilerPath: str
    compilerId: str
    compilerVersion: Optional[str] = None
    languageStandards: List[str] = Field(default_factory=list)
    defines: List[str] = Field(default_factory=list)
    undefines: List[str] = Field(default_factory=list)
    includeRoots: List[str] = Field(default_factory=list)
    systemIncludeRoots: List[str] = Field(default_factory=list)
    generatedHeaderRoots: List[str] = Field(default_factory=list)
    sourceFiles: List[str] = Field(default_factory=list)
    linkLibraries: List[str] = Field(default_factory=list)
    linkDirectories: List[str] = Field(default_factory=list)
    runtimeLibraryPaths: List[str] = Field(default_factory=list)
    gpuVendor: Optional[str] = None
    gpuArch: Optional[str] = None
    rdcMode: Optional[str] = None
    deviceLinkMode: Optional[str] = None
    workerRuntimeToolchainIdentityHash: Optional[str] = None


class SourceSplitIdentity(_StrictModel):
    schemaVersion: str = SOURCE_SPLIT_IDENTITY_SCHEMA_VERSION
    workspaceRootDigest: str
    gitCommit: Optional[str] = None
    dirtyTreeHash: str
    targetInputFileHash: str
    buildConfigInputHash: str
    generatedHeaderContentHash: str
    buildSelectionEnvironmentHash: str
    selectedTargetIdentityHash: str
    codeIntelGeneration: str
    splitSchemaVersion: str
    promptSchemaVersion: str


class CompileCandidateIdentity(_StrictModel):
    schemaVersion: str = COMPILE_CANDIDATE_IDENTITY_SCHEMA_VERSION
    sourceSplitIdentityHash: str
    selectedTargetIdentityHash: str
    targetCompileMetadataHash: str
    toolchainProbeHash: str
    compilerToolchainIdentityHash: str
    gpuExecutionProfileHash: str
    buildWorkerEnvironmentHash: str
    generatedArtifactHash: str


class RuntimeVerificationIdentity(_StrictModel):
    schemaVersion: str = RUNTIME_VERIFICATION_IDENTITY_SCHEMA_VERSION
    compileCandidateIdentityHash: str
    runtimeVerificationEnvironmentHash: str
    verificationRuntimeEnvironmentHash: str
    deploymentRuntimeEnvironmentHash: str
    gpuRuntimeDriverHash: str
    graphicsOwnershipState: str
    displayBackend: str


class AiGenerationIdentity(_StrictModel):
    schemaVersion: str = AI_GENERATION_IDENTITY_SCHEMA_VERSION
    roleGenerationPackageHash: str
    modelProfileHash: str
    modelName: str
    temperaturePolicy: str
    promptHash: str
    promptSchemaVersion: str
    retrievalTraceHash: str
    retrievalProfileHash: str
    queryHash: str
    rankerVersion: str
    rrfMmrSettingsHash: str
    contextBudgetHash: str
    citationFilterHash: str
    hydeQueryRewriteSettingHash: str
    topKAndCandidateBudgetHash: str


class PromotionIdentity(_StrictModel):
    schemaVersion: str = PROMOTION_IDENTITY_SCHEMA_VERSION
    candidateId: str
    candidateSpecManifestHash: str
    candidateVerificationRecordHash: str
    requiredVerifierReportSetHash: str
    sourceSplitIdentityHash: str
    compileCandidateIdentityHash: str
    runtimeVerificationIdentityHash: str
    promotionVerifierReportHash: str


class SourceRef(_StrictModel):
    path: str
    spanHash: Optional[str] = None
    reason: str


class RoleScopePackage(_StrictModel):
    schemaVersion: str = ROLE_SCOPE_PACKAGE_SCHEMA_VERSION
    sourceSplitIdentityHash: str
    selectedTargetIdentityHash: str
    role: str
    readableSourceRefs: List[SourceRef] = Field(default_factory=list)
    writableGeneratedPaths: List[str] = Field(default_factory=list)
    dependencyPolicy: Dict[str, Any] = Field(default_factory=dict)
    retrievalProfiles: List[str] = Field(default_factory=list)
    reasonCodes: List[str] = Field(default_factory=list)


class RoleGenerationPackage(_StrictModel):
    schemaVersion: str = ROLE_GENERATION_PACKAGE_SCHEMA_VERSION
    roleScopePackageHash: str
    role: str
    promptSchemaVersion: str
    retrievalIdentityHash: str
    contextRefs: List[Dict[str, Any]] = Field(default_factory=list)
    writeScope: List[str] = Field(default_factory=list)
    modelPolicy: Dict[str, Any] = Field(default_factory=dict)


class GeneratedRoleRef(_StrictModel):
    role: str
    path: str
    contentHash: Optional[str] = None
    internal: bool = True


class SourceToGeneratedMapping(_StrictModel):
    schemaVersion: str = SOURCE_TO_GENERATED_MAPPING_SCHEMA_VERSION
    mappingKind: str
    sourcePath: str
    sourceSymbol: str
    generatedRole: str
    generatedPath: str
    sourceSpanHash: str
    generatedSpanHash: str
    signatureHash: Optional[str] = None
    layoutHash: Optional[str] = None
    reasonCodes: List[str] = Field(default_factory=list)


class CandidateSpecManifest(_StrictModel):
    schemaVersion: str = CANDIDATE_SPEC_MANIFEST_SCHEMA_VERSION
    sourceSplitIdentityHash: str
    selectedTargetIdentityHash: str
    projectionHash: str
    roleGenerationPackageHashes: List[str]
    generatedArtifactHash: str
    generatedRoles: Dict[str, GeneratedRoleRef]
    sourceToGeneratedMappingHash: str

    def candidate_id(self) -> str:
        return canonical_hash(
            {
                "schemaVersion": "gpu-hmr-candidate-id-v1",
                "sourceSplitIdentityHash": self.sourceSplitIdentityHash,
                "roleGenerationPackageHashes": self.roleGenerationPackageHashes,
                "generatedArtifactHash": self.generatedArtifactHash,
            },
            policy=GPU_HMR_IDENTITY_POLICY,
        )


class VerifierReport(_StrictModel):
    schemaVersion: str = VERIFIER_REPORT_SCHEMA_VERSION
    verifierName: str
    candidateId: str
    candidateSpecManifestHash: str
    inputIdentitySnapshot: Dict[str, Any]
    status: VerifierStatus
    blocking: bool = True
    reasonCodes: List[str] = Field(default_factory=list)
    proofRefs: List[Dict[str, Any]] = Field(default_factory=list)
    createdAt: Optional[str] = None
    toolVersion: Optional[str] = None


class CandidateVerificationRecord(_StrictModel):
    schemaVersion: str = CANDIDATE_VERIFICATION_RECORD_SCHEMA_VERSION
    candidateId: str
    candidateSpecManifestHash: str
    state: CandidateState
    verifierReportHashes: List[str] = Field(default_factory=list)
    transitionHistory: List[Dict[str, Any]] = Field(default_factory=list)


class AcceptedPromotionRecord(_StrictModel):
    schemaVersion: str = ACCEPTED_PROMOTION_RECORD_SCHEMA_VERSION
    candidateId: str
    candidateSpecManifestHash: str
    candidateVerificationRecordHash: str
    promotionIdentityHash: str
    requiredVerifierReportHashes: List[str] = Field(default_factory=list)
    promotedAt: Optional[str] = None


class AcceptedPointer(_StrictModel):
    schemaVersion: str = ACCEPTED_POINTER_SCHEMA_VERSION
    acceptedPromotionRecordHash: str
    candidateId: str
    candidateSpecManifestHash: str
    selectedTargetIdentityHash: str
    candidatePath: str
    promotedAt: Optional[str] = None

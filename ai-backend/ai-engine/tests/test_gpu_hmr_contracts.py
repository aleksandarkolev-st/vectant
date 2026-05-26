import pytest
from pydantic import ValidationError

from gpu_hmr.canonical import CanonicalizationError, GPU_HMR_IDENTITY_POLICY, canonicalize
from gpu_hmr.contracts import (
    AcceptedPointer,
    CandidateSpecManifest,
    CandidateVerificationRecord,
    SelectedTargetIdentity,
    SourceSplitIdentity,
)


def copy_model(model, update):
    if hasattr(model, "model_copy"):
        return model.model_copy(update=update)
    return model.copy(update=update)


def test_selected_target_identity_hash_is_order_stable_for_unordered_source_sets():
    target = SelectedTargetIdentity(
        buildSystem="cmake",
        buildRoot="build/debug",
        buildConfiguration="Debug",
        targetName="flow",
        targetType="EXECUTABLE",
        compilerPath="toolchains/hipcc",
        compilerId="hipcc",
        compilerVersion="6.4",
        languageStandards=["c++20"],
        sourceFiles=[".\\src\\gpu\\flow.hip", "src/app/main.cpp"],
        includeRoots=["include", "./src/../src"],
        gpuVendor="rocm",
        gpuArch="gfx1201",
        rdcMode="off",
        deviceLinkMode="single_tu",
    )
    same_target = copy_model(
        target,
        update={
            "sourceFiles": ["src/app/main.cpp", "src/gpu/flow.hip"],
        },
    )

    assert target.contract_hash() == same_target.contract_hash()
    assert canonicalize(
        target.contract_dict(),
        policy=GPU_HMR_IDENTITY_POLICY,
    )["includeRoots"] == ["include", "src"]


def test_source_split_identity_hash_changes_with_codeintel_generation():
    identity = SourceSplitIdentity(
        workspaceRootDigest="root",
        gitCommit="abc",
        dirtyTreeHash="clean",
        targetInputFileHash="target-input",
        buildConfigInputHash="build-config",
        generatedHeaderContentHash="headers",
        buildSelectionEnvironmentHash="env",
        selectedTargetIdentityHash="target",
        codeIntelGeneration="42",
        splitSchemaVersion="split-v1",
        promptSchemaVersion="prompt-v1",
    )
    stale = copy_model(identity, update={"codeIntelGeneration": "43"})

    assert identity.contract_hash() != stale.contract_hash()


def test_candidate_id_is_deterministic_for_role_package_set_order():
    first = CandidateSpecManifest(
        sourceSplitIdentityHash="source",
        selectedTargetIdentityHash="target",
        projectionHash="projection",
        roleGenerationPackageHashes=["role-b", "role-a"],
        generatedArtifactHash="artifact",
        generatedRoles={
            "device": {
                "role": "device",
                "path": ".synthi\\gpu_hmr\\candidates\\c1\\device.hip",
            },
            "shared": {
                "role": "shared",
                "path": ".synthi/gpu_hmr/candidates/c1/shared.h",
            },
        },
        sourceToGeneratedMappingHash="mapping",
    )
    second = copy_model(first, update={"roleGenerationPackageHashes": ["role-a", "role-b"]})

    assert first.candidate_id() == second.candidate_id()
    assert first.contract_hash() == second.contract_hash()
    assert canonicalize(
        first.contract_dict(),
        policy=GPU_HMR_IDENTITY_POLICY,
    )["generatedRoles"]["device"]["path"] == ".synthi/gpu_hmr/candidates/c1/device.hip"


def test_candidate_spec_hash_is_separate_from_verification_state():
    spec = CandidateSpecManifest(
        sourceSplitIdentityHash="source",
        selectedTargetIdentityHash="target",
        projectionHash="projection",
        roleGenerationPackageHashes=["role-a"],
        generatedArtifactHash="artifact",
        generatedRoles={
            "device": {
                "role": "device",
                "path": ".synthi/gpu_hmr/candidates/c1/device.hip",
            }
        },
        sourceToGeneratedMappingHash="mapping",
    )
    before = CandidateVerificationRecord(
        candidateId=spec.candidate_id(),
        candidateSpecManifestHash=spec.contract_hash(),
        state="generated_candidate",
        verifierReportHashes=[],
    )
    after = copy_model(
        before,
        update={
            "state": "compile_verified_candidate",
            "verifierReportHashes": ["compile-report"],
        },
    )

    assert before.candidateSpecManifestHash == spec.contract_hash()
    assert before.contract_hash() != after.contract_hash()
    assert before.candidateSpecManifestHash == after.candidateSpecManifestHash


def test_pointer_paths_are_rejected_when_they_escape_workspace():
    with pytest.raises(ValidationError):
        CandidateSpecManifest(
            sourceSplitIdentityHash="source",
            selectedTargetIdentityHash="target",
            projectionHash="projection",
            roleGenerationPackageHashes=["role-a"],
            generatedArtifactHash="artifact",
            generatedRoles={},
            sourceToGeneratedMappingHash="mapping",
            unexpected="field",
        )

    with pytest.raises(CanonicalizationError):
        AcceptedPointer(
            acceptedPromotionRecordHash="promotion",
            candidateId="candidate",
            candidateSpecManifestHash="spec",
            selectedTargetIdentityHash="target",
            candidatePath="../candidate",
        ).contract_hash()

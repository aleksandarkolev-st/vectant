import pytest

from gpu_hmr.reason_codes import (
    REASON_CODE_REGISTRY_SCHEMA_VERSION,
    UnknownReasonCodeError,
    assert_registered_reason_codes,
    get_reason_code,
    load_reason_code_registry,
    unknown_reason_codes,
)


def test_reason_code_registry_loads_required_metadata():
    registry = load_reason_code_registry()
    by_code = registry.by_code()

    assert registry.schemaVersion == REASON_CODE_REGISTRY_SCHEMA_VERSION
    assert "target_resolution_ambiguous" in by_code
    assert "abi.kernel_signature_changed" in by_code
    assert "ai_provider_rate_limited" in by_code
    assert "ai_provider_unavailable" in by_code
    assert "projection_not_found" in by_code
    assert "candidate.spec_manifest_missing" in by_code
    assert "verifier.proof_unavailable" in by_code
    assert "generated.path_traversal_rejected" in by_code
    assert "target.cmake_file_api_selected" in by_code
    assert "target.compile_commands_only" in by_code
    assert "target_config_invalid" in by_code
    assert "cmake_targets_missing" in by_code
    assert "fission.candidate_accepted" in by_code
    assert "fission.output_oracle_missing" in by_code
    assert "fission.original_host_attachment_instrumentation_missing" in by_code
    assert "fission.ai_proposal_deterministic_promotion_missing" in by_code
    assert by_code["toolchain_capability_missing"].blocking is True
    assert by_code["cmake_file_api_missing"].blocking is False
    assert by_code["abi.kernel_signature_changed"].safeFallbackMode == "abi_breaking"
    assert by_code["fission.candidate_accepted"].blocking is False
    assert by_code["fission.output_oracle_missing"].owner == "fission_verifier"


def test_reason_code_lookup_and_unknown_detection():
    assert get_reason_code("screenshot_not_ready").owner == "runtime_verifier"
    assert unknown_reason_codes(["screenshot_not_ready", "not_registered"]) == ["not_registered"]

    with pytest.raises(UnknownReasonCodeError) as err:
        assert_registered_reason_codes(["not_registered", "target_resolution_ambiguous"])

    assert err.value.unknown_codes == ["not_registered"]


def test_fission_verifier_reason_codes_are_registered():
    codes = [
        "fission.candidate_missing",
        "fission.candidate_accepted",
        "fission.candidate_verified",
        "fission.no_accepted_candidate",
        "fission.candidate_not_object",
        "fission.islandId_missing",
        "fission.sourceEditId_missing",
        "fission.artifactKind_missing",
        "fission.artifactKind_invalid",
        "fission.dependencyClosureHash_missing",
        "fission.dependencyClosureHash_invalid",
        "fission.abiMembraneId_missing",
        "fission.compileRecipeHash_missing",
        "fission.compileRecipeHash_invalid",
        "fission.compileCommandHash_missing",
        "fission.compileCommandHash_invalid",
        "fission.replacementScope_invalid",
        "fission.artifactScope_invalid",
        "fission.scope_invalid",
        "fission.replacement_scope_narrows_artifact_kind",
        "fission.sourcePaths_missing",
        "fission.sourceSpans_missing",
        "fission.targetSymbols_missing",
        "fission.exportedSymbolsExpected_missing",
        "fission.verifierEvidenceIds_missing",
        "fission.source_path_invalid",
        "fission.generated_role_path_missing",
        "fission.generated_role_path_invalid",
        "fission.deterministic_verifier_evidence_missing",
        "fission.source_mapping_evidence_missing",
        "fission.include_closure_evidence_missing",
        "fission.symbol_ownership_evidence_missing",
        "fission.dependency_closure_evidence_missing",
        "fission.abi_membrane_evidence_missing",
        "fission.abi_membrane_unverified",
        "fission.compile_recipe_evidence_missing",
        "fission.loader_capability_evidence_missing",
        "fission.output_oracle_evidence_missing",
        "fission.source_span_invalid",
        "fission.source_span_path_unmapped",
        "fission.includeClosure_missing",
        "fission.includeClosure_invalid",
        "fission.loader_capability_requirement_missing",
        "fission.loader_capability_requirement_invalid",
        "fission.output_oracle_missing",
        "fission.output_oracle_invalid",
        "fission.target_symbol_not_exported",
        "fission.safe_export_superset_unverified",
        "fission.narrower_candidate_rejections_incomplete",
        "fission.original_host_launch_mapping_missing",
        "fission.original_host_launch_mapping_evidence_missing",
        "fission.original_host_attachment_instrumentation_missing",
        "fission.stream_ordering_evidence_missing",
        "fission.epoch_retirement_unavailable",
        "fission.ai_proposal_id_missing",
        "fission.ai_proposal_deterministic_promotion_missing",
        "fission.edit_crosses_body_boundary",
        "fission.include_closure_unknown",
        "fission.symbol_ownership_ambiguous",
        "fission.narrower_scope_not_materialized_by_runtime_artifact_selection",
    ]

    assert_registered_reason_codes(codes)
    assert get_reason_code("fission.candidate_verified").blocking is False
    assert get_reason_code("fission.stream_ordering_evidence_missing").blocking is True
    assert (
        get_reason_code("fission.narrower_scope_not_materialized_by_runtime_artifact_selection").safeFallbackMode
        == "wider_fission_scope"
    )

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
    assert by_code["toolchain_capability_missing"].blocking is True
    assert by_code["cmake_file_api_missing"].blocking is False
    assert by_code["abi.kernel_signature_changed"].safeFallbackMode == "abi_breaking"


def test_reason_code_lookup_and_unknown_detection():
    assert get_reason_code("screenshot_not_ready").owner == "runtime_verifier"
    assert unknown_reason_codes(["screenshot_not_ready", "not_registered"]) == ["not_registered"]

    with pytest.raises(UnknownReasonCodeError) as err:
        assert_registered_reason_codes(["not_registered", "target_resolution_ambiguous"])

    assert err.value.unknown_codes == ["not_registered"]

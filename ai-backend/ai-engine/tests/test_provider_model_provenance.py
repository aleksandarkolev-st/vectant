from llm.providers.base import provider_model_provenance


def test_provider_model_provenance_records_required_unknown_status_fields():
    metadata = provider_model_provenance(
        provider="generic_llm_provider",
        requested_model="generic-model",
        actual_model="generic-model",
        mode="delta",
        request_mode="gpu_delta",
        latency_ms=12.5,
    )

    assert metadata["provider"] == "generic_llm_provider"
    assert metadata["requested_model"] == "generic-model"
    assert metadata["actual_model"] == "generic-model"
    assert metadata["provider_model_status"] == "unknown"
    assert metadata["provider_model_alias_resolved_to"] is None
    assert metadata["provider_shutdown_or_deprecation_detected"] is False
    assert metadata["model_availability_checked_at"]
    assert metadata["model_availability_source"] == "provider_not_checked"
    assert metadata["model_availability_check_time_ms"] == 0.0
    assert metadata["fallback_model"] is None
    assert metadata["fallback_used"] is False
    assert metadata["request_mode"] == "gpu_delta"
    assert metadata["hard_infra_failure"] is False
    assert metadata["latency_ms"] == 12.5


def test_provider_model_provenance_defaults_request_mode_from_delta_mode():
    metadata = provider_model_provenance(
        provider="generic_llm_provider",
        requested_model="generic-model",
        mode="delta",
    )

    assert metadata["request_mode"] == "delta"

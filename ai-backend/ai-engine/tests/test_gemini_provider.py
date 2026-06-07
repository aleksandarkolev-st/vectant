"""Unit tests for Gemini provider model fallback selection."""

from types import SimpleNamespace

from llm.providers.gemini import (
    _MODEL_LIST_CACHE,
    genai,
    _normalize_model_name,
    _provider_model_status,
    _request_mode_name,
    _select_fallback_model_name,
)


def test_select_fallback_model_prefers_generate_content_family_match():
    models = [
        SimpleNamespace(
            name="models/text-embedding-004",
            supported_generation_methods=["embedContent"],
        ),
        SimpleNamespace(
            name="models/gemini-3.4-pro",
            supported_generation_methods=["generateContent"],
        ),
        SimpleNamespace(
            name="models/gemini-3.5-flash",
            supported_generation_methods=["generateContent"],
        ),
    ]

    selected = _select_fallback_model_name(
        "models/gemini-3.1-flash-lite-preview",
        models,
    )

    assert selected == "gemini-3.5-flash"


def test_select_fallback_model_skips_requested_alias():
    models = [
        SimpleNamespace(
            name="models/gemini-3.1-flash-lite-preview",
            supported_generation_methods=["generateContent"],
        ),
        SimpleNamespace(
            name="models/gemini-3.2-flash",
            supported_generation_methods=["generateContent"],
        ),
    ]

    selected = _select_fallback_model_name(
        "gemini-3.1-flash-lite-preview",
        models,
    )

    assert selected == "gemini-3.2-flash"


def test_normalize_model_name_accepts_api_names():
    assert _normalize_model_name("models/gemini-example") == "gemini-example"


def test_provider_model_status_rejects_shutdown_preview():
    status = _provider_model_status("gemini-3.1-flash-lite-preview")

    assert status["provider_model_status"] == "shutdown"
    assert status["provider_shutdown_date"] == "2026-05-25"
    assert status["provider_recommended_replacement"] == "gemini-3.1-flash-lite"
    assert status["provider_shutdown_or_deprecation_detected"] is True
    assert status["model_availability_checked_at"]


def test_provider_model_status_respects_private_alias(monkeypatch):
    monkeypatch.setenv(
        "SYNTHI_GEMINI_PRIVATE_MODEL_ALIASES",
        "gemini-3.1-flash-lite-preview=private-gemini-delta",
    )

    status = _provider_model_status("models/gemini-3.1-flash-lite-preview")

    assert status["provider_model_status"] == "private_alias"
    assert status["provider_model_alias_resolved_to"] == "private-gemini-delta"
    assert status["provider_shutdown_or_deprecation_detected"] is True


def test_provider_model_status_live_check_marks_unknown_available(monkeypatch):
    _MODEL_LIST_CACHE.clear()
    monkeypatch.setattr(genai, "configure", lambda api_key: None)
    monkeypatch.setattr(
        genai,
        "list_models",
        lambda: [
            SimpleNamespace(
                name="models/private-gemini-fast",
                supported_generation_methods=["generateContent"],
            )
        ],
    )

    status = _provider_model_status("private-gemini-fast", api_key="test-key", live_check=True)

    assert status["provider_model_status"] == "available"
    assert status["provider_live_model_list_checked"] is True
    assert status["provider_live_model_list_has_requested"] is True
    assert status["provider_live_model_list_error"] is None
    assert status["model_availability_check_time_ms"] >= 0


def test_provider_model_status_live_check_can_prove_shutdown_model_present(monkeypatch):
    _MODEL_LIST_CACHE.clear()
    monkeypatch.setattr(genai, "configure", lambda api_key: None)
    monkeypatch.setattr(
        genai,
        "list_models",
        lambda: [
            SimpleNamespace(
                name="models/gemini-3.1-flash-lite-preview",
                supported_generation_methods=["generateContent"],
            )
        ],
    )

    status = _provider_model_status(
        "gemini-3.1-flash-lite-preview",
        api_key="test-key-live-preview",
        live_check=True,
    )

    assert status["provider_model_status"] == "private_alias"
    assert status["provider_model_alias_resolved_to"] == "gemini-3.1-flash-lite-preview"
    assert status["provider_live_model_list_checked"] is True
    assert status["provider_live_model_list_has_requested"] is True
    assert status["provider_live_model_list_overrode_registry"] is True
    assert status["provider_shutdown_or_deprecation_detected"] is True


def test_provider_model_status_live_check_records_missing_key(monkeypatch):
    _MODEL_LIST_CACHE.clear()
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)

    status = _provider_model_status("private-gemini-fast", live_check=True)

    assert status["provider_model_status"] == "unknown"
    assert status["provider_live_model_list_checked"] is False
    assert status["provider_live_model_list_has_requested"] is None
    assert status["provider_live_model_list_error"] == "missing_api_key"


def test_delta_mode_does_not_default_to_gpu_delta():
    assert _request_mode_name("delta", None) == "delta"
    assert _request_mode_name("delta", "gpu_delta") == "gpu_delta"

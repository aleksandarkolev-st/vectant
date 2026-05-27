"""Unit tests for Gemini provider model fallback selection."""

from types import SimpleNamespace

from llm.providers.gemini import (
    _normalize_model_name,
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

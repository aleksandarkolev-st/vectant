import pytest

from llm.providers.factory import get_provider
from llm.providers.gemini import GeminiProvider


def test_chatgpt_provider_name_routes_to_openai(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-local-only")
    provider = get_provider("chatgpt")
    assert type(provider).__name__ == "OpenAIProvider"


def test_unknown_provider_falls_back_to_gemini():
    provider = get_provider("totally-unknown")
    assert isinstance(provider, GeminiProvider)


def test_gemini_refuses_openai_format_keys():
    provider = GeminiProvider()
    with pytest.raises(
        ValueError,
        match="Refusing to send an OpenAI-format key to the Gemini provider",
    ):
        provider._get_client("sk-test123", "gemini-1.5-flash")

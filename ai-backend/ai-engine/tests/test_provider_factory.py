import pytest

from llm.providers import factory
from llm.providers.factory import ProviderSelectionError, get_provider
from llm.providers.gemini import GeminiProvider


def test_default_provider_remains_gemini():
    assert isinstance(get_provider(), GeminiProvider)


def test_non_strict_unknown_provider_retains_historical_fallback():
    assert isinstance(get_provider("not-registered"), GeminiProvider)


def test_exact_unknown_provider_fails_closed():
    with pytest.raises(ProviderSelectionError, match="unknown provider"):
        get_provider("not-registered", require_exact=True)


def test_exact_unavailable_provider_fails_closed(monkeypatch):
    def unavailable():
        raise ImportError("optional SDK missing")

    monkeypatch.setitem(factory._PROVIDER_LOADERS, "test-unavailable", unavailable)

    with pytest.raises(ProviderSelectionError, match="optional SDK missing"):
        get_provider("test-unavailable", require_exact=True)


def test_non_strict_unavailable_provider_falls_back(monkeypatch):
    def unavailable():
        raise ImportError("optional SDK missing")

    monkeypatch.setitem(factory._PROVIDER_LOADERS, "test-unavailable", unavailable)

    assert isinstance(get_provider("test-unavailable"), GeminiProvider)

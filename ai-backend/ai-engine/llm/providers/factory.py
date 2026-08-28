"""Provider factory with optional fail-closed selection.

Ordinary analysis callers retain the historical Gemini fallback. Evidence
paths that must prove a real provider call can request exact selection so an
unknown provider or missing optional SDK cannot be silently relabeled as a
Gemini call.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Optional

from .base import AiProvider
from .gemini import GeminiProvider

logger = logging.getLogger("llm.providers.factory")


class ProviderSelectionError(RuntimeError):
    """Raised when an exact provider request cannot be honored."""


def _load_gemini() -> AiProvider:
    return GeminiProvider()


def _load_anthropic() -> AiProvider:
    from .anthropic_provider import AnthropicProvider

    return AnthropicProvider()


def _load_openai() -> AiProvider:
    from .openai_provider import OpenAIProvider

    return OpenAIProvider()


def _load_chatgpt() -> AiProvider:
    from .chatgpt import ChatGPTProvider

    return ChatGPTProvider()


_PROVIDER_LOADERS: dict[str, Callable[[], AiProvider]] = {
    "anthropic": _load_anthropic,
    "chatgpt": _load_chatgpt,
    "gemini": _load_gemini,
    "openai": _load_openai,
}


def get_provider(
    provider_name: Optional[str] = None,
    use_custom: bool = False,
    *,
    require_exact: bool = False,
) -> AiProvider:
    """Return the requested provider.

    ``None`` keeps the historical Gemini default. With ``require_exact``, an
    explicit unknown provider or an unavailable provider implementation raises
    ``ProviderSelectionError`` instead of substituting Gemini. ``use_custom``
    remains part of the public signature because API-key handling happens in
    provider implementations.
    """
    del use_custom

    name = (provider_name or "gemini").lower().strip()
    loader = _PROVIDER_LOADERS.get(name)

    if loader is None:
        message = f"unknown provider {provider_name!r}"
        if require_exact:
            raise ProviderSelectionError(message)

        logger.warning("%s; falling back to gemini", message)
        return GeminiProvider()

    try:
        return loader()
    except ImportError as exc:
        message = f"provider {name!r} is unavailable: {exc}"
        if require_exact:
            raise ProviderSelectionError(message) from exc

        logger.warning("%s; falling back to gemini", message)
        return GeminiProvider()
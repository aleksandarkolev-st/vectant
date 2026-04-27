"""Provider factory.

Wave 1 of the chat path is Gemini-only. The Synthi Genome shadow pipeline
(Wave 2 cross-validation) needs Anthropic + OpenAI alongside Gemini, so
the factory grew a `provider_name` dispatch with graceful fallback when
optional SDKs aren't installed.

Callers that don't care about cross-validation keep the old behaviour by
calling `get_provider()` with no arguments — they get the GeminiProvider.
"""

from __future__ import annotations

import logging
from typing import Optional

from .base import AiProvider
from .gemini import GeminiProvider

logger = logging.getLogger("llm.providers.factory")

_KNOWN = {"gemini", "anthropic", "openai"}


def get_provider(provider_name: Optional[str] = None, use_custom: bool = False) -> AiProvider:
    """Return a provider instance.

    `provider_name` accepts: 'gemini' | 'anthropic' | 'openai' | None.
    None falls through to Gemini (the historical default). If the
    requested provider's SDK isn't installed, we log a warning and
    fall back to Gemini so the calling code path doesn't crash.
    """
    name = (provider_name or "gemini").lower().strip()
    if name not in _KNOWN:
        logger.warning("unknown provider %r — falling back to gemini", provider_name)
        return GeminiProvider()
    if name == "gemini":
        return GeminiProvider()
    if name == "anthropic":
        try:
            from .anthropic_provider import AnthropicProvider
            return AnthropicProvider()
        except ImportError as e:
            logger.warning("anthropic provider unavailable (%s) — falling back to gemini", e)
            return GeminiProvider()
    if name == "openai":
        try:
            from .openai_provider import OpenAIProvider
            return OpenAIProvider()
        except ImportError as e:
            logger.warning("openai provider unavailable (%s) — falling back to gemini", e)
            return GeminiProvider()
    return GeminiProvider()

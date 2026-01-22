from .base import AiProvider
from .gemini import GeminiProvider


def get_provider(provider_name: str | None = None, use_custom: bool = False) -> AiProvider:
    """Return Gemini provider only (Gemini-only policy)."""
    return GeminiProvider()

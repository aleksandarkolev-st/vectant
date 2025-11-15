import os
from .base import AiProvider
from .gemini import GeminiProvider


def get_provider() -> AiProvider:
    provider_type = os.getenv("AI_PROVIDER", "gemini").lower()
    if provider_type == "gemini":
        return GeminiProvider()
    else:
        raise ValueError(f"Unknown provider: {provider_type}")
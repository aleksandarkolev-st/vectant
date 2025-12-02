import os
from .base import AiProvider
from .gemini import GeminiProvider
from .chatgpt import ChatGPTProvider


def get_provider(provider_name: str | None = None, use_custom: bool = False) -> AiProvider:
    """
    Returns a provider instance. Priority:
    - explicit provider_name ('gemini' or 'chatgpt')
    - use_custom flag (chatgpt)
    - env var AI_PROVIDER (defaults to gemini)
    """
    if provider_name:
        name = provider_name.lower()
    elif use_custom:
        name = "chatgpt"
    else:
        name = os.getenv("AI_PROVIDER", "gemini").lower()

    if name == "gemini":
        return GeminiProvider()
    if name == "chatgpt":
        return ChatGPTProvider()
    raise ValueError(f"Unknown provider: {name}")

"""OpenAI provider — used by the Wave 2 multi-provider cross-validation.

Optional dependency: the `openai` SDK. If unavailable, attempting to
use this provider raises ImportError at construction time so the factory
can fall back to Gemini cleanly.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Mapping, Optional, Sequence

from .base import AiProvider

logger = logging.getLogger("llm.providers.openai")


class OpenAIProvider(AiProvider):
    name = "openai"
    DEFAULT_MODEL = "gpt-4o"

    def __init__(self) -> None:
        super().__init__(name="openai")
        try:
            import openai  # noqa: F401
        except ImportError as e:
            raise ImportError(
                "openai SDK not installed; add `openai` to requirements.txt"
            ) from e
        self.model_name = os.getenv("SYNTHI_OPENAI_MODEL", self.DEFAULT_MODEL)

    def _get_client(self, api_key: Optional[str] = None):
        from openai import AsyncOpenAI
        key = api_key or os.getenv("OPENAI_API_KEY")
        if not key:
            raise ValueError("OPENAI_API_KEY is not set and no api_key provided.")
        return AsyncOpenAI(api_key=key)

    async def ask_llm(
        self,
        code: str,
        lang: str,
        prompt: str = None,
        mode: str = None,
        files: Optional[Sequence[Mapping[str, Any]]] = None,
        focus: Optional[str] = None,
        model: Optional[str] = None,
        api_key: Optional[str] = None,
    ) -> str:
        client = self._get_client(api_key)
        target = model or self.model_name
        user_text = (prompt or "").strip()
        if code:
            fence = f"```{lang}\n{code}\n```"
            user_text = f"{user_text}\n\n{fence}" if user_text else fence

        resp = await client.chat.completions.create(
            model=target,
            temperature=0.2,
            max_tokens=8192,
            messages=[
                {"role": "system", "content": "You are a careful, concise coding assistant."},
                {"role": "user", "content": user_text},
            ],
        )
        choice = resp.choices[0] if getattr(resp, "choices", None) else None
        if not choice:
            return ""
        msg = getattr(choice, "message", None)
        return getattr(msg, "content", "") or ""

"""Anthropic provider — used by the Wave 2 multi-provider cross-validation.

Optional dependency: the `anthropic` SDK. If unavailable, attempting to
use this provider raises ImportError at construction time so the factory
can fall back to Gemini cleanly.
"""

from __future__ import annotations

import logging
import os
import time
from typing import Any, Mapping, Optional, Sequence

from .base import AiProvider, provider_model_provenance

logger = logging.getLogger("llm.providers.anthropic")


class AnthropicProvider(AiProvider):
    name = "anthropic"
    DEFAULT_MODEL = "claude-sonnet-4-6"

    def __init__(self) -> None:
        super().__init__(name="anthropic")
        try:
            import anthropic  # noqa: F401
        except ImportError as e:
            raise ImportError(
                "anthropic SDK not installed; add `anthropic` to requirements.txt"
            ) from e
        self.model_name = os.getenv("SYNTHI_ANTHROPIC_MODEL", self.DEFAULT_MODEL)

    def _get_client(self, api_key: Optional[str] = None):
        from anthropic import AsyncAnthropic
        key = api_key or os.getenv("ANTHROPIC_API_KEY")
        if not key:
            raise ValueError("ANTHROPIC_API_KEY is not set and no api_key provided.")
        return AsyncAnthropic(api_key=key)

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
        request_mode: Optional[str] = None,
    ) -> str:
        client = self._get_client(api_key)
        target = model or self.model_name
        mode_lower = mode.lower() if mode and isinstance(mode, str) else ""
        start_time = time.time()
        system = "You are a careful, concise coding assistant."
        user_text = (prompt or "").strip()
        if code:
            fence = f"```{lang}\n{code}\n```"
            user_text = f"{user_text}\n\n{fence}" if user_text else fence

        try:
            msg = await client.messages.create(
                model=target,
                max_tokens=8192,
                temperature=0.2,
                system=system,
                messages=[{"role": "user", "content": user_text}],
            )
            latency_ms = (time.time() - start_time) * 1000.0
            self.last_call_metadata = provider_model_provenance(
                provider=self.name,
                requested_model=target,
                actual_model=target,
                mode=mode_lower,
                request_mode=request_mode,
                latency_ms=latency_ms,
            )
            # Concatenate any text blocks in the response.
            parts = []
            for block in getattr(msg, "content", []) or []:
                text = getattr(block, "text", None)
                if text:
                    parts.append(text)
            return "".join(parts)
        except Exception as exc:
            self.last_call_metadata = provider_model_provenance(
                provider=self.name,
                requested_model=target,
                actual_model=None,
                mode=mode_lower,
                request_mode=request_mode,
                latency_ms=(time.time() - start_time) * 1000.0,
                error_type=type(exc).__name__,
            )
            raise

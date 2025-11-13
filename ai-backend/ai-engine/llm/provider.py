from __future__ import annotations

import os
from typing import Optional

from openai import OpenAI

from llm.prompts import build_prompt

_client: Optional[OpenAI] = None
_MODEL_NAME = os.getenv("SYNTHI_AI_MODEL", "gpt-4.1-mini")


def _get_client() -> OpenAI:
    global _client
    if _client is None:
        _client = OpenAI()
    return _client


def ask_llm(code: str, lang: str):
    if not os.getenv("OPENAI_API_KEY"):
        return "LLM disabled: set OPENAI_API_KEY to enable suggestions."

    prompt = build_prompt(code, lang)

    try:
        response = _get_client().chat.completions.create(
            model=_MODEL_NAME,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.2,
        )
        if not response.choices:
            return "LLM did not return any suggestions."

        message = response.choices[0].message
        if isinstance(message, dict):
            return message.get("content") or "No suggestion from LLM."
        return getattr(message, "content", None) or "No suggestion from LLM."
    except Exception as exc:
        return f"LLM error: {exc}"

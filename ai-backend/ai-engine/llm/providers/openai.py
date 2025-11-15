from ai_provider import AiProvider
from __future__ import annotations

import os
from typing import Optional

import google.generativeai as genai
from dotenv import load_dotenv

from llm.prompts import build_prompt
load_dotenv()

_MODEL_NAME = os.getenv("SYNTHI_GEMINI_MODEL", "gemini-2.5-flash-lite")

class GeminiProvider(AiProvider):
    _client: Optional[genai.GenerativeModel] = None

    def __init__(self):
        super().__init__(name="gemini_provider")

    def _get_client(self) -> genai.GenerativeModel:
        if self._client is None:
            api_key = os.getenv("GEMINI_API_KEY")
            if not api_key:
                raise ValueError("GEMINI_API_KEY is not set in environment variables.")

            genai.configure(api_key=api_key)
            self._client = genai.GenerativeModel(_MODEL_NAME)
        return self._client


    def ask_llm(self, code: str, lang: str) -> str:
        if not os.getenv("GEMINI_API_KEY"):
            return "LLM disabled: set GEMINI_API_KEY to enable suggestions."

        prompt = build_prompt(code, lang)

        try:
            model = self._get_client()
            response = model.generate_content(
                prompt,
                generation_config=genai.types.GenerationConfig(
                    temperature=0.2,
                    top_p=0.8,
                    top_k=40,
                    max_output_tokens=2048,
                ),
            )

            # Extract text from response
            if response.candidates:
                return response.text.strip()
            else:
                # Check for blocked/safety issues
                if response.prompt_feedback:
                    return f"LLM blocked response: {response.prompt_feedback}"
                return "LLM did not return any suggestions."

        except Exception as exc:
            return f"LLM error: {exc}"
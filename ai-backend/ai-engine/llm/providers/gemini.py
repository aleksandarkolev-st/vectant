import os
from typing import Optional
from .base import AiProvider

import google.generativeai as genai
from dotenv import load_dotenv

from llm.prompts import build_prompt

load_dotenv()  # Load once at import


class GeminiProvider(AiProvider):
    _client: Optional[genai.GenerativeModel] = None

    def __init__(self) -> None:
        super().__init__(name="gemini")
        self.model_name = os.getenv("SYNTHI_GEMINI_MODEL", "gemini-2.5-flash-lite")

    def _get_client(self) -> genai.GenerativeModel:
        if self._client is None:
            api_key = os.getenv("GEMINI_API_KEY")
            if not api_key:
                raise ValueError("GEMINI_API_KEY is not set in environment variables.")

            genai.configure(api_key=api_key)
            self._client = genai.GenerativeModel(
                self.model_name,
                generation_config=genai.GenerationConfig(
                    temperature=0.2,
                    top_p=0.8,
                    top_k=40,
                    max_output_tokens=2048,
                ),
            )
        return self._client

    def ask_llm(self, code: str, lang: str, prompt: str = None) -> str:
        if not os.getenv("GEMINI_API_KEY"):
            return "LLM disabled: set GEMINI_API_KEY to enable suggestions."

        # Build prompt with user's question and code context
        full_prompt = build_prompt(code, lang, user_prompt=prompt)

        try:
            response = self._get_client().generate_content(full_prompt)

            if not response.candidates:
                feedback = response.prompt_feedback
                if feedback:
                    return f"Blocked: {feedback}"
                return "No suggestion returned."

            return response.text.strip()

        except Exception as e:
            return f"LLM error: {type(e).__name__}: {e}"

    def __repr__(self) -> str:
        return f"<GeminiProvider model={self.model_name} client={'set' if self._client else 'none'}>"
# from __future__ import annotations

# import os
# from typing import Optional

# from openai import OpenAI
# from dotenv import load_dotenv

# from llm.prompts import build_prompt

# load_dotenv()

# _client: Optional[OpenAI] = None
# _MODEL_NAME = os.getenv("SYNTHI_AI_MODEL", "gpt-4.1-mini")


# def _get_client() -> OpenAI:
#     global _client
#     if _client is None:
#         _client = OpenAI()
#     return _client


# def ask_llm(code: str, lang: str):
#     if not os.getenv("OPENAI_API_KEY"):
#         return "LLM disabled: set OPENAI_API_KEY to enable suggestions."

#     prompt = build_prompt(code, lang)

#     try:
#         response = _get_client().chat.completions.create(
#             model=_MODEL_NAME,
#             messages=[{"role": "user", "content": prompt}],
#             temperature=0.2,
#         )
#         if not response.choices:
#             return "LLM did not return any suggestions."

#         message = response.choices[0].message
#         if isinstance(message, dict):
#             return message.get("content") or "No suggestion from LLM."
#         return getattr(message, "content", None) or "No suggestion from LLM."
#     except Exception as exc:
#         return f"LLM error: {exc}"


from __future__ import annotations

import os
from typing import Optional

import google.generativeai as genai
from dotenv import load_dotenv

from llm.prompts import build_prompt

load_dotenv()

_client: Optional[genai.GenerativeModel] = None
_MODEL_NAME = os.getenv("SYNTHI_AI_MODEL", "gemini-2.5-flash-lite")


def _get_client() -> genai.GenerativeModel:
    global _client
    if _client is None:
        api_key = os.getenv("GEMINI_API_KEY")
        if not api_key:
            raise ValueError("GEMINI_API_KEY is not set in environment variables.")

        genai.configure(api_key=api_key)
        _client = genai.GenerativeModel(_MODEL_NAME)
    return _client


def ask_llm(code: str, lang: str) -> str:
    if not os.getenv("GEMINI_API_KEY"):
        return "LLM disabled: set GEMINI_API_KEY to enable suggestions."

    prompt = build_prompt(code, lang)

    try:
        model = _get_client()
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
import os
from typing import Any, Mapping, Optional, Sequence, Dict

from openai import AsyncOpenAI

from llm.prompts import build_prompt, build_fullfile_prompt, build_patch_prompt
from .base import AiProvider


class ChatGPTProvider(AiProvider):
    _clients: Dict[str, AsyncOpenAI] = {}

    def __init__(self) -> None:
        super().__init__(name="chatgpt")
        self.model_name = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
        self.max_output_tokens = int(os.getenv("OPENAI_MAX_OUTPUT_TOKENS", "4096"))
        self.temperature = float(os.getenv("OPENAI_TEMPERATURE", "0.2"))

    def _get_client(self, api_key: Optional[str]) -> AsyncOpenAI:
        key = api_key or os.getenv("OPENAI_API_KEY")
        if not key:
            raise ValueError("OPENAI_API_KEY is not set in environment variables and no custom key provided.")
        if key not in self._clients:
            self._clients[key] = AsyncOpenAI(api_key=key)
        return self._clients[key]

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
        if not api_key and not os.getenv("OPENAI_API_KEY"):
            return "LLM disabled: set OPENAI_API_KEY or provide api_key to enable suggestions."

        if mode and isinstance(mode, str) and mode.lower() == 'fullfile':
            full_prompt = build_fullfile_prompt(code, lang, prompt or '', files=files, focus=focus)
        elif mode and isinstance(mode, str) and mode.lower() == 'patch':
            full_prompt = build_patch_prompt(code, lang, prompt or '', files=files, focus=focus)
        else:
            if prompt and 'Respond only with the updated full file contents' in prompt:
                full_prompt = build_fullfile_prompt(code, lang, prompt, files=files, focus=focus)
            else:
                augmented = (prompt or '') + "\n\nWhen possible prefer minimal edits and only change what the user requests."
                full_prompt = build_prompt(code, lang, user_prompt=augmented, files=files, focus=focus)

        try:
            client = self._get_client(api_key)
            model_name = model or self.model_name
            stream = await client.chat.completions.create(
                model=model_name,
                messages=[{"role": "user", "content": full_prompt}],
                temperature=self.temperature,
                max_tokens=self.max_output_tokens,
                stream=True,
            )

            chunks = []
            async for chunk in stream:
                try:
                    delta = chunk.choices[0].delta.content or ''
                except Exception:
                    delta = ''
                if delta:
                    chunks.append(delta)

            combined = ''.join(chunks).strip()
            if not combined:
                return "No suggestion returned."
            return combined

        except Exception as e:
            return f"LLM error: {type(e).__name__}: {e}"

    def __repr__(self) -> str:
        return f"<ChatGPTProvider model={self.model_name}>"

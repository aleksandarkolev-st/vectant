import os
from typing import Any, Mapping, Optional, Sequence, Dict
from .base import AiProvider

import google.generativeai as genai
from dotenv import load_dotenv

from llm.prompts import build_prompt, build_fullfile_prompt, build_patch_prompt

load_dotenv()  # Load once at import


class GeminiProvider(AiProvider):
    _clients: Dict[str, genai.GenerativeModel] = {}

    def __init__(self) -> None:
        super().__init__(name="gemini")
        self.model_name = os.getenv("SYNTHI_GEMINI_MODEL", "gemini-2.5-flash-lite")
        # Keep generation parameters centralized so they can be passed into each stream request.
        self.generation_config = genai.GenerationConfig(
            temperature=0.2,
            top_p=0.8,
            top_k=40,
            # Increase output allowance to support larger returned patches or full-file outputs.
            # Note: input/context window size is determined by the model selection (e.g. gemini-2.5-flash-lite).
            max_output_tokens=131072,
        )

    def _get_client(self, api_key: Optional[str], model_name: str) -> genai.GenerativeModel:
        key = api_key or os.getenv("GEMINI_API_KEY")
        if not key:
            raise ValueError("GEMINI_API_KEY is not set in environment variables.")

        cache_key = f"{key}:{model_name}"
        if cache_key not in self._clients:
            # Configure the SDK for callers that use the legacy global configuration.
            genai.configure(api_key=key)
            self._clients[cache_key] = genai.GenerativeModel(
                model_name,
                generation_config=self.generation_config,
            )
        return self._clients[cache_key]

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
        if not api_key and not os.getenv("GEMINI_API_KEY"):
            raise ValueError("LLM disabled: set GEMINI_API_KEY or provide api_key to enable suggestions.")

        # Build prompt with user's question and code context
        # Prefer explicit mode flag. Support 'fullfile' (return full file in fenced block),
        # 'patch' (return a unified diff), and 'explain' (no code changes, just explanation).
        # For other cases, prefer the standard prompt but include the user's instruction.
        mode_lower = mode.lower() if mode and isinstance(mode, str) else ''
        
        if mode_lower == 'fullfile':
            full_prompt = build_fullfile_prompt(code, lang, prompt or '', files=files, focus=focus)
        elif mode_lower == 'patch':
            full_prompt = build_patch_prompt(code, lang, prompt or '', files=files, focus=focus)
        elif mode_lower == 'explain':
            # Explicit explain mode - no code changes, just explanation
            full_prompt = build_prompt(code, lang, user_prompt=prompt or '', files=files, focus=focus, mode='explain')
        else:
            # Backwards-compat: some clients include the instructive string in `prompt`.
            if prompt and 'Respond only with the updated full file contents' in prompt:
                full_prompt = build_fullfile_prompt(code, lang, prompt, files=files, focus=focus)
            else:
                # build_prompt will auto-detect explain queries based on keywords
                # Only add "prefer minimal edits" for non-explain queries
                full_prompt = build_prompt(code, lang, user_prompt=prompt or '', files=files, focus=focus)

        try:
            model_name = model or self.model_name
            client = self._get_client(api_key, model_name)
            # Stream tokens from the Gemini API, accumulating text so the AI chat window
            # can display the final suggestion as a plain string.
            response = await client.generate_content_async(full_prompt, stream=True)

            chunks = []
            prompt_feedback = None
            async for chunk in response:
                if getattr(chunk, "prompt_feedback", None):
                    prompt_feedback = chunk.prompt_feedback
                
                # Safely extract text from chunk - accessing .text throws if no valid parts
                # This can happen when finish_reason is STOP (1) but no content was generated
                try:
                    # Check for candidates with content first (safer approach)
                    candidates = getattr(chunk, "candidates", None)
                    if candidates and len(candidates) > 0:
                        candidate = candidates[0]
                        content = getattr(candidate, "content", None)
                        if content:
                            parts = getattr(content, "parts", None)
                            if parts:
                                for part in parts:
                                    part_text = getattr(part, "text", None)
                                    if part_text:
                                        chunks.append(part_text)
                                continue
                    
                    # Fallback: try the .text accessor
                    text = chunk.text
                    if text:
                        chunks.append(text)
                except (ValueError, AttributeError):
                    # .text accessor throws ValueError if no valid parts
                    # This is expected when finish_reason is STOP without content
                    pass

            combined = "".join(chunks).strip()

            if not combined:
                feedback = prompt_feedback or getattr(response, "prompt_feedback", None)
                if feedback:
                    raise ValueError(f"Blocked: {feedback}")
                raise ValueError("No response generated by AI")
                # Fallback might not be available on async iterator directly like this, 
                # but let's keep logic similar to sync version if possible.
                # In async stream, we usually just rely on chunks.
                pass

            if not combined:
                return "No suggestion returned."

            return combined

        except Exception as e:
            return f"LLM error: {type(e).__name__}: {e}"

    def __repr__(self) -> str:
        return f"<GeminiProvider model={self.model_name} client={'set' if self._client else 'none'}>"

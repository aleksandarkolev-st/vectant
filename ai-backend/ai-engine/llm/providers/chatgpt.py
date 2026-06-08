import os
import time
from typing import Any, Mapping, Optional, Sequence, Dict

from openai import AsyncOpenAI

from llm.prompts import build_prompt, build_fullfile_prompt, build_patch_prompt, build_split_mode_prompt
from .base import AiProvider, provider_model_provenance


def _get_metrics_collector():
    """Lazy import to avoid circular dependencies."""
    try:
        from metrics import get_metrics_collector
        return get_metrics_collector()
    except ImportError:
        return None


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
        request_mode: Optional[str] = None,
    ) -> str:
        model_name = model or self.model_name
        mode_lower = mode.lower() if mode and isinstance(mode, str) else ''
        if not api_key and not os.getenv("OPENAI_API_KEY"):
            self.last_call_metadata = provider_model_provenance(
                provider=self.name,
                requested_model=model_name,
                actual_model=None,
                mode=mode_lower,
                request_mode=request_mode,
                error_type="missing_api_key",
            )
            return "LLM disabled: set OPENAI_API_KEY or provide api_key to enable suggestions."

        # Prefer explicit mode flag. Support 'fullfile', 'patch', and 'explain' modes.
        if mode_lower == 'fullfile':
            full_prompt = build_fullfile_prompt(code, lang, prompt or '', files=files, focus=focus)
        elif mode_lower == 'patch':
            full_prompt = build_patch_prompt(code, lang, prompt or '', files=files, focus=focus)
        elif mode_lower == 'explain':
            # Explicit explain mode - no code changes, just explanation
            full_prompt = build_prompt(code, lang, user_prompt=prompt or '', files=files, focus=focus, mode='explain')
        elif mode_lower == 'split':
            # Split mode: send the split prompt directly with the code embedded.
            # Do NOT wrap in build_prompt() — that adds general-analysis framing
            # which causes the LLM to emit explanation prose before the JSON.
            full_prompt = build_split_mode_prompt(code, lang, prompt or '')
        else:
            if prompt and 'Respond only with the updated full file contents' in prompt:
                full_prompt = build_fullfile_prompt(code, lang, prompt, files=files, focus=focus)
            else:
                # build_prompt will auto-detect explain queries based on keywords
                full_prompt = build_prompt(code, lang, user_prompt=prompt or '', files=files, focus=focus)

        try:
            client = self._get_client(api_key)

            # Metrics tracking
            start_time = time.time()
            first_token_time = None
            total_tokens = 0
            prompt_tokens = len(full_prompt.split())  # Rough estimate
            
            stream = await client.chat.completions.create(
                model=model_name,
                messages=[{"role": "user", "content": full_prompt}],
                temperature=self.temperature,
                max_tokens=self.max_output_tokens,
                stream=True,
            )

            chunks = []
            async for chunk in stream:
                # Track TTFT
                if first_token_time is None:
                    first_token_time = time.time()
                
                try:
                    delta = chunk.choices[0].delta.content or ''
                except Exception:
                    delta = ''
                if delta:
                    chunks.append(delta)
                    total_tokens += len(delta.split())

            combined = ''.join(chunks).strip()
            
            # Record metrics
            end_time = time.time()
            total_latency_ms = (end_time - start_time) * 1000
            ttft_ms = (first_token_time - start_time) * 1000 if first_token_time else total_latency_ms
            
            collector = _get_metrics_collector()
            if collector:
                collector.record_streaming_completion(
                    ttft_ms=ttft_ms,
                    total_latency_ms=total_latency_ms,
                    tokens=total_tokens,
                    prompt_tokens=prompt_tokens,
                    output_tokens=total_tokens,
                )
                collector.record_inference(
                    model=model_name,
                    inference_time_ms=total_latency_ms,
                    success=bool(combined),
                    is_timeout=False,
                    error_type=None,
                )
            
            if not combined:
                self.last_call_metadata = provider_model_provenance(
                    provider=self.name,
                    requested_model=model_name,
                    actual_model=model_name,
                    mode=mode_lower,
                    request_mode=request_mode,
                    latency_ms=total_latency_ms,
                )
                return "No suggestion returned."
            self.last_call_metadata = provider_model_provenance(
                provider=self.name,
                requested_model=model_name,
                actual_model=model_name,
                mode=mode_lower,
                request_mode=request_mode,
                latency_ms=total_latency_ms,
            )
            return combined

        except Exception as e:
            # Record error metrics
            is_timeout = "timeout" in str(e).lower()
            collector = _get_metrics_collector()
            if collector:
                collector.record_inference(
                    model=model or self.model_name,
                    inference_time_ms=(time.time() - start_time) * 1000 if 'start_time' in dir() else 0,
                    success=False,
                    is_timeout=is_timeout,
                    error_type=type(e).__name__,
                )
            self.last_call_metadata = provider_model_provenance(
                provider=self.name,
                requested_model=model_name,
                actual_model=None,
                mode=mode_lower,
                request_mode=request_mode,
                latency_ms=(time.time() - start_time) * 1000 if 'start_time' in dir() else None,
                error_type=type(e).__name__,
            )
            return f"LLM error: {type(e).__name__}: {e}"

    def __repr__(self) -> str:
        return f"<ChatGPTProvider model={self.model_name}>"

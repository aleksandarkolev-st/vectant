import asyncio
import os
import time
from typing import Any, Mapping, Optional, Sequence, Dict
from .base import AiProvider

import google.generativeai as genai
from dotenv import load_dotenv

# PERF: Use tiktoken for accurate token counting instead of rough len(split())
# estimates.  Prevents budget overflows (costly retries) and underutilization.
try:
    import tiktoken
    _TIKTOKEN_ENC = tiktoken.get_encoding("cl100k_base")  # fast, good approximation for Gemini
except Exception:
    _TIKTOKEN_ENC = None


def _count_tokens(text: str) -> int:
    """Count tokens using tiktoken when available, fallback to word split."""
    if _TIKTOKEN_ENC is not None:
        return len(_TIKTOKEN_ENC.encode(text, disallowed_special=()))
    return len(text.split())


from llm.prompts import build_prompt, build_fullfile_prompt, build_patch_prompt

load_dotenv()  # Load once at import


def _get_metrics_collector():
    """Lazy import to avoid circular dependencies."""
    try:
        from metrics import get_metrics_collector
        return get_metrics_collector()
    except ImportError:
        return None


# Limit concurrent Gemini API calls to 1 — prevents split and analyze
# from competing for quota and causing DeadlineExceeded/rate-limit errors.
_gemini_semaphore = asyncio.Semaphore(1)


class GeminiProvider(AiProvider):
    _clients: Dict[str, genai.GenerativeModel] = {}

    def __init__(self) -> None:
        super().__init__(name="gemini")
        self.model_name = os.getenv("SYNTHI_GEMINI_MODEL", "gemini-3-flash-preview")
        # Keep generation parameters centralized so they can be passed into each stream request.
        self.generation_config = genai.GenerationConfig(
            temperature=0.2,
            top_p=0.8,
            top_k=40,
            # Increase output allowance to support larger returned patches or full-file outputs.
            # Note: input/context window size is determined by the model selection (e.g. gemini-gemini-3-flash-preview).
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
        elif mode_lower == 'split':
            # Split mode: send the split prompt directly with the code embedded.
            # Do NOT wrap in build_prompt() — that adds general-analysis framing
            # which causes the LLM to emit explanation prose before the JSON.
            full_prompt = (prompt or '') + f"\n\nHere is the code to split (language: {lang}):\n```{lang}\n{code}\n```\n\nRespond with ONLY the JSON object. No explanation."
        elif mode_lower == 'delta':
            # Delta mode: structural addition/deletion prompt already fully formed.
            # Do NOT wrap in build_prompt() — it adds analysis framing that makes
            # Gemini return prose instead of pure JSON.
            full_prompt = code + "\n\nRespond with ONLY the JSON object. No explanation."
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

            # Metrics tracking
            start_time = time.time()
            first_token_time = None
            total_tokens = 0
            
            # Stream tokens from the Gemini API, accumulating text so the AI chat window
            # can display the final suggestion as a plain string.
            # Wrapped in asyncio.wait_for to prevent hanging the single-worker server
            # if Gemini stalls — frees the worker for the next request.
            async def _stream_gemini():
                nonlocal first_token_time, total_tokens
                print(f"[Gemini] Starting stream for mode={mode_lower}, prompt_len={len(full_prompt)} chars")
                resp = await client.generate_content_async(full_prompt, stream=True)
                print(f"[Gemini] Stream created, waiting for chunks...")
                _chunks = []
                _feedback = None
                async for chunk in resp:
                    if first_token_time is None:
                        first_token_time = time.time()
                        print(f"[Gemini] First token at {first_token_time - start_time:.2f}s")
                    if getattr(chunk, "prompt_feedback", None):
                        _feedback = chunk.prompt_feedback
                    try:
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
                                            _chunks.append(part_text)
                                            total_tokens += _count_tokens(part_text)
                                    continue
                        text = chunk.text
                        if text:
                            _chunks.append(text)
                            total_tokens += _count_tokens(text)
                    except (ValueError, AttributeError):
                        pass
                print(f"[Gemini] Stream complete: {len(_chunks)} chunks, {total_tokens} tokens, {time.time() - start_time:.2f}s")
                return _chunks, _feedback

            # Serialize Gemini calls — concurrent requests cause rate-limit/quota errors
            async with _gemini_semaphore:
                try:
                    chunks, prompt_feedback = await asyncio.wait_for(_stream_gemini(), timeout=120.0)
                    combined = "".join(chunks).strip()
                except (asyncio.TimeoutError, Exception) as stream_err:
                    elapsed = time.time() - start_time
                    print(f"[Gemini] Streaming failed after {elapsed:.1f}s: {type(stream_err).__name__}: {stream_err}")
                    print(f"[Gemini] Retrying with non-streaming API...")
                    try:
                        resp = await asyncio.wait_for(
                            client.generate_content_async(full_prompt, stream=False),
                            timeout=90.0,
                        )
                        combined = resp.text.strip()
                        total_tokens = _count_tokens(combined)
                        print(f"[Gemini] Non-streaming succeeded: {total_tokens} tokens, {time.time() - start_time:.2f}s")
                    except Exception as fallback_err:
                        print(f"[Gemini] Non-streaming also failed: {type(fallback_err).__name__}: {fallback_err}")
                        raise fallback_err
            
            # Record metrics
            end_time = time.time()
            total_latency_ms = (end_time - start_time) * 1000
            ttft_ms = (first_token_time - start_time) * 1000 if first_token_time else total_latency_ms
            prompt_tokens = _count_tokens(full_prompt)
            
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
            raise

    def __repr__(self) -> str:
        return f"<GeminiProvider model={self.model_name} client={'set' if self._client else 'none'}>"

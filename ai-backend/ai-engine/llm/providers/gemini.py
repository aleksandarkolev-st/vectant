import asyncio
from datetime import datetime, timezone
import os
import re
import time
from typing import Any, Mapping, Optional, Sequence, Dict
from .base import AiProvider

import google.generativeai as genai
try:
    from google.api_core import exceptions as google_api_exceptions
except Exception:  # pragma: no cover - optional SDK surface varies by install
    google_api_exceptions = None
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


from llm.prompts import build_prompt, build_fullfile_prompt, build_patch_prompt, build_split_mode_prompt

load_dotenv()  # Load once at import


def _env_float(name: str, default: float) -> float:
    raw = os.getenv(name)
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        return default
    return value if value > 0 else default


def _env_float_min(name: str, default: float, minimum: float) -> float:
    raw = os.getenv(name)
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        return default
    return value if value >= minimum else default


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


def _normalize_model_name(name: str) -> str:
    value = (name or "").strip()
    return value.removeprefix("models/")


def _model_version_tuple(name: str) -> tuple[int, int, int]:
    parts = [int(part) for part in re.findall(r"\d+", name)[:3]]
    while len(parts) < 3:
        parts.append(0)
    return tuple(parts[:3])


def _model_family_tokens(name: str) -> set[str]:
    tokens = {
        token
        for token in re.split(r"[^a-z0-9]+", _normalize_model_name(name).lower())
        if token and not token.isdigit()
    }
    return tokens - {"gemini", "models", "preview", "latest"}


def _model_metadata_name(model: Any) -> str:
    if isinstance(model, str):
        return model
    return str(getattr(model, "name", "") or getattr(model, "model_name", "") or "")


def _model_supports_generate_content(model: Any) -> bool:
    methods = getattr(model, "supported_generation_methods", None)
    if methods is None and isinstance(model, Mapping):
        methods = model.get("supported_generation_methods")
    if not methods:
        return True
    return "generateContent" in set(methods)


def _select_fallback_model_name(requested: str, models: Sequence[Any]) -> Optional[str]:
    requested_name = _normalize_model_name(requested)
    requested_lower = requested_name.lower()
    requested_tokens = _model_family_tokens(requested_name)
    candidates: list[str] = []
    for model in models:
        if not _model_supports_generate_content(model):
            continue
        name = _normalize_model_name(_model_metadata_name(model))
        if not name:
            continue
        lower = name.lower()
        if not lower.startswith("gemini-"):
            continue
        if lower == requested_lower:
            continue
        candidates.append(name)
    if not candidates:
        return None

    def rank(name: str) -> tuple[int, int, tuple[int, int, int], str]:
        lower = name.lower()
        tokens = _model_family_tokens(name)
        family_score = len(tokens & requested_tokens)
        stable_score = 0 if "preview" in lower else 1
        return (family_score, stable_score, _model_version_tuple(lower), lower)

    return max(candidates, key=rank)


_MODEL_AVAILABILITY_SOURCE = "https://ai.google.dev/gemini-api/docs/deprecations"
_MODEL_AVAILABILITY_SOURCE_LAST_UPDATED = "2026-06-01"
_DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-lite"
_MODEL_STATUS_REGISTRY: Dict[str, Dict[str, Any]] = {
    "gemini-3.5-flash": {
        "provider_model_status": "available",
        "provider_shutdown_date": None,
        "provider_recommended_replacement": None,
    },
    "gemini-3.1-flash-lite": {
        "provider_model_status": "deprecated",
        "provider_shutdown_date": "2027-05-07",
        "provider_recommended_replacement": None,
    },
    "gemini-3.1-flash-lite-preview": {
        "provider_model_status": "shutdown",
        "provider_shutdown_date": "2026-05-25",
        "provider_recommended_replacement": "gemini-3.1-flash-lite",
    },
}


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _private_model_aliases() -> Dict[str, str]:
    raw = os.getenv("SYNTHI_GEMINI_PRIVATE_MODEL_ALIASES", "")
    aliases: Dict[str, str] = {}
    for entry in raw.split(","):
        item = entry.strip()
        if not item:
            continue
        if "=" in item:
            key, value = item.split("=", 1)
        elif ":" in item:
            key, value = item.split(":", 1)
        else:
            key = value = item
        normalized_key = _normalize_model_name(key).lower()
        normalized_value = _normalize_model_name(value)
        if normalized_key and normalized_value:
            aliases[normalized_key] = normalized_value
    return aliases


def _provider_model_status(requested: str) -> Dict[str, Any]:
    normalized = _normalize_model_name(requested)
    normalized_lower = normalized.lower()
    base = dict(
        _MODEL_STATUS_REGISTRY.get(
            normalized_lower,
            {
                "provider_model_status": "unknown",
                "provider_shutdown_date": None,
                "provider_recommended_replacement": None,
            },
        )
    )
    base.update(
        {
            "model_availability_checked_at": _utc_now_iso(),
            "model_availability_source": _MODEL_AVAILABILITY_SOURCE,
            "model_availability_source_last_updated": _MODEL_AVAILABILITY_SOURCE_LAST_UPDATED,
            "provider_model_alias_resolved_to": None,
        }
    )

    private_alias = _private_model_aliases().get(normalized_lower)
    if private_alias:
        base["provider_model_status"] = "private_alias"
        base["provider_model_alias_resolved_to"] = private_alias

    base["provider_shutdown_or_deprecation_detected"] = bool(
        normalized_lower in _MODEL_STATUS_REGISTRY
        and _MODEL_STATUS_REGISTRY[normalized_lower]["provider_model_status"]
        in {"deprecated", "shutdown"}
    )
    return base


def _request_mode_name(mode_lower: str, request_mode: Optional[str]) -> str:
    if request_mode:
        return request_mode
    if mode_lower == "split":
        return "split"
    if mode_lower == "delta":
        return "delta"
    return mode_lower or "unknown"


def _shutdown_model_error(requested_model: str, status: Mapping[str, Any]) -> ValueError:
    replacement = status.get("provider_recommended_replacement")
    suffix = f"; use {replacement}" if replacement else ""
    return ValueError(
        f"Requested Gemini model {requested_model!r} is shutdown according to "
        f"{_MODEL_AVAILABILITY_SOURCE} (shutdown_date="
        f"{status.get('provider_shutdown_date')}){suffix}."
    )


def _is_model_not_found_error(err: BaseException) -> bool:
    not_found_type = getattr(google_api_exceptions, "NotFound", None) if google_api_exceptions else None
    return bool(not_found_type and isinstance(err, not_found_type))


class GeminiProvider(AiProvider):
    _clients: Dict[str, genai.GenerativeModel] = {}

    def __init__(self) -> None:
        super().__init__(name="gemini")
        self.model_name = os.getenv("SYNTHI_GEMINI_MODEL", _DEFAULT_GEMINI_MODEL)
        self.last_call_metadata: Dict[str, Any] = {}
        # Keep generation parameters centralized so they can be passed into each stream request.
        self.generation_config = genai.GenerationConfig(
            temperature=0.2,
            top_p=0.8,
            top_k=40,
            # Increase output allowance to support larger returned patches or full-file outputs.
            # Note: input/context window size is determined by the model selection (e.g. gemini-3.1-flash-lite).
            max_output_tokens=131072,
        )

    def _generation_config_for_mode(self, mode: str) -> genai.GenerationConfig:
        if mode == "split":
            return genai.GenerationConfig(
                temperature=_env_float_min("SYNTHI_GEMINI_SPLIT_TEMPERATURE", 0.0, 0.0),
                top_p=_env_float_min("SYNTHI_GEMINI_SPLIT_TOP_P", 0.8, 0.0),
                top_k=int(_env_float_min("SYNTHI_GEMINI_SPLIT_TOP_K", 40.0, 1.0)),
                max_output_tokens=int(
                    _env_float_min("SYNTHI_GEMINI_SPLIT_MAX_OUTPUT_TOKENS", 131072.0, 1.0)
                ),
            )
        return self.generation_config

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

    def _fallback_model_name(self, api_key: Optional[str], requested_model: str) -> Optional[str]:
        env_model = (
            os.getenv("SYNTHI_GEMINI_FALLBACK_MODEL")
            or os.getenv("GEMINI_FALLBACK_MODEL")
            or ""
        ).strip()
        if env_model and _normalize_model_name(env_model).lower() != _normalize_model_name(requested_model).lower():
            return _normalize_model_name(env_model)

        key = api_key or os.getenv("GEMINI_API_KEY")
        if not key:
            return None
        genai.configure(api_key=key)
        return _select_fallback_model_name(requested_model, list(genai.list_models()))

    def _timeout_seconds(self, mode: str, prompt_len: int) -> float:
        default_timeout = _env_float("SYNTHI_GEMINI_TIMEOUT_SEC", 120.0)
        if mode == "split":
            split_default = 300.0 if prompt_len >= 200_000 else 180.0
            return _env_float("SYNTHI_GEMINI_SPLIT_TIMEOUT_SEC", split_default)
        if mode == "delta":
            return _env_float("SYNTHI_GEMINI_DELTA_TIMEOUT_SEC", default_timeout)
        return default_timeout

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
            full_prompt = build_split_mode_prompt(code, lang, prompt or '')
        elif mode_lower == 'delta':
            # Delta mode: structural addition/deletion prompt already fully formed.
            # Do NOT wrap in build_prompt() — it adds analysis framing that makes
            # Gemini return prose instead of pure JSON.
            full_prompt = code + "\n\nRespond with ONLY the JSON object. No explanation."
        elif mode_lower == 'rule_translate':
            # Rule-translate mode: caller supplied a fully-formed prompt asking
            # Gemini to convert plain English into a structured rule JSON.
            # Send verbatim — any wrapper would add noise that confuses the
            # structured-output parser.
            full_prompt = prompt or ''
        else:
            # Backwards-compat: some clients include the instructive string in `prompt`.
            if prompt and 'Respond only with the updated full file contents' in prompt:
                full_prompt = build_fullfile_prompt(code, lang, prompt, files=files, focus=focus)
            else:
                # build_prompt will auto-detect explain queries based on keywords
                # Only add "prefer minimal edits" for non-explain queries
                full_prompt = build_prompt(code, lang, user_prompt=prompt or '', files=files, focus=focus)

        try:
            requested_model = model or self.model_name
            provider_status = _provider_model_status(requested_model)
            request_mode_value = _request_mode_name(mode_lower, request_mode)
            hard_infra_failure = provider_status.get("provider_model_status") == "shutdown"
            if hard_infra_failure:
                raise _shutdown_model_error(requested_model, provider_status)
            model_name = (
                provider_status.get("provider_model_alias_resolved_to")
                or requested_model
            )
            model_name = _normalize_model_name(model_name)
            fallback_used = False
            fallback_model: Optional[str] = None

            # Metrics tracking
            start_time = time.time()
            first_token_time = None
            total_tokens = 0

            # Non-streaming — more reliable than streaming which hangs on this model
            timeout_seconds = self._timeout_seconds(mode_lower, len(full_prompt))
            print(
                f"[Gemini] Calling API for mode={mode_lower}, "
                f"prompt_len={len(full_prompt)} chars, timeout={timeout_seconds:.1f}s"
            )

            async def generate_once(selected_model: str) -> str:
                client = self._get_client(api_key, selected_model)
                resp = await asyncio.wait_for(
                    client.generate_content_async(
                        full_prompt,
                        stream=False,
                        generation_config=self._generation_config_for_mode(mode_lower),
                    ),
                    timeout=timeout_seconds,
                )
                return resp.text.strip()

            try:
                combined = await generate_once(model_name)
                total_tokens = _count_tokens(combined)
                print(f"[Gemini] Succeeded: {total_tokens} tokens, {time.time() - start_time:.2f}s")
            except Exception as err:
                if _is_model_not_found_error(err):
                    fallback_model = self._fallback_model_name(api_key, model_name)
                    if fallback_model:
                        fallback_status = _provider_model_status(fallback_model)
                        if fallback_status.get("provider_model_status") == "shutdown":
                            raise _shutdown_model_error(fallback_model, fallback_status)
                        print(
                            "[Gemini] Requested model was not found; "
                            f"retrying with discovered fallback model={fallback_model}"
                        )
                        model_name = fallback_model
                        fallback_used = True
                        combined = await generate_once(model_name)
                        total_tokens = _count_tokens(combined)
                        print(
                            f"[Gemini] Succeeded with fallback: {total_tokens} tokens, "
                            f"{time.time() - start_time:.2f}s"
                        )
                    else:
                        print(f"[Gemini] Failed: {type(err).__name__}: {err}")
                        raise
                else:
                    print(f"[Gemini] Failed: {type(err).__name__}: {err}")
                    raise
            
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

            self.last_call_metadata = {
                "provider": self.name,
                "requested_model": requested_model,
                "actual_model": model_name,
                "fallback_model": fallback_model,
                "fallback_used": fallback_used,
                "mode": mode_lower,
                "request_mode": request_mode_value,
                "provider_model_status": provider_status.get("provider_model_status"),
                "provider_model_alias_resolved_to": provider_status.get("provider_model_alias_resolved_to"),
                "provider_shutdown_or_deprecation_detected": provider_status.get(
                    "provider_shutdown_or_deprecation_detected"
                ),
                "provider_shutdown_date": provider_status.get("provider_shutdown_date"),
                "provider_recommended_replacement": provider_status.get(
                    "provider_recommended_replacement"
                ),
                "model_availability_checked_at": provider_status.get("model_availability_checked_at"),
                "model_availability_source": provider_status.get("model_availability_source"),
                "model_availability_source_last_updated": provider_status.get(
                    "model_availability_source_last_updated"
                ),
                "hard_infra_failure": False,
                "latency_ms": total_latency_ms,
            }
            return combined

        except Exception as e:
            requested_model = model or self.model_name
            provider_status = (
                provider_status
                if "provider_status" in locals()
                else _provider_model_status(requested_model)
            )
            self.last_call_metadata = {
                "provider": self.name,
                "requested_model": requested_model,
                "actual_model": None,
                "fallback_model": None,
                "fallback_used": False,
                "mode": mode_lower if 'mode_lower' in locals() else None,
                "request_mode": _request_mode_name(
                    mode_lower if "mode_lower" in locals() else "",
                    request_mode,
                ),
                "provider_model_status": provider_status.get("provider_model_status"),
                "provider_model_alias_resolved_to": provider_status.get("provider_model_alias_resolved_to"),
                "provider_shutdown_or_deprecation_detected": provider_status.get(
                    "provider_shutdown_or_deprecation_detected"
                ),
                "provider_shutdown_date": provider_status.get("provider_shutdown_date"),
                "provider_recommended_replacement": provider_status.get(
                    "provider_recommended_replacement"
                ),
                "model_availability_checked_at": provider_status.get("model_availability_checked_at"),
                "model_availability_source": provider_status.get("model_availability_source"),
                "model_availability_source_last_updated": provider_status.get(
                    "model_availability_source_last_updated"
                ),
                "hard_infra_failure": provider_status.get("provider_model_status") == "shutdown",
                "error_type": type(e).__name__,
            }
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

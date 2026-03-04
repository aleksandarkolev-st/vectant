"""
ai-backend/ai-engine/analyzer/proactive/healing/ai_retry.py

Retry decorator for LLM calls with exponential backoff.

Why:
  - Gemini API returns 429 (rate limit) or 503 (overloaded) transiently.
  - A simple retry with jittered backoff resolves most transient failures.
  - Without retries, a single 503 drops the entire analysis.

Usage:
    from ai_retry import with_retry

    result = await with_retry(
        coroutine_fn=lambda: provider.ask_llm(code=code, ...),
        max_retries=2,
    )
"""

from __future__ import annotations

import asyncio
import logging
import random
from typing import Any, Awaitable, Callable, Optional, Sequence, Type

logger = logging.getLogger("healing.ai_retry")


# Exceptions that are safe to retry (transient network / API errors)
_DEFAULT_RETRYABLE: tuple[Type[Exception], ...] = (
    ConnectionError,
    TimeoutError,
    asyncio.TimeoutError,
    OSError,
)


async def with_retry(
    coroutine_fn: Callable[[], Awaitable[Any]],
    max_retries: int = 2,
    base_delay: float = 1.0,
    max_delay: float = 10.0,
    jitter: float = 0.5,
    retryable_exceptions: Optional[Sequence[Type[Exception]]] = None,
    on_retry: Optional[Callable[[int, Exception, float], None]] = None,
) -> Any:
    """
    Execute an async function with exponential backoff retries.

    Parameters
    ----------
    coroutine_fn : () -> Awaitable
        A zero-argument callable that returns an awaitable.
        Called fresh on each attempt (not a pre-built coroutine).
    max_retries : int
        Maximum number of retry attempts (0 = no retries, just one attempt).
    base_delay : float
        Initial backoff delay in seconds.
    max_delay : float
        Cap on backoff delay.
    jitter : float
        Random jitter factor (0–1). Actual delay = delay × (1 ± jitter).
    retryable_exceptions : Sequence[Type[Exception]] | None
        Exception types that trigger a retry. Default: connection/timeout errors.
    on_retry : (attempt, exception, delay) -> None | None
        Optional callback invoked before each retry sleep.

    Returns
    -------
    The return value of coroutine_fn() on success.

    Raises
    ------
    The last exception if all retries are exhausted.
    """
    retryable = tuple(retryable_exceptions or _DEFAULT_RETRYABLE)
    last_exception: Optional[Exception] = None

    for attempt in range(1 + max_retries):
        try:
            return await coroutine_fn()

        except retryable as exc:
            last_exception = exc

            if attempt >= max_retries:
                # Exhausted all retries — re-raise
                logger.warning(
                    f"All {max_retries} retries exhausted. Last error: {exc}"
                )
                raise

            # Calculate delay with exponential backoff + jitter
            delay = min(base_delay * (2 ** attempt), max_delay)
            jittered = delay * (1 + random.uniform(-jitter, jitter))
            jittered = max(0.1, jittered)  # never < 100ms

            if on_retry:
                on_retry(attempt, exc, jittered)

            logger.info(
                f"Retry {attempt + 1}/{max_retries} after {jittered:.1f}s "
                f"(error: {type(exc).__name__}: {exc})"
            )

            await asyncio.sleep(jittered)

    # Should never reach here, but just in case
    if last_exception:
        raise last_exception
    raise RuntimeError("Retry loop completed without result or exception")


def is_retryable_http_status(status_code: int) -> bool:
    """
    Check if an HTTP status code is retryable.

    Retryable:
      - 429 Too Many Requests
      - 500 Internal Server Error
      - 502 Bad Gateway
      - 503 Service Unavailable
      - 504 Gateway Timeout
    """
    return status_code in (429, 500, 502, 503, 504)

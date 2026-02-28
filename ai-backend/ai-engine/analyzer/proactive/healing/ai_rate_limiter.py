"""
ai-backend/ai-engine/analyzer/proactive/healing/ai_rate_limiter.py

Token-bucket rate limiter for LLM API calls.

Prevents accidental API abuse when multiple users or tabs trigger
AI analysis concurrently.  Uses an async-safe token bucket that
refills at a configurable rate.

Default: 10 requests per 60 seconds per agent instance.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field


@dataclass
class RateLimiterConfig:
    """Configuration for the token-bucket rate limiter."""

    max_tokens: int = 10
    """Maximum burst size (bucket capacity)."""

    refill_rate: float = 10 / 60.0
    """Tokens added per second (default: 10 per 60 s ≈ 0.167/s)."""

    wait_timeout: float = 15.0
    """Max seconds to wait for a token before raising RateLimitExceeded."""


class RateLimitExceeded(Exception):
    """Raised when the LLM rate limit is exceeded and wait times out."""

    def __init__(self, retry_after: float):
        self.retry_after = retry_after
        super().__init__(
            f"LLM rate limit exceeded. Retry after {retry_after:.1f}s."
        )


class AsyncTokenBucket:
    """
    Async-safe token-bucket rate limiter.

    Tokens are consumed on each LLM call.  The bucket refills
    continuously at `refill_rate` tokens/second up to `max_tokens`.
    """

    def __init__(self, config: RateLimiterConfig | None = None):
        self._config = config or RateLimiterConfig()
        self._tokens: float = float(self._config.max_tokens)
        self._last_refill: float = time.monotonic()
        self._lock = asyncio.Lock()

        # Stats
        self.total_acquired: int = 0
        self.total_rejected: int = 0
        self.total_waited: float = 0.0

    # ── Public API ─────────────────────────────────────────────────

    async def acquire(self) -> None:
        """
        Acquire one token.  Waits up to `wait_timeout` seconds for
        a token to become available.  Raises `RateLimitExceeded` if
        the wait times out.
        """
        deadline = time.monotonic() + self._config.wait_timeout
        wait_start = time.monotonic()

        while True:
            async with self._lock:
                self._refill()

                if self._tokens >= 1.0:
                    self._tokens -= 1.0
                    self.total_acquired += 1
                    self.total_waited += time.monotonic() - wait_start
                    return

            # Not enough tokens — calculate wait time
            async with self._lock:
                deficit = 1.0 - self._tokens
                wait_secs = deficit / self._config.refill_rate

            now = time.monotonic()
            if now + wait_secs > deadline:
                self.total_rejected += 1
                retry_after = wait_secs
                raise RateLimitExceeded(retry_after)

            await asyncio.sleep(min(wait_secs, 1.0))

    def try_acquire(self) -> bool:
        """
        Non-blocking attempt to acquire one token.
        Returns True if acquired, False otherwise.
        (Synchronous — use from sync code or when you don't want to wait.)
        """
        self._refill()
        if self._tokens >= 1.0:
            self._tokens -= 1.0
            self.total_acquired += 1
            return True
        self.total_rejected += 1
        return False

    @property
    def available_tokens(self) -> float:
        """Current number of available tokens (may be fractional)."""
        self._refill()
        return self._tokens

    @property
    def stats(self) -> dict:
        """Return rate limiter statistics."""
        return {
            "available_tokens": round(self.available_tokens, 2),
            "max_tokens": self._config.max_tokens,
            "refill_rate": round(self._config.refill_rate, 4),
            "total_acquired": self.total_acquired,
            "total_rejected": self.total_rejected,
            "total_wait_seconds": round(self.total_waited, 2),
        }

    def reset(self) -> None:
        """Reset the bucket to full and clear stats."""
        self._tokens = float(self._config.max_tokens)
        self._last_refill = time.monotonic()
        self.total_acquired = 0
        self.total_rejected = 0
        self.total_waited = 0.0

    # ── Internal ───────────────────────────────────────────────────

    def _refill(self) -> None:
        """Add tokens based on elapsed time since last refill."""
        now = time.monotonic()
        elapsed = now - self._last_refill
        if elapsed <= 0:
            return
        self._tokens = min(
            self._config.max_tokens,
            self._tokens + elapsed * self._config.refill_rate,
        )
        self._last_refill = now


# ── Module-level singleton ─────────────────────────────────────────

_global_limiter: AsyncTokenBucket | None = None


def get_rate_limiter(
    config: RateLimiterConfig | None = None,
) -> AsyncTokenBucket:
    """
    Return (or create) the module-level rate limiter singleton.
    Thread/task safe — always returns the same instance.
    """
    global _global_limiter
    if _global_limiter is None:
        _global_limiter = AsyncTokenBucket(config)
    return _global_limiter

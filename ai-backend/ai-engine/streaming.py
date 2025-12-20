"""
Real Token Streaming with Provider Support
==========================================
Implements real streaming from AI providers with fallback to batch mode.
Supports cancellation, partial failure, and progress tracking.
"""

from __future__ import annotations

import asyncio
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, AsyncIterator, Callable, Dict, List, Optional, TypeVar

from pydantic import BaseModel


class StreamingStatus(str, Enum):
    """Status of streaming operation."""
    PENDING = "pending"
    STREAMING = "streaming"
    COMPLETED = "completed"
    CANCELLED = "cancelled"
    FAILED = "failed"
    PARTIAL = "partial"  # Partially completed before failure


@dataclass
class StreamChunk:
    """A single chunk from the stream."""
    content: str
    index: int
    is_final: bool = False
    tokens_so_far: int = 0
    finish_reason: Optional[str] = None
    timestamp: float = field(default_factory=time.time)


@dataclass
class StreamingResult:
    """Final result of streaming operation."""
    status: StreamingStatus
    content: str
    chunks: List[StreamChunk]
    total_tokens: int
    duration_ms: float
    error: Optional[str] = None
    cancelled_at: Optional[int] = None  # Chunk index where cancelled
    model_used: Optional[str] = None


class StreamingProgress:
    """Tracks streaming progress for UI updates."""
    
    def __init__(self):
        self.chunks_received: int = 0
        self.tokens_received: int = 0
        self.content_buffer: str = ""
        self.start_time: float = time.time()
        self.last_chunk_time: float = time.time()
        self.status: StreamingStatus = StreamingStatus.PENDING
    
    def update(self, chunk: StreamChunk) -> None:
        """Update progress with new chunk."""
        self.chunks_received += 1
        self.content_buffer += chunk.content
        self.tokens_received = chunk.tokens_so_far
        self.last_chunk_time = time.time()
        self.status = StreamingStatus.STREAMING
        
        if chunk.is_final:
            self.status = StreamingStatus.COMPLETED
    
    @property
    def elapsed_ms(self) -> float:
        return (time.time() - self.start_time) * 1000
    
    @property
    def tokens_per_second(self) -> float:
        elapsed = time.time() - self.start_time
        if elapsed > 0:
            return self.tokens_received / elapsed
        return 0.0


class CancellationToken:
    """Token for cancelling streaming operations."""
    
    def __init__(self):
        self._cancelled = False
        self._reason: Optional[str] = None
        self._callbacks: List[Callable[[], None]] = []
    
    def cancel(self, reason: str = "User cancelled") -> None:
        """Cancel the operation."""
        self._cancelled = True
        self._reason = reason
        for cb in self._callbacks:
            try:
                cb()
            except Exception:
                pass
    
    @property
    def is_cancelled(self) -> bool:
        return self._cancelled
    
    @property
    def reason(self) -> Optional[str]:
        return self._reason
    
    def on_cancel(self, callback: Callable[[], None]) -> None:
        """Register cancellation callback."""
        self._callbacks.append(callback)
        if self._cancelled:
            callback()


class StreamingProvider(ABC):
    """Base class for streaming-capable AI providers."""
    
    @property
    @abstractmethod
    def supports_streaming(self) -> bool:
        """Whether this provider supports real streaming."""
        pass
    
    @abstractmethod
    async def stream(
        self,
        prompt: str,
        model: Optional[str] = None,
        max_tokens: int = 4096,
        temperature: float = 0.2,
        cancel_token: Optional[CancellationToken] = None,
    ) -> AsyncIterator[StreamChunk]:
        """Stream response from provider."""
        pass
    
    async def batch(
        self,
        prompt: str,
        model: Optional[str] = None,
        max_tokens: int = 4096,
        temperature: float = 0.2,
    ) -> str:
        """Non-streaming fallback."""
        chunks = []
        async for chunk in self.stream(prompt, model, max_tokens, temperature):
            chunks.append(chunk.content)
        return "".join(chunks)


class OpenAIStreamer(StreamingProvider):
    """Real streaming implementation for OpenAI."""
    
    def __init__(self, api_key: Optional[str] = None):
        import os
        self.api_key = api_key or os.getenv("OPENAI_API_KEY")
        self._client = None
    
    @property
    def supports_streaming(self) -> bool:
        return True
    
    def _get_client(self):
        if self._client is None:
            from openai import AsyncOpenAI
            self._client = AsyncOpenAI(api_key=self.api_key)
        return self._client
    
    async def stream(
        self,
        prompt: str,
        model: Optional[str] = None,
        max_tokens: int = 4096,
        temperature: float = 0.2,
        cancel_token: Optional[CancellationToken] = None,
    ) -> AsyncIterator[StreamChunk]:
        client = self._get_client()
        model_name = model or "gpt-4o-mini"
        
        try:
            stream = await client.chat.completions.create(
                model=model_name,
                messages=[{"role": "user", "content": prompt}],
                max_tokens=max_tokens,
                temperature=temperature,
                stream=True,
                stream_options={"include_usage": True},
            )
            
            index = 0
            tokens = 0
            
            async for chunk in stream:
                # Check for cancellation
                if cancel_token and cancel_token.is_cancelled:
                    yield StreamChunk(
                        content="",
                        index=index,
                        is_final=True,
                        tokens_so_far=tokens,
                        finish_reason="cancelled",
                    )
                    return
                
                # Extract content
                delta = ""
                finish_reason = None
                
                if chunk.choices:
                    choice = chunk.choices[0]
                    if choice.delta and choice.delta.content:
                        delta = choice.delta.content
                    finish_reason = choice.finish_reason
                
                # Extract usage if available
                if chunk.usage:
                    tokens = chunk.usage.completion_tokens
                
                if delta or finish_reason:
                    yield StreamChunk(
                        content=delta,
                        index=index,
                        is_final=finish_reason is not None,
                        tokens_so_far=tokens,
                        finish_reason=finish_reason,
                    )
                    index += 1
                    
        except Exception as e:
            yield StreamChunk(
                content="",
                index=0,
                is_final=True,
                finish_reason=f"error: {type(e).__name__}: {e}",
            )


class GeminiStreamer(StreamingProvider):
    """Real streaming implementation for Google Gemini."""
    
    def __init__(self, api_key: Optional[str] = None):
        import os
        self.api_key = api_key or os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
        self._client = None
    
    @property
    def supports_streaming(self) -> bool:
        return True
    
    def _get_client(self):
        if self._client is None:
            import google.generativeai as genai
            genai.configure(api_key=self.api_key)
            self._client = genai
        return self._client
    
    async def stream(
        self,
        prompt: str,
        model: Optional[str] = None,
        max_tokens: int = 4096,
        temperature: float = 0.2,
        cancel_token: Optional[CancellationToken] = None,
    ) -> AsyncIterator[StreamChunk]:
        genai = self._get_client()
        model_name = model or "gemini-1.5-flash"
        
        try:
            model_instance = genai.GenerativeModel(
                model_name,
                generation_config={
                    "max_output_tokens": max_tokens,
                    "temperature": temperature,
                }
            )
            
            # Gemini uses sync streaming, wrap in executor
            response = await asyncio.get_event_loop().run_in_executor(
                None,
                lambda: model_instance.generate_content(prompt, stream=True)
            )
            
            index = 0
            
            for chunk in response:
                # Check cancellation
                if cancel_token and cancel_token.is_cancelled:
                    yield StreamChunk(
                        content="",
                        index=index,
                        is_final=True,
                        finish_reason="cancelled",
                    )
                    return
                
                text = ""
                if hasattr(chunk, 'text'):
                    text = chunk.text
                elif hasattr(chunk, 'parts'):
                    text = "".join(p.text for p in chunk.parts if hasattr(p, 'text'))
                
                if text:
                    yield StreamChunk(
                        content=text,
                        index=index,
                        is_final=False,
                    )
                    index += 1
            
            # Final chunk
            yield StreamChunk(
                content="",
                index=index,
                is_final=True,
                finish_reason="stop",
            )
            
        except Exception as e:
            yield StreamChunk(
                content="",
                index=0,
                is_final=True,
                finish_reason=f"error: {type(e).__name__}: {e}",
            )


class BatchFallbackStreamer(StreamingProvider):
    """Fake streaming that wraps a batch call for providers without streaming."""
    
    def __init__(self, batch_fn: Callable):
        self._batch_fn = batch_fn
    
    @property
    def supports_streaming(self) -> bool:
        return False
    
    async def stream(
        self,
        prompt: str,
        model: Optional[str] = None,
        max_tokens: int = 4096,
        temperature: float = 0.2,
        cancel_token: Optional[CancellationToken] = None,
    ) -> AsyncIterator[StreamChunk]:
        # Get full response
        result = await self._batch_fn(prompt, model, max_tokens, temperature)
        
        # Yield as chunks to simulate streaming
        chunk_size = 50  # Characters per chunk
        index = 0
        
        for i in range(0, len(result), chunk_size):
            if cancel_token and cancel_token.is_cancelled:
                yield StreamChunk(
                    content="",
                    index=index,
                    is_final=True,
                    finish_reason="cancelled",
                )
                return
            
            chunk_text = result[i:i + chunk_size]
            is_final = i + chunk_size >= len(result)
            
            yield StreamChunk(
                content=chunk_text,
                index=index,
                is_final=is_final,
                finish_reason="stop" if is_final else None,
            )
            index += 1
            
            # Small delay to simulate streaming
            await asyncio.sleep(0.01)


class StreamingManager:
    """Manages streaming with provider fallback and progress tracking."""
    
    def __init__(self):
        self._providers: Dict[str, StreamingProvider] = {}
        self._active_streams: Dict[str, CancellationToken] = {}
    
    def register_provider(self, name: str, provider: StreamingProvider) -> None:
        """Register a streaming provider."""
        self._providers[name] = provider
    
    def get_provider(self, name: str) -> Optional[StreamingProvider]:
        """Get a provider by name."""
        return self._providers.get(name)
    
    async def stream_with_progress(
        self,
        provider_name: str,
        prompt: str,
        stream_id: str,
        on_progress: Optional[Callable[[StreamingProgress], None]] = None,
        **kwargs,
    ) -> StreamingResult:
        """Stream with progress tracking and cancellation support."""
        provider = self._providers.get(provider_name)
        if not provider:
            return StreamingResult(
                status=StreamingStatus.FAILED,
                content="",
                chunks=[],
                total_tokens=0,
                duration_ms=0,
                error=f"Unknown provider: {provider_name}",
            )
        
        cancel_token = CancellationToken()
        self._active_streams[stream_id] = cancel_token
        
        progress = StreamingProgress()
        chunks: List[StreamChunk] = []
        content_parts: List[str] = []
        
        start_time = time.time()
        
        try:
            async for chunk in provider.stream(prompt, cancel_token=cancel_token, **kwargs):
                chunks.append(chunk)
                content_parts.append(chunk.content)
                progress.update(chunk)
                
                if on_progress:
                    on_progress(progress)
                
                if chunk.is_final:
                    break
            
            # Determine final status
            if cancel_token.is_cancelled:
                status = StreamingStatus.CANCELLED
            elif chunks and chunks[-1].finish_reason and "error" in chunks[-1].finish_reason:
                status = StreamingStatus.FAILED
            else:
                status = StreamingStatus.COMPLETED
            
            return StreamingResult(
                status=status,
                content="".join(content_parts),
                chunks=chunks,
                total_tokens=progress.tokens_received,
                duration_ms=(time.time() - start_time) * 1000,
                cancelled_at=len(chunks) - 1 if status == StreamingStatus.CANCELLED else None,
            )
            
        except Exception as e:
            return StreamingResult(
                status=StreamingStatus.FAILED,
                content="".join(content_parts),
                chunks=chunks,
                total_tokens=progress.tokens_received,
                duration_ms=(time.time() - start_time) * 1000,
                error=f"{type(e).__name__}: {e}",
            )
        finally:
            self._active_streams.pop(stream_id, None)
    
    def cancel_stream(self, stream_id: str, reason: str = "User cancelled") -> bool:
        """Cancel an active stream."""
        if stream_id in self._active_streams:
            self._active_streams[stream_id].cancel(reason)
            return True
        return False
    
    def get_active_streams(self) -> List[str]:
        """Get IDs of active streams."""
        return list(self._active_streams.keys())


# Global streaming manager instance
_streaming_manager: Optional[StreamingManager] = None


def get_streaming_manager() -> StreamingManager:
    """Get or create the global streaming manager."""
    global _streaming_manager
    if _streaming_manager is None:
        _streaming_manager = StreamingManager()
        
        # Register default providers
        try:
            _streaming_manager.register_provider("openai", OpenAIStreamer())
        except Exception:
            pass
        
        try:
            _streaming_manager.register_provider("gemini", GeminiStreamer())
        except Exception:
            pass
    
    return _streaming_manager

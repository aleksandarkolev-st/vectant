"""
Tracing primitives for the RAG pipeline.

The pipeline previously emitted timing as `logger.info` strings — readable
for humans but unparseable by log aggregators and unable to nest. This
module introduces:

  - Span: a single timed operation with attributes + child spans.
  - Tracer: collects spans into a tree and emits them as either:
      * OpenTelemetry spans (when `opentelemetry` is importable AND a global
        tracer provider is configured), or
      * Structured `extra={"rag_trace": ...}` log lines + `RAGResult.trace`.

OpenTelemetry binding is best-effort and silent on failure. The tree is
always attached to the result so callers without an OTEL collector still
get full pipeline observability.

Usage:
    tracer = Tracer.create()
    with tracer.span("rag.query", attrs={"query_len": len(text)}):
        with tracer.span("rag.macro"):
            ...
    print(tracer.to_dict())
"""

from __future__ import annotations

import contextlib
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Dict, Iterator, List, Optional


logger = logging.getLogger("code_intel.rag.observability")


# Lazily resolved OpenTelemetry tracer — None when otel isn't installed.
def _get_otel_tracer():
    try:
        from opentelemetry import trace as _ot_trace  # type: ignore
    except Exception:
        return None
    try:
        return _ot_trace.get_tracer("code_intel.rag")
    except Exception:
        return None


@dataclass
class Span:
    """A single timed operation within the pipeline trace tree."""
    name: str
    start_ms: float
    end_ms: float = 0.0
    attributes: Dict[str, Any] = field(default_factory=dict)
    children: List["Span"] = field(default_factory=list)
    error: Optional[str] = None
    events: List[Dict[str, Any]] = field(default_factory=list)

    @property
    def duration_ms(self) -> float:
        return max(0.0, self.end_ms - self.start_ms)

    def add_event(self, name: str, **attrs: Any) -> None:
        """Attach a point-in-time event (e.g. a cache miss/hit decision)."""
        self.events.append({
            "name": name,
            "ts_ms": time.time() * 1000.0,
            "attributes": dict(attrs),
        })

    def set_attribute(self, key: str, value: Any) -> None:
        """Update a span attribute. Safe to call after the span ended."""
        self.attributes[key] = value

    def to_dict(self) -> Dict[str, Any]:
        d: Dict[str, Any] = {
            "name": self.name,
            "duration_ms": round(self.duration_ms, 3),
            "attributes": self.attributes,
            "children": [c.to_dict() for c in self.children],
        }
        if self.events:
            d["events"] = self.events
        if self.error is not None:
            d["error"] = self.error
        return d


class Tracer:
    """
    Per-call tracer.

    Not thread-safe by design — each pipeline call (query/ingest/...) gets
    its own Tracer. The `span()` context manager pushes/pops onto a stack;
    use the same Tracer instance throughout one logical call.

    `NULL_TRACER` is a no-op singleton that satisfies the same API; pass it
    when tracing is disabled so call sites stay unconditional.
    """

    def __init__(self, *, enabled: bool = True):
        self._enabled = enabled
        self.root: Optional[Span] = None
        self._stack: List[Span] = []
        self._otel_tracer = _get_otel_tracer() if enabled else None
        self._otel_spans: List[Any] = []

    @classmethod
    def create(cls, *, enabled: bool = True) -> "Tracer":
        return cls(enabled=enabled)

    @property
    def enabled(self) -> bool:
        return self._enabled

    @contextlib.contextmanager
    def span(
        self,
        name: str,
        attrs: Optional[Dict[str, Any]] = None,
    ) -> Iterator[Span]:
        """Push a span on the stack. Exit closes the span and (if otel is
        configured) ends the corresponding OpenTelemetry span.
        """
        if not self._enabled:
            yield Span(name=name, start_ms=time.time() * 1000.0)
            return

        span_obj = Span(
            name=name,
            start_ms=time.time() * 1000.0,
            attributes=dict(attrs or {}),
        )

        # Attach to parent or as root.
        if self._stack:
            self._stack[-1].children.append(span_obj)
        else:
            self.root = span_obj
        self._stack.append(span_obj)

        # OpenTelemetry mirror.
        ot_span = None
        if self._otel_tracer is not None:
            try:
                ot_span = self._otel_tracer.start_span(name)
                for k, v in (attrs or {}).items():
                    try:
                        ot_span.set_attribute(k, v)
                    except Exception:
                        pass
                self._otel_spans.append(ot_span)
            except Exception:
                ot_span = None

        try:
            yield span_obj
        except Exception as e:
            span_obj.error = f"{type(e).__name__}: {e}"
            if ot_span is not None:
                try:
                    ot_span.record_exception(e)
                    from opentelemetry.trace.status import (  # type: ignore
                        Status, StatusCode,
                    )
                    ot_span.set_status(Status(StatusCode.ERROR, str(e)))
                except Exception:
                    pass
            raise
        finally:
            span_obj.end_ms = time.time() * 1000.0
            self._stack.pop()
            if ot_span is not None:
                # Mirror final attributes (some are set after start).
                for k, v in span_obj.attributes.items():
                    try:
                        ot_span.set_attribute(k, v)
                    except Exception:
                        pass
                try:
                    ot_span.end()
                except Exception:
                    pass

    def current(self) -> Optional[Span]:
        """Return the innermost active span, or None."""
        return self._stack[-1] if self._stack else None

    def add_event(self, name: str, **attrs: Any) -> None:
        """Convenience: add an event to the current span if any."""
        cur = self.current()
        if cur is not None:
            cur.add_event(name, **attrs)

    def set_attribute(self, key: str, value: Any) -> None:
        """Convenience: set attribute on the current span if any."""
        cur = self.current()
        if cur is not None:
            cur.set_attribute(key, value)

    def to_dict(self) -> Optional[Dict[str, Any]]:
        return self.root.to_dict() if self.root else None

    def emit_log(
        self,
        log: Optional[logging.Logger] = None,
        *,
        level: int = logging.INFO,
        message: str = "rag_trace",
    ) -> None:
        """Emit the assembled trace as a single structured log line.

        Skips when no spans were recorded. The log record carries the trace
        in `extra={"rag_trace": ...}` so structured-log aggregators can
        index it as JSON.
        """
        if self.root is None:
            return
        target = log or logger
        try:
            target.log(level, message, extra={"rag_trace": self.to_dict()})
        except Exception:
            # Some logging configurations reject `extra` keys that collide
            # with reserved record fields. Fall back to a raw repr so the
            # operator at least sees the trace shape.
            target.log(level, f"{message} {self.to_dict()}")


class _NullTracer(Tracer):
    """No-op tracer that satisfies the API but records nothing."""

    def __init__(self):  # noqa: D401 — explicit signature override
        super().__init__(enabled=False)

    @contextlib.contextmanager
    def span(self, name: str, attrs=None) -> Iterator[Span]:
        yield Span(name=name, start_ms=0.0)

    def add_event(self, name: str, **attrs: Any) -> None:
        pass

    def set_attribute(self, key: str, value: Any) -> None:
        pass

    def to_dict(self) -> Optional[Dict[str, Any]]:
        return None

    def emit_log(self, log=None, *, level=logging.INFO, message="rag_trace") -> None:
        pass


NULL_TRACER = _NullTracer()

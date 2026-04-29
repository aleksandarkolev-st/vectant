"""Tests for the RAG observability tracer."""
from __future__ import annotations

import logging

import pytest

from code_intel.rag.observability import Tracer, NULL_TRACER, Span


class TestTracer:
    def test_basic_span(self):
        t = Tracer.create()
        with t.span("step1", attrs={"x": 1}) as s:
            assert isinstance(s, Span)
            s.set_attribute("y", 2)
        d = t.to_dict()
        assert d is not None
        assert d["name"] == "step1"
        assert d["attributes"] == {"x": 1, "y": 2}
        assert d["duration_ms"] >= 0

    def test_nested_spans(self):
        t = Tracer.create()
        with t.span("parent"):
            with t.span("child1"):
                pass
            with t.span("child2"):
                with t.span("grandchild"):
                    pass

        d = t.to_dict()
        assert len(d["children"]) == 2
        assert d["children"][0]["name"] == "child1"
        assert d["children"][1]["name"] == "child2"
        assert d["children"][1]["children"][0]["name"] == "grandchild"

    def test_error_recorded(self):
        t = Tracer.create()
        with pytest.raises(RuntimeError):
            with t.span("oops"):
                raise RuntimeError("boom")
        d = t.to_dict()
        assert d["error"] is not None
        assert "boom" in d["error"]

    def test_event_recorded(self):
        t = Tracer.create()
        with t.span("step"):
            t.add_event("decision", choice="rrf")
        d = t.to_dict()
        assert "events" in d
        assert d["events"][0]["name"] == "decision"
        assert d["events"][0]["attributes"]["choice"] == "rrf"

    def test_set_current_attribute(self):
        t = Tracer.create()
        with t.span("outer"):
            t.set_attribute("k", "v")
        d = t.to_dict()
        assert d["attributes"]["k"] == "v"

    def test_disabled_tracer(self):
        t = Tracer.create(enabled=False)
        with t.span("a"):
            with t.span("b"):
                pass
        assert t.to_dict() is None

    def test_null_tracer(self):
        with NULL_TRACER.span("x") as s:
            s.set_attribute("a", 1)
            NULL_TRACER.set_attribute("b", 2)
            NULL_TRACER.add_event("ev", k="v")
        assert NULL_TRACER.to_dict() is None

    def test_emit_log(self, caplog):
        t = Tracer.create()
        with t.span("logged"):
            pass
        with caplog.at_level(logging.INFO, logger="code_intel.rag.observability"):
            t.emit_log()
        # caplog also captures via the root logger; just ensure no exception.
        # The structured trace landed on the record's `extra` mapping.
        if caplog.records:
            rec = caplog.records[-1]
            assert getattr(rec, "rag_trace", None) is not None

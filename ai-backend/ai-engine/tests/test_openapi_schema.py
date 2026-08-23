from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def test_ai_engine_generates_openapi_schema_with_runtime_healing_request():
    from main import app

    schema = app.openapi()

    assert "/heal/ai/runtime" in schema["paths"]
    assert "AIRuntimeErrorRequest" in schema["components"]["schemas"]

"""Community-app submission risk review (Phase 2, advisory).

Calls the configured LLM provider (Gemini via get_provider) to score a
submission that has ALREADY passed the Phase-1 hard gates + CVE scan. This is
advisory only — never a load-bearing security control. Fail-closed: any
provider/parse failure returns max risk so the orchestrator routes to manual
review rather than auto-approving on a degraded signal.

`get_provider` is imported lazily (inside the function, only when no provider is
injected) so this module — and its unit tests with a fake provider — import
cleanly without the heavy Gemini SDK installed.
"""

from __future__ import annotations

import json
import re
from typing import Any, Mapping, Optional

_FENCE_RE = re.compile(r"```(?:json)?\s*(\{.*?\})\s*```", re.DOTALL)
_OBJ_RE = re.compile(r"\{.*\}", re.DOTALL)

_FAIL_CLOSED = {
    "risk_score": 1.0,
    "flags": ["ai_unavailable"],
    "rationale": "AI review unavailable; routed to manual review.",
}

_PROMPT = """You are a security reviewer for a marketplace of community apps that run \
inside an isolated per-user sandbox. The app below already passed automated hard gates \
(manifest schema, scope allow-list, host-escape rejection) and a CVE scan. Assess the \
RESIDUAL risk of auto-publishing it without a human reviewer.

Return ONLY a JSON object: {{"risk_score": <float 0..1>, "flags": [<short strings>], "rationale": "<one sentence>"}}.
risk_score 0 = clearly safe, 1 = clearly dangerous. Add a flag for anything suspicious \
(obfuscation, data exfiltration hints, crypto-mining, deceptive metadata, over-broad behavior).

Manifest:
{manifest}

CVE scan summary:
{scan_summary}

Publisher description:
{description}
"""


def _build_prompt(payload: Mapping[str, Any]) -> str:
    return _PROMPT.format(
        manifest=json.dumps(payload.get("manifest") or {}, ensure_ascii=False)[:8000],
        scan_summary=json.dumps(payload.get("scan_summary") or {}, ensure_ascii=False)[:2000],
        description=str(payload.get("description") or "")[:2000],
    )


def _extract_json(text: str) -> Optional[dict]:
    if not isinstance(text, str):
        return None
    for rx in (_FENCE_RE, _OBJ_RE):
        m = rx.search(text)
        if m:
            try:
                obj = json.loads(m.group(1) if rx is _FENCE_RE else m.group(0))
                if isinstance(obj, dict):
                    return obj
            except (ValueError, TypeError):
                continue
    return None


def _normalize(obj: dict) -> dict:
    try:
        score = float(obj.get("risk_score"))
    except (TypeError, ValueError):
        score = 1.0
    score = max(0.0, min(1.0, score))
    flags = obj.get("flags")
    flags = [str(f) for f in flags] if isinstance(flags, list) else []
    rationale = obj.get("rationale")
    rationale = rationale if isinstance(rationale, str) else str(rationale or "")
    return {"risk_score": score, "flags": flags, "rationale": rationale[:1000]}


async def assess_program_risk(payload: Mapping[str, Any], provider: Optional[Any] = None) -> dict:
    """Score a submission. Fail-closed (max risk) on any provider/parse failure."""
    if provider is None:
        from llm.providers import get_provider  # lazy: avoid importing the Gemini SDK at module load
        provider = get_provider()
    try:
        reply = await provider.ask_llm(code="", lang="json", prompt=_build_prompt(payload), mode="rule_translate")
    except Exception:  # noqa: BLE001 — advisory layer must never raise into the gate
        return dict(_FAIL_CLOSED)
    obj = _extract_json(reply)
    if obj is None:
        return dict(_FAIL_CLOSED)
    return _normalize(obj)

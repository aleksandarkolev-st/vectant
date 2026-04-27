"""Pedantry filter on top of the Critic. Master plan §6.3.

For every non-executable Critic attack (kinds: type, race, perf,
security, import — basically anything we couldn't run a reproducer
for), the Critic-Critic asks a cheap fast model whether the attack
is *actionable for this project* given the detected signals.

Pedantic attacks are demoted to severity=low and never trigger a
revision. They still show up in the evidence bundle as informational
notes so the user can audit what the LLM thought was wrong.

Determinism note: like the Critic, the Critic-Critic ships a
deterministic baseline so the pipeline is exercisable without an LLM.
The baseline applies a small ruleset (security attacks on hobby
scripts, perf attacks on web-apps with <100 LOC, import attacks
without missing-module evidence) so tests don't depend on a live
provider.
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from .critic import Attack, CritiqueResult
from .project_signals import ProjectSignals

logger = logging.getLogger("shadow.critic_critic")

# Hard latency budget — Haiku/Flash should answer in <2s; if we hit this
# we ship the deterministic verdict and move on.
_LLM_TIMEOUT_SEC = 4.0


@dataclass
class Verdict:
    actionable: bool
    reason: str
    source: str  # "deterministic" | "llm" | "timeout"


def filter_pedantic(
    crit: CritiqueResult,
    signals: ProjectSignals,
) -> CritiqueResult:
    """Synchronous deterministic pass. Demotes pedantic attacks in place.

    Pedantic attacks have their severity floored at "low" and a note
    appended explaining why. The CritiqueResult is returned unchanged
    aside from the in-place mutations so callers can tee it directly
    into the score + evidence path.
    """
    for a in crit.attacks:
        # Diagnostics-derived attacks have real=True and a runner-grounded
        # reproducer ("type=trace") — they are by definition actionable.
        if (a.reproducer or {}).get("type") == "trace":
            continue
        # Executable attacks already adjudicated via reproducer.
        if a.real is True:
            continue
        verdict = _deterministic_verdict(a, signals)
        if not verdict.actionable:
            _demote(a, verdict.reason, source=verdict.source)
    return crit


async def filter_pedantic_with_llm(
    crit: CritiqueResult,
    signals: ProjectSignals,
    *,
    provider: str,
    api_key: Optional[str],
    model: str,
) -> CritiqueResult:
    """Two-stage filter: run the deterministic pass first, then ask the
    fast model about anything it didn't already demote. Keeps the LLM
    call count bounded by `MAX_ATTACKS` (5) per universe, in the worst
    case.
    """
    crit = filter_pedantic(crit, signals)
    pending = [
        a for a in crit.attacks
        if not (a.note or "").startswith("[critic-critic]")
        and a.real is not True
        and (a.reproducer or {}).get("type") != "trace"
    ]
    if not pending:
        return crit

    try:
        from llm.providers.factory import get_provider
        prov = get_provider(provider)
    except Exception as e:
        logger.warning("critic-critic LLM unavailable (%s) — keeping deterministic verdicts", e)
        return crit

    sig_blob = json.dumps(signals.to_dict(), separators=(",", ":"))
    coros = []
    for a in pending:
        prompt = _llm_prompt(a, sig_blob)
        coros.append(_ask(prov, model, api_key, prompt))

    try:
        results = await asyncio.wait_for(
            asyncio.gather(*coros, return_exceptions=True),
            timeout=_LLM_TIMEOUT_SEC * max(1, len(pending) / 2),
        )
    except asyncio.TimeoutError:
        logger.info("critic-critic timed out after %.1fs", _LLM_TIMEOUT_SEC)
        return crit

    for a, raw in zip(pending, results):
        if isinstance(raw, Exception) or not isinstance(raw, str):
            continue
        verdict = _parse_llm_verdict(raw)
        if verdict is None:
            continue
        if not verdict.actionable:
            _demote(a, verdict.reason, source="llm")
    return crit


# ---------------------------------------------------------------------------
# Deterministic ruleset — bounded list of "we know this is pedantic" cases.
# Each rule must be conservative: the cost of false-negative (keeping a
# pedantic attack) is just a noisier UI; the cost of false-positive
# (demoting a real attack) is silently dropping a real bug. We err
# heavily toward false-negative.
# ---------------------------------------------------------------------------

def _deterministic_verdict(a: Attack, sig: ProjectSignals) -> Verdict:
    if a.kind == "perf" and sig.project_type in ("hobby", "library"):
        return Verdict(False, f"perf concern in {sig.project_type} project", "deterministic")
    if a.kind == "security" and sig.project_type == "hobby" and not sig.has_ci:
        return Verdict(False, "security pedantry in hobby script (no CI)", "deterministic")
    if a.kind == "import":
        # Import-kind attacks should already point at a missing module name.
        msg = (a.msg or "").lower()
        if "missing" not in msg and "not found" not in msg and "no module named" not in msg:
            return Verdict(False, "import attack without missing-module evidence", "deterministic")
    if a.kind == "race" and "asyncio" not in (a.msg or "").lower() and "thread" not in (a.msg or "").lower():
        return Verdict(False, "race attack without concurrency primitives in evidence", "deterministic")
    return Verdict(True, "no deterministic rule fired", "deterministic")


def _demote(a: Attack, reason: str, *, source: str) -> None:
    a.severity = "low"
    note = f"[critic-critic:{source}] {reason}"
    a.note = f"{a.note} | {note}".strip(" |") if a.note else note


def _llm_prompt(a: Attack, sig_blob: str) -> str:
    return (
        "You are a senior code reviewer evaluating whether an attack on a "
        "code patch is *actionable for this project* or pedantic noise.\n\n"
        f"Project signals: {sig_blob}\n\n"
        "Attack:\n"
        f"  kind: {a.kind}\n"
        f"  severity: {a.severity}\n"
        f"  msg: {a.msg}\n"
        f"  reproducer: {json.dumps(a.reproducer or {}, separators=(',', ':'))}\n\n"
        'Answer ONLY with strict JSON: {"verdict": "actionable" | "pedantic", "reason": "..."}\n'
        "Pedantic = generic best-practice that doesn't apply, theoretical concern with no\n"
        "reproducer, enterprise concern in a hobby project, style nit."
    )


async def _ask(provider, model: str, api_key: Optional[str], prompt: str) -> Optional[str]:
    try:
        return await provider.ask_llm(
            code="", lang="python",
            prompt=prompt,
            model=model, api_key=api_key,
        )
    except Exception as e:
        logger.debug("critic-critic LLM call failed: %s", e)
        return None


def _parse_llm_verdict(raw: str) -> Optional[Verdict]:
    text = (raw or "").strip()
    if text.startswith("```"):
        text = text.strip("`")
        if "\n" in text:
            text = text.split("\n", 1)[1]
        if text.endswith("```"):
            text = text[:-3]
    try:
        data = json.loads(text)
    except Exception:
        return None
    verdict = (data.get("verdict") or "").lower()
    reason = data.get("reason") or "unspecified"
    if verdict not in ("actionable", "pedantic"):
        return None
    return Verdict(actionable=(verdict == "actionable"), reason=reason, source="llm")

"""Cross-universe Arbiter. Master plan §6.4 + §11.

Responsibilities:
  * Build a *compressed evidence bundle* from the per-universe results
    (diffs only, failure-only detail, sandwich pattern).
  * Pick an Arbiter provider distinct from every Generator and Critic
    in the run (rotation by least-used).
  * Call the LLM with a strict JSON schema; validate the response.
  * Re-prompt once on validation failure; otherwise fall back to the
    deterministic top-of-score winner.

Hard guards (master plan §6.4):
  - schema requires single winner; no sycophancy.
  - rationale must reference at least one concrete data point.
  - picking a universe with failing tests requires an explicit warning.
  - confidence < 0.6 → UI shows "Arbiter is uncertain — review all".
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence

from .universe import UniverseResult
from .project_signals import ProjectSignals

logger = logging.getLogger("shadow.arbiter")

_KNOWN_PROVIDERS = ["anthropic", "openai", "gemini"]
_PROVIDER_ARBITER_MODEL = {
    "anthropic": "claude-sonnet-4-6",
    "openai":    "gpt-4o",
    "gemini":    "gemini-pro",
}
_LLM_TIMEOUT_SEC = 8.0
_MAX_DIFF_LINES = 60  # diff truncation per universe in compressed bundle
_MAX_FAILED_ATTACKS = 4

# Confidence the UI uses to render "Arbiter is uncertain — review all".
LOW_CONFIDENCE_THRESHOLD = 0.6


# ---------------------------------------------------------------------------
# Provider rotation
# ---------------------------------------------------------------------------

def select_arbiter_provider(
    universes: Sequence[Any],
    *,
    forbid_in_run: bool = True,
) -> str:
    """Pick the least-used provider across universe (gen, critic) pairs.

    `universes` items must expose `.spec.provider_gen` and
    `.spec.provider_critic` attributes (Universe / UniverseResult both
    qualify if we pass UniverseResult.evidence... actually evidence
    only stores model strings). We accept either UniverseResult or
    UniverseSpec — see callers for plumbing.
    """
    counts: Dict[str, int] = {p: 0 for p in _KNOWN_PROVIDERS}
    for u in universes:
        prov_g = getattr(u, "provider_gen", None)
        prov_c = getattr(u, "provider_critic", None)
        if not prov_g and hasattr(u, "spec"):
            prov_g = getattr(u.spec, "provider_gen", None)
            prov_c = getattr(u.spec, "provider_critic", None)
        if prov_g in counts:
            counts[prov_g] += 1
        if prov_c in counts:
            counts[prov_c] += 1

    # Filter out providers actually used iff the run leaves at least one
    # untouched provider. Otherwise (rare: anthropic+openai+gemini all in
    # play) pick the least-used among them.
    if forbid_in_run:
        unused = [p for p, n in counts.items() if n == 0]
        if unused:
            return unused[0]
    return min(counts, key=lambda p: counts[p])


def model_for_arbiter(provider: str) -> str:
    return _PROVIDER_ARBITER_MODEL.get(provider, "gemini-pro")


# ---------------------------------------------------------------------------
# Compressed evidence bundle (master plan §11)
# ---------------------------------------------------------------------------

def build_evidence_bundle(
    *,
    user_request: str,
    intent: str,
    signals: ProjectSignals,
    universes: List[UniverseResult],
) -> Dict[str, Any]:
    """Compress per-universe evidence into the Arbiter input. Diff-only,
    failure-only, count-only — see §11 for the encoder rules.
    """
    return {
        "request": _truncate(user_request, 480),
        "intent": intent,
        "project_signals": signals.to_dict() if signals else {},
        "universes": [_compress_universe(u) for u in universes],
        # Sandwich pattern: per-universe summary at start AND at end, so
        # the LLM sees the same data twice from opposite directions and
        # is less likely to "lose" universe B in the middle of the bundle.
        "summary": [_summary_line(u) for u in universes],
    }


def _compress_universe(u: UniverseResult) -> Dict[str, Any]:
    ev = u.evidence or {}
    diag = ev.get("diagnostics") or {}
    attacks = ev.get("attacks") or {"tested": 0, "survived": 0, "failed": []}

    # Diff is reconstructed from the patches' before/after — kept as a
    # unified-diff-ish summary capped at _MAX_DIFF_LINES.
    diff_text = _make_compact_diff(u)

    failed = list(attacks.get("failed") or [])[:_MAX_FAILED_ATTACKS]

    return {
        "id": u.universe_id,
        "style": ev.get("style"),
        "model_pair": ev.get("model_pair"),
        "diff": diff_text,
        "diagnostics": _compress_diagnostics(diag),
        "attacks": {
            "tested":  attacks.get("tested", 0),
            "survived": attacks.get("survived", 0),
            "failed":   failed,
        },
        "loc": ev.get("loc", "+0 −0"),
        "score": ev.get("score", 0.0),
        "revised": ev.get("revised", False),
        "rejected": ev.get("rejected"),
    }


def _compress_diagnostics(diag: Dict[str, Any]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for cat, val in diag.items():
        if val == "clean" or val == "skipped":
            out[cat] = val
        elif isinstance(val, list):
            # Only the first 3 errors per category — Arbiter doesn't need
            # exhaustive lists.
            out[cat] = val[:3]
        else:
            out[cat] = val
    return out


def _make_compact_diff(u: UniverseResult) -> str:
    lines: List[str] = []
    for p in u.patches_applied[:6]:  # cap at 6 files
        before = (p.original or "").splitlines()
        after = (p.new_content or "").splitlines()
        lines.append(f"--- a/{p.path}")
        lines.append(f"+++ b/{p.path}")
        # Cheap line-by-line emit; not full unified diff — enough to feed
        # the Arbiter's pattern-matching without parsing burden.
        for ln in before[:_MAX_DIFF_LINES // 2]:
            lines.append(f"-{ln}")
        for ln in after[:_MAX_DIFF_LINES // 2]:
            lines.append(f"+{ln}")
    if len(lines) > _MAX_DIFF_LINES * 2:
        lines = lines[:_MAX_DIFF_LINES * 2] + ["… (truncated)"]
    return "\n".join(lines)


def _summary_line(u: UniverseResult) -> str:
    ev = u.evidence or {}
    attacks = ev.get("attacks") or {"tested": 0, "survived": 0}
    return (
        f"{u.universe_id} | style={ev.get('style')} | "
        f"score={ev.get('score', 0)} | "
        f"attacks {attacks.get('survived',0)}/{attacks.get('tested',0)} survived | "
        f"loc {ev.get('loc','?')}"
    )


def _truncate(text: str, n: int) -> str:
    if not text:
        return ""
    return text[:n] + ("…" if len(text) > n else "")


# ---------------------------------------------------------------------------
# Verdict — strict schema + validator
# ---------------------------------------------------------------------------

@dataclass
class Verdict:
    winner: str
    confidence: float
    rationale: str
    ranking: List[str]
    tradeoffs: List[Dict[str, str]]
    warnings: List[str]
    synthesis: Dict[str, Any]
    source: str  # "llm" | "deterministic-fallback"

    def to_dict(self) -> Dict[str, Any]:
        return {
            "winner": self.winner,
            "confidence": self.confidence,
            "rationale": self.rationale,
            "ranking": self.ranking,
            "tradeoffs": self.tradeoffs,
            "warnings": self.warnings,
            "synthesis": self.synthesis,
            "source": self.source,
        }


async def adjudicate(
    *,
    bundle: Dict[str, Any],
    universes: List[UniverseResult],
    provider: str,
    api_key: Optional[str],
    model: str,
) -> Verdict:
    """Full Arbiter call. On any failure path, fall back to a
    deterministic top-of-score winner so the orchestrator always has
    *something* to render.
    """
    valid_ids = [u.universe_id for u in universes if u.score > 0]
    if not valid_ids:
        # Nothing scored: pick whichever is listed first, no recommendation.
        first = universes[0].universe_id if universes else "?"
        return _fallback(universes, reason="no scoreable universe", first=first)

    if len(valid_ids) == 1:
        only = valid_ids[0]
        return Verdict(
            winner=only, confidence=0.99,
            rationale="Only one universe produced a scoreable patch.",
            ranking=[only],
            tradeoffs=[],
            warnings=[],
            synthesis={"recommended": False, "explanation": None, "instruction": None},
            source="deterministic-fallback",
        )

    try:
        from llm.providers.factory import get_provider
        prov = get_provider(provider)
    except Exception as e:
        logger.warning("arbiter provider unavailable (%s) — using fallback", e)
        return _fallback(universes, reason="provider unavailable",
                         first=_top_by_score(universes))

    prompt = _arbiter_prompt(bundle)
    raw = await _ask(prov, model, api_key, prompt)
    verdict = _parse_and_validate(raw, universes)
    if verdict is None:
        # One re-prompt on validation failure (master plan §6.4).
        retry_prompt = prompt + "\n\nYour previous answer failed schema validation. " \
                                "Output ONLY valid JSON matching the schema above."
        raw2 = await _ask(prov, model, api_key, retry_prompt)
        verdict = _parse_and_validate(raw2, universes)
    if verdict is None:
        logger.info("arbiter LLM verdict unparseable — using deterministic fallback")
        return _fallback(universes, reason="schema validation failed",
                         first=_top_by_score(universes))
    return verdict


# ---------------------------------------------------------------------------
# LLM prompting + parsing
# ---------------------------------------------------------------------------

_SCHEMA_DESCRIPTION = """
Output ONLY valid JSON matching this schema (no prose before or after):
{
  "winner": "<universe id from the bundle>",
  "confidence": 0.0..1.0,
  "rationale": "<reference at least one concrete data point: a diagnostic, an attack, or a LOC value>",
  "ranking": ["A", "B", ...],
  "tradeoffs": [{"axis": "safety|simplicity|performance", "winner": "A"}, ...],
  "warnings": ["..."],
  "synthesis": {
    "recommended": false,
    "explanation": null,
    "instruction": null
  }
}

Hard rules:
- exactly one `winner`.
- if the winner has any failing test in `diagnostics`, you MUST include a
  warning that explicitly acknowledges it.
- confidence < 0.6 means "uncertain — review all"; only use confidence
  >= 0.6 if the evidence clearly favors one universe.
- tie-break on lower LOC delta when scores are within 0.05.
""".strip()


def _arbiter_prompt(bundle: Dict[str, Any]) -> str:
    body = json.dumps(bundle, indent=2)
    return (
        "You are the Arbiter — an impartial reviewer choosing the best patch from "
        "multiple AI-generated candidates. You see compressed evidence, not full "
        "files. Pick exactly one winner and ground your rationale in the evidence.\n\n"
        f"Evidence bundle:\n{body}\n\n"
        f"{_SCHEMA_DESCRIPTION}\n"
    )


async def _ask(provider, model: str, api_key: Optional[str], prompt: str) -> Optional[str]:
    try:
        return await asyncio.wait_for(
            provider.ask_llm(
                code="", lang="json",
                prompt=prompt,
                model=model, api_key=api_key,
            ),
            timeout=_LLM_TIMEOUT_SEC,
        )
    except asyncio.TimeoutError:
        logger.info("arbiter LLM call timed out after %.1fs", _LLM_TIMEOUT_SEC)
        return None
    except Exception as e:
        logger.debug("arbiter LLM call failed: %s", e)
        return None


def _parse_and_validate(
    raw: Optional[str],
    universes: List[UniverseResult],
) -> Optional[Verdict]:
    if not raw:
        return None
    text = raw.strip()
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
    return _validate(data, universes)


def _validate(data: Dict[str, Any], universes: List[UniverseResult]) -> Optional[Verdict]:
    valid_ids = {u.universe_id for u in universes}
    by_id = {u.universe_id: u for u in universes}

    winner = data.get("winner")
    if not isinstance(winner, str) or winner not in valid_ids:
        return None

    try:
        confidence = float(data.get("confidence", 0))
    except (TypeError, ValueError):
        return None
    confidence = max(0.0, min(1.0, confidence))

    rationale = (data.get("rationale") or "").strip()
    if len(rationale) < 20:
        return None
    if not _references_evidence(rationale):
        return None

    ranking = data.get("ranking") or [winner]
    if not isinstance(ranking, list) or not ranking:
        ranking = [winner]
    ranking = [r for r in ranking if r in valid_ids]
    if winner not in ranking:
        ranking.insert(0, winner)

    tradeoffs = data.get("tradeoffs") or []
    if not isinstance(tradeoffs, list):
        tradeoffs = []

    warnings = data.get("warnings") or []
    if not isinstance(warnings, list):
        warnings = []
    warnings = [w for w in warnings if isinstance(w, str)]

    # Hard guard: if the winner has failing tests, the verdict must
    # acknowledge it in `warnings`.
    if _has_failing_tests(by_id[winner]) and not _warning_mentions_tests(warnings):
        return None

    synthesis = data.get("synthesis") or {}
    if not isinstance(synthesis, dict):
        synthesis = {}
    synthesis = {
        "recommended": bool(synthesis.get("recommended", False)),
        "explanation": synthesis.get("explanation"),
        "instruction": synthesis.get("instruction"),
    }

    return Verdict(
        winner=winner, confidence=confidence,
        rationale=rationale,
        ranking=ranking,
        tradeoffs=tradeoffs,
        warnings=warnings,
        synthesis=synthesis,
        source="llm",
    )


def _references_evidence(rationale: str) -> bool:
    """Cheap proxy for "rationale references concrete data". Looks for
    a numeric token, a colon-prefixed term (lint:/types:), or one of
    the keywords from the bundle. Conservative — false negatives just
    trigger a re-prompt; false positives let weak rationales through.
    """
    rl = rationale.lower()
    if any(c.isdigit() for c in rl):
        return True
    keywords = ("lint", "types", "tests", "runtime", "attack",
                "score", "loc", "diff", "snapshot", "patch", "diagnostic")
    return any(k in rl for k in keywords)


def _has_failing_tests(u: UniverseResult) -> bool:
    diag = (u.evidence or {}).get("diagnostics") or {}
    tests = diag.get("tests")
    if not isinstance(tests, str):
        return False
    if "failed" in tests.lower() or "error" in tests.lower():
        return True
    if "/" in tests and "passed" in tests:
        try:
            passed_str, total_str = tests.split(" passed")[0].split("/")
            return int(passed_str) < int(total_str)
        except ValueError:
            return False
    return False


def _warning_mentions_tests(warnings: List[str]) -> bool:
    joined = " ".join(warnings).lower()
    return "test" in joined


def _top_by_score(universes: List[UniverseResult]) -> str:
    if not universes:
        return "?"
    # Tie-break on lower LOC delta when scores are within 0.05.
    sorted_us = sorted(
        universes,
        key=lambda u: (-u.score, _loc_delta_int(u))
    )
    return sorted_us[0].universe_id


def _loc_delta_int(u: UniverseResult) -> int:
    loc = (u.evidence or {}).get("loc", "+0 −0")
    total = 0
    for tok in loc.replace("−", "-").split():
        digits = "".join(c for c in tok if c.isdigit())
        if digits:
            total += int(digits)
    return total


def _fallback(universes: List[UniverseResult], *, reason: str, first: str) -> Verdict:
    ranking = [u.universe_id for u in sorted(universes, key=lambda u: -u.score)]
    if first not in ranking and ranking:
        ranking.insert(0, first)
    elif not ranking:
        ranking = [first]
    return Verdict(
        winner=first,
        confidence=0.5,
        rationale=f"Deterministic fallback: highest-score universe wins ({reason}).",
        ranking=ranking,
        tradeoffs=[],
        warnings=[f"arbiter fallback engaged: {reason}"],
        synthesis={"recommended": False, "explanation": None, "instruction": None},
        source="deterministic-fallback",
    )

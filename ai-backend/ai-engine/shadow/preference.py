"""Few-shot preference learning. Master plan §13 (Wave 4).

Replaces the EMA-vector approach: per `(user, repo)` we keep a rolling
list of the last N (default 8) accepted patches as structured examples.
At Generator time the most-similar 2-3 entries (by request-summary
keyword overlap) are surfaced as in-context few-shot. Storage is trivial
file-backed JSON next to the regression log.
"""

from __future__ import annotations

import json
import logging
import re
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

logger = logging.getLogger("shadow.preference")

DEFAULT_KEEP = 8
DIFF_CHAR_CAP = 4_000  # truncate accepted_diff to keep storage cheap
TOP_K_FEW_SHOT = 3


@dataclass
class PreferenceExample:
    request_summary: str
    accepted_diff: str
    style: str
    model_pair: List[Optional[str]]
    loc: str
    ts: float
    universe_id: Optional[str] = None
    arbiter_winner: Optional[bool] = None  # was this the Arbiter's pick?
    user_overrode: bool = False             # did the user pick a different one?

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


# ---------------------------------------------------------------------------
# Storage layout
# ---------------------------------------------------------------------------

def _store_dir(repo: Path, user_id: Optional[str]) -> Path:
    user = (user_id or "_anon").replace("/", "_").replace("..", "_")
    d = repo / ".shadow" / "preference" / user
    d.mkdir(parents=True, exist_ok=True)
    return d


def _store_file(repo: Path, user_id: Optional[str]) -> Path:
    return _store_dir(repo, user_id) / "examples.json"


def _load(repo: Path, user_id: Optional[str]) -> List[PreferenceExample]:
    f = _store_file(repo, user_id)
    if not f.exists():
        return []
    try:
        raw = json.loads(f.read_text(encoding="utf-8"))
    except Exception:
        logger.warning("preference store at %s is corrupt; starting fresh", f)
        return []
    out: List[PreferenceExample] = []
    for item in raw or []:
        try:
            out.append(PreferenceExample(
                request_summary=item.get("request_summary", ""),
                accepted_diff=item.get("accepted_diff", ""),
                style=item.get("style", "safe"),
                model_pair=list(item.get("model_pair") or [None, None]),
                loc=item.get("loc", "+0 −0"),
                ts=float(item.get("ts", 0.0)),
                universe_id=item.get("universe_id"),
                arbiter_winner=item.get("arbiter_winner"),
                user_overrode=bool(item.get("user_overrode", False)),
            ))
        except Exception:
            continue
    return out


def _save(repo: Path, user_id: Optional[str], examples: List[PreferenceExample]) -> None:
    f = _store_file(repo, user_id)
    f.write_text(
        json.dumps([e.to_dict() for e in examples], indent=2),
        encoding="utf-8",
    )


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def add_example(
    *,
    repo: Path,
    user_id: Optional[str],
    request_summary: str,
    accepted_diff: str,
    style: str,
    model_pair: List[Optional[str]],
    loc: str,
    universe_id: Optional[str] = None,
    arbiter_winner: Optional[bool] = None,
    user_overrode: bool = False,
    keep: int = DEFAULT_KEEP,
) -> PreferenceExample:
    """Append a new accepted-patch example, prune to `keep`."""
    example = PreferenceExample(
        request_summary=_truncate(request_summary, 300),
        accepted_diff=_truncate(accepted_diff, DIFF_CHAR_CAP),
        style=style,
        model_pair=list(model_pair),
        loc=loc,
        ts=time.time(),
        universe_id=universe_id,
        arbiter_winner=arbiter_winner,
        user_overrode=user_overrode,
    )
    existing = _load(repo, user_id)
    existing.append(example)
    # Keep the most recent N — the rolling window is a deliberately
    # cheap proxy for "current preferences".
    existing.sort(key=lambda e: e.ts)
    if len(existing) > keep:
        existing = existing[-keep:]
    _save(repo, user_id, existing)
    return example


def few_shot_for(
    *,
    repo: Path,
    user_id: Optional[str],
    request: str,
    k: int = TOP_K_FEW_SHOT,
) -> List[PreferenceExample]:
    """Return the top-k most relevant examples for the given request.

    Wave 4 ranks by cheap keyword Jaccard overlap. We keep an embedding
    plug here for a follow-up — concrete examples already beat the EMA
    vector approach (master plan §13), so a smarter ranker is optional.
    """
    pool = _load(repo, user_id)
    if not pool:
        return []
    request_terms = _tokenize(request)
    if not request_terms:
        return pool[-k:][::-1]
    scored: List[tuple] = []
    for ex in pool:
        terms = _tokenize(ex.request_summary)
        if not terms:
            score = 0.0
        else:
            inter = request_terms & terms
            union = request_terms | terms
            score = len(inter) / len(union) if union else 0.0
        # Recency tiebreak — recent examples win on equal Jaccard.
        scored.append((score, ex.ts, ex))
    scored.sort(key=lambda t: (-t[0], -t[1]))
    return [e for _, _, e in scored[:k]]


def style_match(
    *,
    repo: Path,
    user_id: Optional[str],
    request: str,
    candidate_style: str,
    candidate_loc: int,
    candidate_provider: Optional[str] = None,
) -> float:
    """0..1 affinity score between this candidate and the user's
    preference history. Plugs into ScoreInput.style_match (see
    multiverse.compute_score) so accepted-patch shape feeds the
    universe ranking.

    Heuristic:
      - +0.5 baseline.
      - +0.3 if the most-similar example shares the candidate style.
      - +0.2 if the candidate's loc delta is within 30 % of that
        example's reported delta.
      - Override signal (master plan §22 Wave 4):
          +0.10 if the user has historically *picked* this style/provider
                  over the Arbiter's recommendation (`user_overrode=True`
                  with this style/provider as the user's choice).
          −0.15 if the Arbiter previously *recommended* this style/provider
                  and the user picked something else.
        These shifts are intentionally smaller than the style-match
        bonus so a single override doesn't dominate the ranking — it
        nudges, then accumulates with repetition.
    """
    examples = few_shot_for(repo=repo, user_id=user_id, request=request, k=1)
    score = 0.5
    if examples:
        top = examples[0]
        if top.style == candidate_style:
            score += 0.3
        expected = _loc_delta_int(top.loc)
        if expected and abs(candidate_loc - expected) <= max(3, int(expected * 0.3)):
            score += 0.2

    sig = override_signal(repo=repo, user_id=user_id)
    if candidate_style in sig["preferred_styles"]:
        score += 0.10
    if candidate_style in sig["avoided_styles"]:
        score -= 0.15
    if candidate_provider:
        if candidate_provider in sig["preferred_providers"]:
            score += 0.10
        if candidate_provider in sig["avoided_providers"]:
            score -= 0.15

    return max(0.0, min(1.0, score))


def override_signal(
    *,
    repo: Path,
    user_id: Optional[str],
    half_life_examples: int = 4,
) -> Dict[str, set]:
    """Aggregate user overrides into preferred/avoided style + provider
    sets. Both kinds of signal carry: `user_overrode=True` means the
    user picked something the Arbiter didn't recommend (preferred), and
    that other universe's metadata becomes the avoided set.

    `half_life_examples` controls recency weighting — only examples
    where (most_recent_index - i) <= 2 * half_life are considered. The
    last 8 examples × half_life=4 means everything in scope, but bumping
    the keep window later won't suddenly include ancient overrides.
    """
    pool = _load(repo, user_id)
    if not pool:
        return {
            "preferred_styles": set(),
            "avoided_styles": set(),
            "preferred_providers": set(),
            "avoided_providers": set(),
        }
    pool.sort(key=lambda e: e.ts)
    cutoff_idx = max(0, len(pool) - 2 * max(1, half_life_examples))
    recent = pool[cutoff_idx:]

    preferred_styles: set = set()
    avoided_styles: set = set()
    preferred_providers: set = set()
    avoided_providers: set = set()
    for ex in recent:
        gen_provider = ex.model_pair[0] if ex.model_pair else None
        if ex.user_overrode:
            preferred_styles.add(ex.style)
            if gen_provider:
                preferred_providers.add(_provider_family(gen_provider))
        elif ex.arbiter_winner is False:
            # Arbiter wasn't the source — user picked, but didn't
            # explicitly override. Treat as soft preference.
            preferred_styles.add(ex.style)
        if ex.arbiter_winner is True and not ex.user_overrode:
            # The user accepted the Arbiter's pick — neutral signal.
            continue

    # Avoided set: any *other* style/provider in the same recent window
    # that wasn't accepted is treated as avoided. Conservative — we
    # don't know the full universe set per example, so we infer from
    # the family of declared providers across history.
    declared_providers = {
        _provider_family(ex.model_pair[0])
        for ex in recent if ex.model_pair and ex.model_pair[0]
    }
    declared_providers.discard(None)
    avoided_providers = declared_providers - preferred_providers

    declared_styles = {ex.style for ex in recent}
    avoided_styles = declared_styles - preferred_styles

    return {
        "preferred_styles": preferred_styles,
        "avoided_styles": avoided_styles,
        "preferred_providers": preferred_providers,
        "avoided_providers": avoided_providers,
    }


_PROVIDER_FAMILY = {
    "claude": "anthropic", "anthropic": "anthropic",
    "gpt": "openai", "openai": "openai", "o1": "openai",
    "gemini": "gemini", "google": "gemini",
}


def _provider_family(model_or_provider: Optional[str]) -> Optional[str]:
    if not model_or_provider:
        return None
    s = str(model_or_provider).lower()
    for key, fam in _PROVIDER_FAMILY.items():
        if key in s:
            return fam
    return None


def render_few_shot(examples: List[PreferenceExample], header: str = "PREFERENCE EXAMPLES") -> str:
    """Format the examples for direct inclusion in a Generator prompt.

    Concrete diffs preserve concrete style signal — bracket placement,
    error-handling shape, comment density — without the lossy EMA layer.
    """
    if not examples:
        return ""
    blocks: List[str] = []
    for i, ex in enumerate(examples, start=1):
        blocks.append(
            f"<example {i}>\n"
            f"request: {ex.request_summary}\n"
            f"style: {ex.style}\n"
            f"loc: {ex.loc}\n"
            f"accepted_diff:\n{ex.accepted_diff}\n"
            f"</example {i}>"
        )
    return f"<{header}>\n" + "\n\n".join(blocks) + f"\n</{header}>\n"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_TOKEN = re.compile(r"[A-Za-z][A-Za-z0-9_]{2,}")
_STOPWORDS = {
    "the", "and", "for", "with", "that", "this", "from", "into", "have",
    "you", "your", "are", "but", "fix", "make", "add", "use", "should",
    "would", "could", "when", "where", "what", "how", "can",
}


def _tokenize(text: str) -> set:
    return {w.lower() for w in _TOKEN.findall(text or "") if w.lower() not in _STOPWORDS}


def _loc_delta_int(loc: str) -> int:
    total = 0
    for tok in (loc or "").replace("−", "-").split():
        digits = "".join(c for c in tok if c.isdigit())
        if digits:
            total += int(digits)
    return total


def _truncate(text: str, n: int) -> str:
    if not text:
        return ""
    return text[:n] + ("…" if len(text) > n else "")


def list_examples(repo: Path, user_id: Optional[str]) -> Iterable[Dict[str, Any]]:
    for ex in _load(repo, user_id):
        yield ex.to_dict()

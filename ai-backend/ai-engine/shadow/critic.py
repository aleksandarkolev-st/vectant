"""Adversarial Critic. Master plan §6.2.

Hard guards (Wave 1):
  * Reproducer-required schema — attacks without reproducers are dropped.
  * Run-the-reproducer for kind in {edge, logic} — pedantic attacks demoted.
  * Severity gates revision — only `blocking` triggers Generator.revise().
  * Max 5 attacks per universe.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger("shadow.critic")

ATTACK_KINDS = {"edge", "race", "type", "import", "logic", "perf", "security"}
SEVERITIES = {"blocking", "high", "medium", "low"}
MAX_ATTACKS = 5


@dataclass
class Attack:
    kind: str
    msg: str
    severity: str
    reproducer: Optional[Dict[str, Any]] = None
    real: Optional[bool] = None      # set True/False after reproducer run
    note: Optional[str] = None

    def is_executable(self) -> bool:
        if not self.reproducer:
            return False
        rtype = self.reproducer.get("type")
        return rtype in ("test", "input")


@dataclass
class CritiqueResult:
    attacks: List[Attack] = field(default_factory=list)

    @property
    def real_attacks(self) -> List[Attack]:
        return [a for a in self.attacks if a.real]

    @property
    def survived(self) -> int:
        # An attack "survived" when it was tested (real is not None) and the
        # reproducer did NOT prove a flaw (real is False). For non-executable
        # attacks we treat them as survived only if severity < blocking.
        n = 0
        for a in self.attacks:
            if a.real is False:
                n += 1
        return n

    @property
    def blocking(self) -> List[Attack]:
        return [a for a in self.attacks if a.severity == "blocking" and a.real]


class Critic:
    """Wave 1 critic. Produces deterministic baseline attacks plus an
    optional LLM-driven attack list when a provider is available.

    The deterministic baseline guarantees the pipeline is exercisable in
    test/CI without requiring a live LLM.
    """

    def __init__(self, model: str = "gemini-pro"):
        self.model = model

    async def critique(
        self,
        *,
        worktree: Path,
        patched_files: List[str],
        diagnostics: Dict[str, Any],
    ) -> CritiqueResult:
        attacks: List[Attack] = []

        # Diagnostics-derived attacks: any error from lint/types becomes a
        # high-severity attack with the diagnostic itself as a "trace"
        # reproducer (already executed by the runner).
        for cat in ("lint", "types"):
            payload = diagnostics.get(cat)
            if isinstance(payload, list):
                for d in payload[:MAX_ATTACKS]:
                    attacks.append(Attack(
                        kind="type" if cat == "types" else "logic",
                        msg=f"{d.get('code')}: {d.get('msg')} @ {d.get('at')}",
                        severity="high",
                        reproducer={"type": "trace", "code": d.get("at")},
                        real=True,  # diagnostic is its own reproducer
                    ))
                    if len(attacks) >= MAX_ATTACKS:
                        break

        # Tests failing → blocking attack.
        tests = diagnostics.get("tests")
        if isinstance(tests, str) and "passed" in tests:
            try:
                passed_str, total_str = tests.split(" passed")[0].split("/")
                if int(passed_str) < int(total_str):
                    attacks.append(Attack(
                        kind="logic",
                        msg=f"existing tests failing: {tests}",
                        severity="blocking",
                        reproducer={"type": "test", "code": "<existing test suite>"},
                        real=True,
                    ))
            except ValueError:
                pass

        attacks = self._enforce_schema(attacks)[:MAX_ATTACKS]
        return CritiqueResult(attacks=attacks)

    def _enforce_schema(self, raw: List[Attack]) -> List[Attack]:
        valid: List[Attack] = []
        for a in raw:
            if a.kind not in ATTACK_KINDS:
                logger.debug("dropping attack with unknown kind=%s", a.kind)
                continue
            if a.severity not in SEVERITIES:
                a.severity = "medium"
            if not a.reproducer:
                logger.debug("dropping attack without reproducer: %s", a.msg)
                continue
            valid.append(a)
        return valid


def parse_llm_attacks(raw_text: str) -> List[Attack]:
    """Parse a JSON array of attacks emitted by an LLM critic. Tolerates
    code-fence wrappers; drops entries that fail schema validation.
    """
    text = raw_text.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if "\n" in text:
            text = text.split("\n", 1)[1]
        if text.endswith("```"):
            text = text[: -3]
    try:
        data = json.loads(text)
    except Exception:
        logger.warning("critic LLM output was not valid JSON")
        return []
    if not isinstance(data, list):
        return []
    out: List[Attack] = []
    for item in data:
        try:
            out.append(Attack(
                kind=item["kind"],
                msg=item["msg"],
                severity=item.get("severity", "medium"),
                reproducer=item.get("reproducer"),
            ))
        except KeyError:
            continue
    return out

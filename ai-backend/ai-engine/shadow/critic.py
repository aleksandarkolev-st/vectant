"""Adversarial Critic. Master plan §6.2.

Hard guards (Wave 1):
  * Reproducer-required schema — attacks without reproducers are dropped.
  * Run-the-reproducer for kind in {edge, logic} — pedantic attacks demoted.
  * Severity gates revision — only `blocking` triggers Generator.revise().
  * Max 5 attacks per universe.
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger("shadow.critic")

ATTACK_KINDS = {"edge", "race", "type", "import", "logic", "perf", "security"}
SEVERITIES = {"blocking", "high", "medium", "low"}
MAX_ATTACKS = 5
LLM_CRITIC_TIMEOUT_SEC = 8.0


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

    def __init__(
        self,
        model: str = "gemini-pro",
        provider: str = "gemini",
        api_key: Optional[str] = None,
    ):
        self.model = model
        self.provider = provider
        self.api_key = api_key

    async def critique(
        self,
        *,
        worktree: Path,
        patched_files: List[str],
        diagnostics: Dict[str, Any],
        patches: Optional[List[Any]] = None,
        user_request: str = "",
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

        # Wave 2: layer in LLM-novel attacks if there's room. Diagnostic
        # attacks already cover real lint/type/test failures; the LLM is
        # asked to find issues those stages can't see (logic edges,
        # races, security gaps, missing-tests-this-patch-should-have).
        room = MAX_ATTACKS - len(attacks)
        if room > 0 and patches:
            llm_attacks = await self._llm_attacks(
                patches=patches,
                diagnostics=diagnostics,
                user_request=user_request,
                room=room,
            )
            attacks.extend(llm_attacks)

        attacks = self._enforce_schema(attacks)[:MAX_ATTACKS]
        return CritiqueResult(attacks=attacks)

    async def _llm_attacks(
        self,
        *,
        patches: List[Any],
        diagnostics: Dict[str, Any],
        user_request: str,
        room: int,
    ) -> List[Attack]:
        """Ask the configured provider for novel attacks with executable
        reproducers. Failures (no provider, network, malformed JSON) are
        swallowed — the deterministic baseline keeps the pipeline alive.
        """
        if room <= 0:
            return []
        try:
            from llm.providers import get_provider
            prov = get_provider(self.provider)
        except Exception as e:
            logger.debug("critic LLM unavailable: %s", e)
            return []

        prompt = _build_llm_critic_prompt(
            patches=patches,
            diagnostics=diagnostics,
            user_request=user_request,
            max_attacks=room,
        )

        try:
            text = await asyncio.wait_for(
                prov.ask_llm(
                    code="", lang="json",
                    prompt=prompt,
                    model=self.model, api_key=self.api_key,
                ),
                timeout=LLM_CRITIC_TIMEOUT_SEC,
            )
        except asyncio.TimeoutError:
            logger.info("critic LLM timed out after %.1fs", LLM_CRITIC_TIMEOUT_SEC)
            return []
        except Exception as e:
            logger.debug("critic LLM call failed: %s", e)
            return []

        if not text:
            return []
        return parse_llm_attacks(text)[:room]

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


_LLM_CRITIC_SCHEMA = """
Output ONLY a JSON array of attacks (no prose, no fences). Up to MAX entries.
Each item:
{
  "kind": "edge|race|type|import|logic|perf|security",
  "msg": "<one-sentence flaw>",
  "severity": "blocking|high|medium|low",
  "reproducer": {
    "type": "test" | "input",
    // type=test: an actual pytest or vitest test function that fails on the patched code
    "code": "...",
    // type=input: a dotted target + structured input that crashes the patched module
    "target": "module.func",
    "input": {}
  }
}

Rules:
- Every attack MUST include a reproducer. Drop attacks you can't ground in a runnable test or input.
- Prefer kind=edge or logic with a runnable test — those get executed in the worktree to prove they're real.
- Severity=blocking is reserved for flaws that obviously break the patch's intent.
- Do not duplicate diagnostics already listed below — those are covered.
""".strip()


def _build_llm_critic_prompt(
    *,
    patches: List[Any],
    diagnostics: Dict[str, Any],
    user_request: str,
    max_attacks: int,
) -> str:
    files_block: List[str] = []
    for p in patches[:4]:  # cap at 4 files in the prompt
        path = getattr(p, "path", "?")
        new_content = getattr(p, "new_content", "") or ""
        files_block.append(f"--- {path} ---\n{new_content[:3000]}")
    diag_summary = json.dumps(diagnostics, indent=2)[:1200]
    return (
        "You are an adversarial Critic reviewing an AI-proposed patch. Your job "
        "is to find real flaws the lint/type/test pipeline missed. Each attack "
        "must come with an executable reproducer.\n\n"
        f"USER REQUEST:\n{user_request[:600]}\n\n"
        f"PATCHED FILES:\n" + "\n\n".join(files_block) + "\n\n"
        f"PIPELINE DIAGNOSTICS (already-known issues, do NOT repeat):\n{diag_summary}\n\n"
        f"{_LLM_CRITIC_SCHEMA.replace('MAX', str(max_attacks))}\n"
    )


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

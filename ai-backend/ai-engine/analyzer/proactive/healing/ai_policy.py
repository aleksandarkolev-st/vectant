"""
AI Suppression Policy Store — backend-side, user/team-scoped.

Keeps a persistent record of which rule+fingerprint combinations
have been suppressed.  This is a *preference/policy* signal,
separate from the feedback/memory system that tracks model quality.

Persistence: JSON file (one per user).
Thread-safe: asyncio Lock guards reads/writes.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Dict, List, Optional, Set

logger = logging.getLogger("healing.ai_policy")


@dataclass
class SuppressionEntry:
    """A single suppression record."""

    rule_id: str
    mode: str = "fingerprint"            # 'fingerprint' | 'rule'
    fingerprints: Set[str] = field(default_factory=set)
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    ttl: Optional[float] = None          # seconds, None = permanent
    reason: Optional[str] = None

    # ── Escalation tracking ──────────────────────────────────────
    suppress_count: int = 1              # how many times user suppressed this
    escalated: bool = False              # True → demoted to manual-only

    def is_expired(self) -> bool:
        if self.ttl is None:
            return False
        return (time.time() - self.created_at) > self.ttl

    def to_dict(self) -> dict:
        return {
            "rule_id": self.rule_id,
            "mode": self.mode,
            "fingerprints": sorted(self.fingerprints),
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "ttl": self.ttl,
            "reason": self.reason,
            "suppress_count": self.suppress_count,
            "escalated": self.escalated,
        }


class AISuppressionPolicy:
    """
    Per-user suppression policy store.

    Thread-safe via asyncio Lock.
    Persists to a JSON file so suppressions survive restarts.
    """

    def __init__(self, persist_dir: Optional[str] = None, user_id: str = "default"):
        self._entries: Dict[str, SuppressionEntry] = {}
        self._user_id = user_id
        self._lock = asyncio.Lock()

        if persist_dir:
            self._persist_path = Path(persist_dir) / f"policy_{user_id}.json"
        else:
            self._persist_path = None

        self._load()

    # ── Suppress ──────────────────────────────────────────────────────

    async def suppress(
        self,
        rule_id: str,
        fingerprint: Optional[str] = None,
        mode: str = "fingerprint",
        reason: Optional[str] = None,
        ttl: Optional[float] = None,
    ) -> SuppressionEntry:
        async with self._lock:
            entry = self._entries.get(rule_id)

            if entry is None:
                entry = SuppressionEntry(
                    rule_id=rule_id,
                    mode=mode,
                    reason=reason,
                    ttl=ttl,
                )
                self._entries[rule_id] = entry
            else:
                entry.suppress_count += 1
                entry.updated_at = time.time()
                if reason:
                    entry.reason = reason

            # Mode upgrade: fingerprint → rule is allowed
            if mode == "rule":
                entry.mode = "rule"

            if mode == "fingerprint" and fingerprint:
                entry.fingerprints.add(fingerprint)

            # Escalation: 5+ suppressions → manual-only
            if entry.suppress_count >= 5 and not entry.escalated:
                entry.escalated = True
                logger.info(
                    "Escalating rule %s to manual-only (%d suppressions)",
                    rule_id, entry.suppress_count,
                )

            self._save()
            return entry

    # ── Unsuppress ────────────────────────────────────────────────────

    async def unsuppress(
        self,
        rule_id: str,
        fingerprint: Optional[str] = None,
    ) -> bool:
        async with self._lock:
            entry = self._entries.get(rule_id)
            if entry is None:
                return False

            if fingerprint and entry.mode == "fingerprint":
                entry.fingerprints.discard(fingerprint)
                if not entry.fingerprints:
                    del self._entries[rule_id]
                else:
                    entry.updated_at = time.time()
            else:
                del self._entries[rule_id]

            self._save()
            return True

    # ── Query ─────────────────────────────────────────────────────────

    async def is_suppressed(
        self,
        rule_id: str,
        fingerprint: Optional[str] = None,
    ) -> bool:
        async with self._lock:
            entry = self._entries.get(rule_id)
            if entry is None:
                return False
            if entry.is_expired():
                del self._entries[rule_id]
                return False
            if entry.mode == "rule":
                return True
            if fingerprint:
                return fingerprint in entry.fingerprints
            return bool(entry.fingerprints)

    async def is_escalated(self, rule_id: str) -> bool:
        """Check if a rule has been escalated to manual-only."""
        async with self._lock:
            entry = self._entries.get(rule_id)
            return entry.escalated if entry else False

    async def list_entries(self) -> List[dict]:
        async with self._lock:
            result = []
            expired = []
            for rule_id, entry in self._entries.items():
                if entry.is_expired():
                    expired.append(rule_id)
                else:
                    result.append(entry.to_dict())
            for rule_id in expired:
                del self._entries[rule_id]
            if expired:
                self._save()
            return result

    async def summary(self) -> dict:
        entries = await self.list_entries()
        escalated = [e for e in entries if e.get("escalated")]
        by_mode = {}
        for e in entries:
            m = e.get("mode", "fingerprint")
            by_mode[m] = by_mode.get(m, 0) + 1
        return {
            "user_id": self._user_id,
            "total": len(entries),
            "total_rules": len(entries),
            "escalated_count": len(escalated),
            "by_mode": by_mode,
            "entries": entries,
        }

    async def clear(self) -> int:
        async with self._lock:
            count = len(self._entries)
            self._entries.clear()
            self._save()
            return count

    # ── Persistence ───────────────────────────────────────────────────

    def _save(self):
        if not self._persist_path:
            return
        try:
            self._persist_path.parent.mkdir(parents=True, exist_ok=True)
            data = {
                "user_id": self._user_id,
                "version": 1,
                "entries": {
                    rid: e.to_dict() for rid, e in self._entries.items()
                },
            }
            self._persist_path.write_text(json.dumps(data, indent=2))
        except Exception as exc:
            logger.warning("Failed to persist suppression policy: %s", exc)

    def _load(self):
        if not self._persist_path or not self._persist_path.exists():
            return
        try:
            data = json.loads(self._persist_path.read_text())
            for rid, raw in (data.get("entries") or {}).items():
                self._entries[rid] = SuppressionEntry(
                    rule_id=rid,
                    mode=raw.get("mode", "fingerprint"),
                    fingerprints=set(raw.get("fingerprints", [])),
                    created_at=raw.get("created_at", time.time()),
                    updated_at=raw.get("updated_at", time.time()),
                    ttl=raw.get("ttl"),
                    reason=raw.get("reason"),
                    suppress_count=raw.get("suppress_count", 1),
                    escalated=raw.get("escalated", False),
                )
        except Exception as exc:
            logger.warning("Failed to load suppression policy: %s", exc)


# ── Module singleton registry ─────────────────────────────────────────

_instances: Dict[str, AISuppressionPolicy] = {}


def get_suppression_policy(
    persist_dir: Optional[str] = None,
    user_id: str = "default",
) -> AISuppressionPolicy:
    key = f"{persist_dir or ''}::{user_id}"
    if key not in _instances:
        _instances[key] = AISuppressionPolicy(
            persist_dir=persist_dir or os.environ.get("POLICY_PERSIST_DIR"),
            user_id=user_id,
        )
    return _instances[key]

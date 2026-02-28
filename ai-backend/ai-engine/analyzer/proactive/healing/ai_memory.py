"""
AI Agent Memory — learns from user feedback.

Tracks which AI-detected fixes were accepted, rejected, or modified
by the user. Uses this history to:
1. Suppress fix patterns the user consistently rejects
2. Boost confidence for patterns the user consistently accepts
3. Provide feedback stats for prompt tuning

Storage: Simple in-memory dict with optional JSON persistence.
Not a database — this is a lightweight heuristic cache.
"""

from __future__ import annotations

import json
import logging
import os
import time
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger("healing.ai_memory")


# ── Feedback types ────────────────────────────────────────────────────

class FeedbackType:
    ACCEPTED = "accepted"        # User applied the fix
    REJECTED = "rejected"        # User dismissed the fix
    MODIFIED = "modified"        # User applied but changed the replacement
    AUTO_APPLIED = "auto_applied"  # System auto-applied (was safe)


@dataclass
class FixFeedback:
    """Record of user feedback on a single fix."""
    rule_id: str                # e.g. "AI_LOGIC_ERROR", "AI_NULL_SAFETY"
    category: str               # e.g. "logic_error", "null_safety"
    feedback: str               # FeedbackType value
    confidence: float           # Original confidence
    language: str               # Language of the file
    timestamp: float = field(default_factory=time.time)
    file_path: Optional[str] = None
    description: Optional[str] = None


@dataclass
class PatternStats:
    """Aggregated stats for a rule_id pattern."""
    accepted: int = 0
    rejected: int = 0
    modified: int = 0
    auto_applied: int = 0
    total_confidence: float = 0.0
    last_seen: float = 0.0

    @property
    def total(self) -> int:
        return self.accepted + self.rejected + self.modified + self.auto_applied

    @property
    def acceptance_rate(self) -> float:
        if self.total == 0:
            return 0.5  # neutral
        return (self.accepted + self.auto_applied + self.modified * 0.5) / self.total

    @property
    def avg_confidence(self) -> float:
        if self.total == 0:
            return 0.0
        return self.total_confidence / self.total


class AIAgentMemory:
    """
    In-memory feedback store with optional JSON persistence.

    Tracks per-pattern (rule_id) acceptance rates to adjust future
    confidence scores. Also tracks per-language patterns.
    """

    def __init__(self, persist_path: Optional[str] = None, max_history: int = 1000):
        self._persist_path = persist_path
        self._max_history = max_history

        # Per-pattern stats
        self._pattern_stats: Dict[str, PatternStats] = defaultdict(PatternStats)

        # Per-language, per-category stats
        self._lang_stats: Dict[str, Dict[str, PatternStats]] = defaultdict(
            lambda: defaultdict(PatternStats)
        )

        # Raw history (for persistence)
        self._history: List[FixFeedback] = []

        # Suppression set — patterns the user always rejects
        self._suppressed: set = set()

        # Load from disk if available
        if persist_path:
            self._load()

    def record_feedback(self, feedback: FixFeedback) -> None:
        """Record a user's feedback on a fix."""
        # Update pattern stats
        stats = self._pattern_stats[feedback.rule_id]
        self._update_stats(stats, feedback)

        # Update language-specific stats
        lang_stats = self._lang_stats[feedback.language][feedback.category]
        self._update_stats(lang_stats, feedback)

        # Store in history
        self._history.append(feedback)
        if len(self._history) > self._max_history:
            self._history = self._history[-self._max_history:]

        # Check for suppression (3+ rejections with 0 accepts)
        if stats.rejected >= 3 and stats.accepted == 0 and stats.auto_applied == 0:
            self._suppressed.add(feedback.rule_id)
            logger.info(
                f"Suppressing pattern {feedback.rule_id}: "
                f"{stats.rejected} rejections, 0 accepts"
            )

        # Un-suppress if user starts accepting
        if feedback.feedback == FeedbackType.ACCEPTED and feedback.rule_id in self._suppressed:
            if stats.acceptance_rate > 0.3:
                self._suppressed.discard(feedback.rule_id)
                logger.info(f"Un-suppressing pattern {feedback.rule_id}")

        # Persist
        if self._persist_path:
            self._save()

    def get_confidence_adjustment(self, rule_id: str, language: str = "") -> float:
        """
        Get a confidence multiplier based on historical feedback.

        Returns a value between 0.5 and 1.5:
        - < 1.0: User often rejects this pattern → lower confidence
        - 1.0: Neutral (no data or 50/50)
        - > 1.0: User often accepts this pattern → boost confidence
        """
        stats = self._pattern_stats.get(rule_id)
        if not stats or stats.total < 2:
            return 1.0  # Not enough data

        # Base adjustment from acceptance rate
        rate = stats.acceptance_rate
        # Map [0, 1] → [0.5, 1.5]
        adjustment = 0.5 + rate

        return round(adjustment, 3)

    def is_suppressed(self, rule_id: str) -> bool:
        """Check if a pattern is suppressed (user always rejects it)."""
        return rule_id in self._suppressed

    def get_pattern_stats(self, rule_id: str) -> Optional[Dict[str, Any]]:
        """Get stats for a specific pattern."""
        stats = self._pattern_stats.get(rule_id)
        if not stats:
            return None
        return {
            "accepted": stats.accepted,
            "rejected": stats.rejected,
            "modified": stats.modified,
            "auto_applied": stats.auto_applied,
            "total": stats.total,
            "acceptance_rate": round(stats.acceptance_rate, 3),
            "avg_confidence": round(stats.avg_confidence, 3),
        }

    def get_summary(self) -> Dict[str, Any]:
        """Get overall memory summary."""
        total_feedback = sum(s.total for s in self._pattern_stats.values())
        total_accepted = sum(s.accepted + s.auto_applied for s in self._pattern_stats.values())

        return {
            "total_feedback": total_feedback,
            "total_patterns": len(self._pattern_stats),
            "suppressed_patterns": list(self._suppressed),
            "overall_acceptance_rate": (
                round(total_accepted / max(1, total_feedback), 3)
            ),
            "history_size": len(self._history),
        }

    def clear(self) -> None:
        """Clear all memory."""
        self._pattern_stats.clear()
        self._lang_stats.clear()
        self._history.clear()
        self._suppressed.clear()
        if self._persist_path and os.path.exists(self._persist_path):
            os.remove(self._persist_path)

    # ── Internal ──────────────────────────────────────────────────────

    @staticmethod
    def _update_stats(stats: PatternStats, feedback: FixFeedback) -> None:
        """Update a PatternStats object with new feedback."""
        if feedback.feedback == FeedbackType.ACCEPTED:
            stats.accepted += 1
        elif feedback.feedback == FeedbackType.REJECTED:
            stats.rejected += 1
        elif feedback.feedback == FeedbackType.MODIFIED:
            stats.modified += 1
        elif feedback.feedback == FeedbackType.AUTO_APPLIED:
            stats.auto_applied += 1

        stats.total_confidence += feedback.confidence
        stats.last_seen = feedback.timestamp

    def _save(self) -> None:
        """Persist memory to JSON file."""
        if not self._persist_path:
            return
        try:
            data = {
                "history": [
                    {
                        "rule_id": f.rule_id,
                        "category": f.category,
                        "feedback": f.feedback,
                        "confidence": f.confidence,
                        "language": f.language,
                        "timestamp": f.timestamp,
                    }
                    for f in self._history[-self._max_history:]
                ],
                "suppressed": list(self._suppressed),
            }
            os.makedirs(os.path.dirname(self._persist_path), exist_ok=True)
            with open(self._persist_path, "w") as fp:
                json.dump(data, fp)
        except Exception as e:
            logger.warning(f"Failed to save AI memory: {e}")

    def _load(self) -> None:
        """Load memory from JSON file."""
        if not self._persist_path or not os.path.exists(self._persist_path):
            return
        try:
            with open(self._persist_path, "r") as fp:
                data = json.load(fp)

            for item in data.get("history", []):
                feedback = FixFeedback(
                    rule_id=item["rule_id"],
                    category=item["category"],
                    feedback=item["feedback"],
                    confidence=item["confidence"],
                    language=item["language"],
                    timestamp=item.get("timestamp", 0),
                )
                # Replay to rebuild stats
                stats = self._pattern_stats[feedback.rule_id]
                self._update_stats(stats, feedback)
                self._history.append(feedback)

            self._suppressed = set(data.get("suppressed", []))
            logger.info(
                f"Loaded AI memory: {len(self._history)} entries, "
                f"{len(self._suppressed)} suppressed"
            )
        except Exception as e:
            logger.warning(f"Failed to load AI memory: {e}")


# Module singleton
_memory_instance: Optional[AIAgentMemory] = None


def get_agent_memory(persist_path: Optional[str] = None) -> AIAgentMemory:
    """Get or create the global AI agent memory."""
    global _memory_instance
    if _memory_instance is None:
        _memory_instance = AIAgentMemory(persist_path=persist_path)
    return _memory_instance

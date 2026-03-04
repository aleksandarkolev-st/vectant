"""
Precision & Revert Telemetry.

Tracks the empirical success/failure of every fix to enable:
1. Per-rule precision measurement (what % of fixes are actually correct)
2. Revert rate tracking (what % get rolled back)
3. Confidence re-calibration based on real outcomes
4. Rule quality scoring over time
5. Detection of degrading rules

This is the missing link between "hand-tuned confidence" and
"calibrated confidence" — measure, don't guess.
"""

from __future__ import annotations

import json
import logging
import os
import time
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger("healing.precision_telemetry")


# ── Outcome types ─────────────────────────────────────────────────────

class FixOutcome:
    """Possible outcomes of a fix."""
    APPLIED = "applied"           # Fix was applied
    VERIFIED = "verified"         # Fix passed verification
    REVERTED = "reverted"         # Fix was rolled back
    REJECTED = "rejected"         # User rejected fix
    PARTIAL = "partial"           # Fix partially worked
    ERRORED = "errored"           # Fix caused new errors
    SKIPPED = "skipped"           # Fix was skipped


@dataclass
class FixOutcomeRecord:
    """Record of a single fix outcome."""
    fix_id: str
    rule_id: str
    category: str
    language: str
    file_path: str
    outcome: str                  # FixOutcome value
    original_confidence: float    # Confidence when proposed
    timestamp: float = field(default_factory=time.time)
    verification_passed: bool = False
    revert_reason: str = ""
    duration_ms: float = 0.0
    episode_id: str = ""
    details: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "fixId": self.fix_id,
            "ruleId": self.rule_id,
            "category": self.category,
            "language": self.language,
            "filePath": self.file_path,
            "outcome": self.outcome,
            "originalConfidence": self.original_confidence,
            "timestamp": self.timestamp,
            "verificationPassed": self.verification_passed,
            "revertReason": self.revert_reason,
            "durationMs": round(self.duration_ms, 1),
            "episodeId": self.episode_id,
        }


# ── Per-rule statistics ───────────────────────────────────────────────

@dataclass
class RuleStats:
    """Aggregated statistics for a single rule."""
    rule_id: str
    total_proposed: int = 0
    total_applied: int = 0
    total_verified: int = 0
    total_reverted: int = 0
    total_rejected: int = 0
    total_errored: int = 0
    total_confidence: float = 0.0
    last_seen: float = 0.0

    @property
    def precision(self) -> float:
        """
        Empirical precision: what fraction of applied fixes were verified.

        precision = verified / applied
        """
        if self.total_applied == 0:
            return 0.0
        return self.total_verified / self.total_applied

    @property
    def revert_rate(self) -> float:
        """What fraction of applied fixes were reverted."""
        if self.total_applied == 0:
            return 0.0
        return self.total_reverted / self.total_applied

    @property
    def acceptance_rate(self) -> float:
        """What fraction of proposed fixes were applied (not rejected/skipped)."""
        if self.total_proposed == 0:
            return 0.0
        return self.total_applied / self.total_proposed

    @property
    def avg_confidence(self) -> float:
        if self.total_proposed == 0:
            return 0.0
        return self.total_confidence / self.total_proposed

    @property
    def calibrated_confidence(self) -> float:
        """
        Suggested confidence based on empirical data.

        Uses precision as the calibrated value, with a Bayesian prior
        that pulls toward 0.5 when data is sparse.

        Formula: (precision * N + prior * prior_weight) / (N + prior_weight)
        """
        prior = 0.5
        prior_weight = 5  # Equivalent to 5 observations
        n = self.total_applied
        if n == 0:
            return prior
        return (self.precision * n + prior * prior_weight) / (n + prior_weight)

    @property
    def quality_score(self) -> float:
        """
        Overall quality score 0–1 combining precision and acceptance.

        quality = 0.6 * precision + 0.3 * acceptance_rate + 0.1 * (1 - revert_rate)
        """
        return (
            0.6 * self.precision
            + 0.3 * self.acceptance_rate
            + 0.1 * (1.0 - self.revert_rate)
        )

    @property
    def is_degrading(self) -> bool:
        """
        Check if rule quality is degrading.

        A rule is degrading if:
        - At least 10 applications
        - Revert rate > 30%
        - OR precision < 50%
        """
        if self.total_applied < 10:
            return False
        return self.revert_rate > 0.3 or self.precision < 0.5

    def to_dict(self) -> Dict[str, Any]:
        return {
            "ruleId": self.rule_id,
            "totalProposed": self.total_proposed,
            "totalApplied": self.total_applied,
            "totalVerified": self.total_verified,
            "totalReverted": self.total_reverted,
            "totalRejected": self.total_rejected,
            "totalErrored": self.total_errored,
            "precision": round(self.precision, 3),
            "revertRate": round(self.revert_rate, 3),
            "acceptanceRate": round(self.acceptance_rate, 3),
            "avgConfidence": round(self.avg_confidence, 3),
            "calibratedConfidence": round(self.calibrated_confidence, 3),
            "qualityScore": round(self.quality_score, 3),
            "isDegrading": self.is_degrading,
            "lastSeen": self.last_seen,
        }


# ── Precision Telemetry Engine ────────────────────────────────────────

class PrecisionTelemetry:
    """
    Tracks fix outcomes and computes per-rule precision metrics.

    Usage:
        tel = PrecisionTelemetry()

        # When a fix is proposed
        tel.record_proposed(fix)

        # When a fix is applied
        tel.record_applied(fix_id, rule_id, ...)

        # When verification confirms fix
        tel.record_verified(fix_id)

        # When a fix is reverted
        tel.record_reverted(fix_id, reason="typecheck_failed")

        # Get metrics
        stats = tel.get_rule_stats("UNI_IMP_001")
        degrading = tel.get_degrading_rules()
        calibration = tel.get_calibration_table()
    """

    def __init__(
        self,
        persist_path: Optional[str] = None,
        max_history: int = 5000,
    ):
        self._persist_path = persist_path
        self._max_history = max_history

        # Per-rule stats
        self._rule_stats: Dict[str, RuleStats] = defaultdict(
            lambda: RuleStats(rule_id="")
        )

        # Per-category stats
        self._category_stats: Dict[str, RuleStats] = defaultdict(
            lambda: RuleStats(rule_id="")
        )

        # Per-language stats
        self._language_stats: Dict[str, RuleStats] = defaultdict(
            lambda: RuleStats(rule_id="")
        )

        # Raw outcome history
        self._history: List[FixOutcomeRecord] = []

        # Fix ID → record lookup (for updating outcomes)
        self._fix_lookup: Dict[str, FixOutcomeRecord] = {}

        # Load persisted data if available
        if persist_path and os.path.exists(persist_path):
            self._load()

    # ── Recording ─────────────────────────────────────────────────────

    def record_proposed(
        self,
        fix_id: str,
        rule_id: str,
        category: str,
        language: str,
        file_path: str,
        confidence: float,
        episode_id: str = "",
    ) -> None:
        """Record that a fix was proposed."""
        record = FixOutcomeRecord(
            fix_id=fix_id,
            rule_id=rule_id,
            category=category,
            language=language,
            file_path=file_path,
            outcome=FixOutcome.SKIPPED,  # Default until applied
            original_confidence=confidence,
            episode_id=episode_id,
        )
        self._fix_lookup[fix_id] = record
        self._history.append(record)
        self._trim_history()

        # Update stats
        self._get_rule_stats(rule_id).total_proposed += 1
        self._get_rule_stats(rule_id).total_confidence += confidence
        self._get_rule_stats(rule_id).last_seen = time.time()
        self._get_category_stats(category).total_proposed += 1
        self._get_language_stats(language).total_proposed += 1

    def record_applied(
        self,
        fix_id: str,
        duration_ms: float = 0.0,
    ) -> None:
        """Record that a fix was applied."""
        record = self._fix_lookup.get(fix_id)
        if not record:
            logger.warning(f"No record for fix_id={fix_id}")
            return
        record.outcome = FixOutcome.APPLIED
        record.duration_ms = duration_ms

        self._get_rule_stats(record.rule_id).total_applied += 1
        self._get_category_stats(record.category).total_applied += 1
        self._get_language_stats(record.language).total_applied += 1

    def record_verified(
        self,
        fix_id: str,
    ) -> None:
        """Record that a fix passed verification."""
        record = self._fix_lookup.get(fix_id)
        if not record:
            return
        record.outcome = FixOutcome.VERIFIED
        record.verification_passed = True

        self._get_rule_stats(record.rule_id).total_verified += 1
        self._get_category_stats(record.category).total_verified += 1
        self._get_language_stats(record.language).total_verified += 1

    def record_reverted(
        self,
        fix_id: str,
        reason: str = "",
    ) -> None:
        """Record that a fix was reverted/rolled back."""
        record = self._fix_lookup.get(fix_id)
        if not record:
            return
        record.outcome = FixOutcome.REVERTED
        record.revert_reason = reason

        self._get_rule_stats(record.rule_id).total_reverted += 1
        self._get_category_stats(record.category).total_reverted += 1
        self._get_language_stats(record.language).total_reverted += 1

    def record_rejected(
        self,
        fix_id: str,
    ) -> None:
        """Record that a fix was rejected by the user."""
        record = self._fix_lookup.get(fix_id)
        if not record:
            return
        record.outcome = FixOutcome.REJECTED

        self._get_rule_stats(record.rule_id).total_rejected += 1
        self._get_category_stats(record.category).total_rejected += 1
        self._get_language_stats(record.language).total_rejected += 1

    def record_errored(
        self,
        fix_id: str,
        details: Optional[Dict[str, Any]] = None,
    ) -> None:
        """Record that a fix caused new errors."""
        record = self._fix_lookup.get(fix_id)
        if not record:
            return
        record.outcome = FixOutcome.ERRORED
        if details:
            record.details = details

        self._get_rule_stats(record.rule_id).total_errored += 1
        self._get_category_stats(record.category).total_errored += 1
        self._get_language_stats(record.language).total_errored += 1

    # ── Querying ──────────────────────────────────────────────────────

    def get_rule_stats(self, rule_id: str) -> Optional[RuleStats]:
        """Get stats for a specific rule."""
        stats = self._rule_stats.get(rule_id)
        if stats and stats.rule_id == "":
            stats.rule_id = rule_id
        return stats

    def get_all_rule_stats(self) -> Dict[str, RuleStats]:
        """Get stats for all rules."""
        for rid, stats in self._rule_stats.items():
            if stats.rule_id == "":
                stats.rule_id = rid
        return dict(self._rule_stats)

    def get_degrading_rules(self) -> List[RuleStats]:
        """Get rules whose quality is degrading."""
        return [
            stats for stats in self._rule_stats.values()
            if stats.is_degrading
        ]

    def get_calibration_table(self) -> Dict[str, Dict[str, float]]:
        """
        Get a calibration table: rule_id → {original, calibrated, precision}.

        Used to update confidence values in rule definitions.
        """
        table = {}
        for rule_id, stats in self._rule_stats.items():
            if stats.total_applied >= 5:  # Only calibrate with enough data
                table[rule_id] = {
                    "originalAvgConfidence": round(stats.avg_confidence, 3),
                    "calibratedConfidence": round(stats.calibrated_confidence, 3),
                    "empiricalPrecision": round(stats.precision, 3),
                    "sampleSize": stats.total_applied,
                }
        return table

    def get_category_stats(self) -> Dict[str, Dict[str, Any]]:
        """Get aggregated stats by category."""
        return {
            cat: stats.to_dict()
            for cat, stats in self._category_stats.items()
        }

    def get_language_stats(self) -> Dict[str, Dict[str, Any]]:
        """Get aggregated stats by language."""
        return {
            lang: stats.to_dict()
            for lang, stats in self._language_stats.items()
        }

    def get_recent_outcomes(
        self,
        limit: int = 50,
        rule_id: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """Get recent outcome records."""
        records = self._history
        if rule_id:
            records = [r for r in records if r.rule_id == rule_id]
        return [r.to_dict() for r in records[-limit:]]

    def summary(self) -> Dict[str, Any]:
        """Overall summary."""
        total_applied = sum(s.total_applied for s in self._rule_stats.values())
        total_verified = sum(s.total_verified for s in self._rule_stats.values())
        total_reverted = sum(s.total_reverted for s in self._rule_stats.values())
        total_errored = sum(s.total_errored for s in self._rule_stats.values())

        return {
            "totalOutcomes": len(self._history),
            "totalApplied": total_applied,
            "totalVerified": total_verified,
            "totalReverted": total_reverted,
            "totalErrored": total_errored,
            "overallPrecision": round(
                total_verified / total_applied if total_applied > 0 else 0.0, 3
            ),
            "overallRevertRate": round(
                total_reverted / total_applied if total_applied > 0 else 0.0, 3
            ),
            "rulesTracked": len(self._rule_stats),
            "degradingRules": len(self.get_degrading_rules()),
        }

    # ── Internal helpers ──────────────────────────────────────────────

    def _get_rule_stats(self, rule_id: str) -> RuleStats:
        if rule_id not in self._rule_stats:
            self._rule_stats[rule_id] = RuleStats(rule_id=rule_id)
        return self._rule_stats[rule_id]

    def _get_category_stats(self, category: str) -> RuleStats:
        if category not in self._category_stats:
            self._category_stats[category] = RuleStats(rule_id=category)
        return self._category_stats[category]

    def _get_language_stats(self, language: str) -> RuleStats:
        if language not in self._language_stats:
            self._language_stats[language] = RuleStats(rule_id=language)
        return self._language_stats[language]

    def _trim_history(self) -> None:
        """Trim history to max size."""
        if len(self._history) > self._max_history:
            excess = len(self._history) - self._max_history
            removed = self._history[:excess]
            self._history = self._history[excess:]
            # Clean up lookup
            for record in removed:
                self._fix_lookup.pop(record.fix_id, None)

    # ── Persistence ───────────────────────────────────────────────────

    def save(self) -> None:
        """Persist stats to disk."""
        if not self._persist_path:
            return
        try:
            data = {
                "ruleStats": {
                    rid: stats.to_dict()
                    for rid, stats in self._rule_stats.items()
                },
                "recentOutcomes": [
                    r.to_dict() for r in self._history[-200:]
                ],
                "savedAt": time.time(),
            }
            os.makedirs(os.path.dirname(self._persist_path), exist_ok=True)
            with open(self._persist_path, "w") as f:
                json.dump(data, f, indent=2)
            logger.debug(f"Precision telemetry saved to {self._persist_path}")
        except Exception as e:
            logger.warning(f"Failed to save precision telemetry: {e}")

    def _load(self) -> None:
        """Load persisted stats from disk."""
        if not self._persist_path or not os.path.exists(self._persist_path):
            return
        try:
            with open(self._persist_path, "r") as f:
                data = json.load(f)

            for rid, stats_dict in data.get("ruleStats", {}).items():
                stats = RuleStats(rule_id=rid)
                stats.total_proposed = stats_dict.get("totalProposed", 0)
                stats.total_applied = stats_dict.get("totalApplied", 0)
                stats.total_verified = stats_dict.get("totalVerified", 0)
                stats.total_reverted = stats_dict.get("totalReverted", 0)
                stats.total_rejected = stats_dict.get("totalRejected", 0)
                stats.total_errored = stats_dict.get("totalErrored", 0)
                stats.last_seen = stats_dict.get("lastSeen", 0.0)
                self._rule_stats[rid] = stats

            logger.info(
                f"Loaded precision telemetry: "
                f"{len(self._rule_stats)} rules tracked"
            )
        except Exception as e:
            logger.warning(f"Failed to load precision telemetry: {e}")


# ── Module-level singleton ────────────────────────────────────────────

_precision_telemetry: Optional[PrecisionTelemetry] = None


def get_precision_telemetry(
    persist_path: Optional[str] = None,
) -> PrecisionTelemetry:
    """Get or create global precision telemetry."""
    global _precision_telemetry
    if _precision_telemetry is None:
        _precision_telemetry = PrecisionTelemetry(persist_path=persist_path)
    return _precision_telemetry


def reset_precision_telemetry() -> None:
    """Reset (for testing)."""
    global _precision_telemetry
    _precision_telemetry = None

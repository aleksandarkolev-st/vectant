"""
Canary / Staged Rollout System.

Instead of applying a fix globally and hoping it works, the
canary system:

1. Applies the fix to a limited scope first (canary)
2. Monitors for regressions over a soak period
3. If canary is healthy → promote to full rollout
4. If canary regresses → auto-rollback

Stages:
  CANARY → SOAK → PROMOTE / ROLLBACK

For an IDE like Synthi, "canary" means:
- Apply fix to one file/tab first
- Watch for new errors for N seconds
- If clean, apply to remaining affected files
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Dict, List, Optional, Set

logger = logging.getLogger("healing.canary")


# ── Types ─────────────────────────────────────────────────────────────

class RolloutStage(str, Enum):
    CREATED = "created"
    CANARY = "canary"           # Fix applied to canary scope
    SOAKING = "soaking"         # Monitoring for regressions
    PROMOTING = "promoting"     # Expanding to full scope
    PROMOTED = "promoted"       # Fully rolled out
    ROLLING_BACK = "rolling_back"
    ROLLED_BACK = "rolled_back"
    FAILED = "failed"


class RollbackTrigger(str, Enum):
    """Why a rollout was rolled back."""
    NEW_ERRORS = "new_errors"
    REGRESSION = "regression"
    SOAK_TIMEOUT = "soak_timeout"
    MANUAL = "manual"
    VERIFICATION_FAILED = "verification_failed"


@dataclass
class CanaryConfig:
    """Configuration for canary rollouts."""
    soak_duration_sec: float = 15.0    # How long to soak before promote
    check_interval_sec: float = 3.0     # How often to check during soak
    max_new_errors: int = 0             # Max new errors allowed during soak
    max_soak_retries: int = 3           # Max soak retries before abort
    auto_promote: bool = True           # Auto-promote if soak passes
    auto_rollback: bool = True          # Auto-rollback on regression

    def to_dict(self) -> Dict[str, Any]:
        return {
            "soakDurationSec": self.soak_duration_sec,
            "checkIntervalSec": self.check_interval_sec,
            "maxNewErrors": self.max_new_errors,
            "maxSoakRetries": self.max_soak_retries,
            "autoPromote": self.auto_promote,
            "autoRollback": self.auto_rollback,
        }


@dataclass
class SoakCheck:
    """A single health check during the soak period."""
    timestamp: float
    new_errors: int = 0
    error_messages: List[str] = field(default_factory=list)
    passed: bool = True

    def to_dict(self) -> Dict[str, Any]:
        return {
            "timestamp": self.timestamp,
            "newErrors": self.new_errors,
            "passed": self.passed,
            "errorMessages": self.error_messages[:5],
        }


@dataclass
class CanaryScope:
    """Defines what the canary applies to."""
    canary_files: List[str] = field(default_factory=list)
    remaining_files: List[str] = field(default_factory=list)
    workspace_id: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "canaryFiles": self.canary_files,
            "remainingFiles": self.remaining_files,
            "workspaceId": self.workspace_id,
        }


@dataclass
class RolloutRecord:
    """Full record of a canary rollout."""
    rollout_id: str
    episode_id: str = ""
    stage: RolloutStage = RolloutStage.CREATED
    config: CanaryConfig = field(default_factory=CanaryConfig)
    scope: CanaryScope = field(default_factory=CanaryScope)
    soak_checks: List[SoakCheck] = field(default_factory=list)
    baseline_errors: List[str] = field(default_factory=list)
    rollback_trigger: Optional[RollbackTrigger] = None
    rollback_reason: str = ""
    created_at: float = field(default_factory=time.time)
    canary_started_at: float = 0.0
    soak_started_at: float = 0.0
    promoted_at: float = 0.0
    finished_at: float = 0.0
    metadata: Dict[str, Any] = field(default_factory=dict)

    @property
    def duration_sec(self) -> float:
        if self.created_at:
            end = self.finished_at or time.time()
            return end - self.created_at
        return 0.0

    @property
    def soak_elapsed_sec(self) -> float:
        if self.soak_started_at:
            end = self.finished_at or time.time()
            return end - self.soak_started_at
        return 0.0

    @property
    def soak_complete(self) -> bool:
        return self.soak_elapsed_sec >= self.config.soak_duration_sec

    @property
    def all_checks_passed(self) -> bool:
        return all(c.passed for c in self.soak_checks)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "rolloutId": self.rollout_id,
            "episodeId": self.episode_id,
            "stage": self.stage.value,
            "config": self.config.to_dict(),
            "scope": self.scope.to_dict(),
            "soakChecks": [c.to_dict() for c in self.soak_checks],
            "baselineErrors": self.baseline_errors[:10],
            "rollbackTrigger": self.rollback_trigger.value if self.rollback_trigger else None,
            "rollbackReason": self.rollback_reason,
            "durationSec": round(self.duration_sec, 2),
            "soakElapsedSec": round(self.soak_elapsed_sec, 2),
            "soakComplete": self.soak_complete,
            "allChecksPassed": self.all_checks_passed,
        }


# ── Canary Rollout Engine ────────────────────────────────────────────

class CanaryRolloutEngine:
    """
    Manages canary rollouts for healing fixes.

    Flow:
    1. create_rollout() — define scope and config
    2. start_canary() — apply fix to canary files
    3. start_soak() — begin monitoring period
    4. check_health() — periodic health check during soak
    5. promote() or rollback() based on soak results
    """

    def __init__(
        self,
        default_config: Optional[CanaryConfig] = None,
        apply_fix_fn: Optional[Callable] = None,
        rollback_fn: Optional[Callable] = None,
        get_errors_fn: Optional[Callable] = None,
        on_promote: Optional[Callable] = None,
        on_rollback: Optional[Callable] = None,
    ):
        self._default_config = default_config or CanaryConfig()
        self._apply_fix = apply_fix_fn
        self._rollback = rollback_fn
        self._get_errors = get_errors_fn
        self._on_promote = on_promote
        self._on_rollback = on_rollback

        self._rollouts: Dict[str, RolloutRecord] = {}
        self._max_rollouts: int = 50
        self._stats = {
            "total_rollouts": 0,
            "promoted": 0,
            "rolled_back": 0,
            "failed": 0,
        }

    def create_rollout(
        self,
        canary_files: List[str],
        remaining_files: Optional[List[str]] = None,
        episode_id: str = "",
        config: Optional[CanaryConfig] = None,
        workspace_id: str = "",
    ) -> RolloutRecord:
        """Create a new canary rollout."""
        if len(self._rollouts) >= self._max_rollouts:
            self._evict_oldest()

        rollout_id = f"canary_{int(time.time() * 1000)}"
        record = RolloutRecord(
            rollout_id=rollout_id,
            episode_id=episode_id,
            config=config or self._default_config,
            scope=CanaryScope(
                canary_files=canary_files,
                remaining_files=remaining_files or [],
                workspace_id=workspace_id,
            ),
        )

        self._rollouts[rollout_id] = record
        self._stats["total_rollouts"] += 1

        logger.info(
            f"Created canary rollout {rollout_id}: "
            f"{len(canary_files)} canary files, "
            f"{len(remaining_files or [])} remaining"
        )
        return record

    async def start_canary(
        self,
        rollout_id: str,
        patches: Dict[str, str],  # file_path -> patched content
    ) -> RolloutRecord:
        """
        Apply fix to canary files only.

        Args:
            rollout_id: The rollout to start.
            patches: Map of file_path to new content.
        """
        record = self._rollouts.get(rollout_id)
        if not record:
            raise ValueError(f"Unknown rollout: {rollout_id}")

        # Capture baseline errors before applying fix
        if self._get_errors:
            try:
                baseline = await self._get_errors(record.scope.canary_files)
                record.baseline_errors = (
                    baseline if isinstance(baseline, list)
                    else [str(baseline)]
                )
            except Exception as e:
                logger.debug(f"Cannot get baseline errors: {e}")

        # Apply patches to canary files only
        record.stage = RolloutStage.CANARY
        record.canary_started_at = time.time()

        if self._apply_fix:
            for file_path in record.scope.canary_files:
                if file_path in patches:
                    try:
                        await self._apply_fix(file_path, patches[file_path])
                    except Exception as e:
                        record.stage = RolloutStage.FAILED
                        record.rollback_reason = f"Apply failed: {e}"
                        record.finished_at = time.time()
                        self._stats["failed"] += 1
                        return record

        logger.info(f"Canary {rollout_id}: applied to {len(record.scope.canary_files)} files")
        return record

    async def start_soak(self, rollout_id: str) -> RolloutRecord:
        """Begin the soak monitoring period."""
        record = self._rollouts.get(rollout_id)
        if not record:
            raise ValueError(f"Unknown rollout: {rollout_id}")

        record.stage = RolloutStage.SOAKING
        record.soak_started_at = time.time()
        logger.info(
            f"Canary {rollout_id}: soak started "
            f"(duration={record.config.soak_duration_sec}s)"
        )
        return record

    async def check_health(self, rollout_id: str) -> SoakCheck:
        """
        Perform a health check during the soak period.

        Returns a SoakCheck indicating pass/fail.
        """
        record = self._rollouts.get(rollout_id)
        if not record:
            raise ValueError(f"Unknown rollout: {rollout_id}")

        check = SoakCheck(timestamp=time.time())

        if self._get_errors:
            try:
                current_errors = await self._get_errors(record.scope.canary_files)
                if isinstance(current_errors, list):
                    # Count new errors not in baseline
                    baseline_set = set(record.baseline_errors)
                    new_errors = [e for e in current_errors if e not in baseline_set]
                    check.new_errors = len(new_errors)
                    check.error_messages = new_errors[:5]
            except Exception as e:
                logger.debug(f"Health check error lookup failed: {e}")

        check.passed = check.new_errors <= record.config.max_new_errors
        record.soak_checks.append(check)

        if not check.passed and record.config.auto_rollback:
            logger.warning(
                f"Canary {rollout_id}: health check failed "
                f"({check.new_errors} new errors)"
            )
            await self.rollback(
                rollout_id,
                RollbackTrigger.NEW_ERRORS,
                f"{check.new_errors} new errors detected",
            )

        return check

    async def promote(self, rollout_id: str) -> RolloutRecord:
        """
        Promote the fix from canary to full scope.

        Applies the fix to all remaining files.
        """
        record = self._rollouts.get(rollout_id)
        if not record:
            raise ValueError(f"Unknown rollout: {rollout_id}")

        if not record.all_checks_passed:
            logger.warning(f"Canary {rollout_id}: promoting despite failed checks")

        record.stage = RolloutStage.PROMOTING

        # The promote callback handles applying to remaining files
        if self._on_promote:
            try:
                await self._on_promote(record)
            except Exception as e:
                record.stage = RolloutStage.FAILED
                record.rollback_reason = f"Promote failed: {e}"
                record.finished_at = time.time()
                self._stats["failed"] += 1
                return record

        record.stage = RolloutStage.PROMOTED
        record.promoted_at = time.time()
        record.finished_at = time.time()
        self._stats["promoted"] += 1

        logger.info(
            f"Canary {rollout_id}: promoted to full scope "
            f"({len(record.scope.remaining_files)} additional files)"
        )
        return record

    async def rollback(
        self,
        rollout_id: str,
        trigger: RollbackTrigger = RollbackTrigger.MANUAL,
        reason: str = "",
    ) -> RolloutRecord:
        """Roll back the canary fix."""
        record = self._rollouts.get(rollout_id)
        if not record:
            raise ValueError(f"Unknown rollout: {rollout_id}")

        record.stage = RolloutStage.ROLLING_BACK
        record.rollback_trigger = trigger
        record.rollback_reason = reason

        if self._rollback:
            try:
                await self._rollback(record)
            except Exception as e:
                record.stage = RolloutStage.FAILED
                record.rollback_reason += f"; rollback error: {e}"
                record.finished_at = time.time()
                self._stats["failed"] += 1
                return record

        if self._on_rollback:
            try:
                await self._on_rollback(record)
            except Exception:
                pass

        record.stage = RolloutStage.ROLLED_BACK
        record.finished_at = time.time()
        self._stats["rolled_back"] += 1

        logger.info(
            f"Canary {rollout_id}: rolled back "
            f"(trigger={trigger.value}, reason={reason})"
        )
        return record

    async def run_full_canary(
        self,
        canary_files: List[str],
        remaining_files: List[str],
        patches: Dict[str, str],
        episode_id: str = "",
        config: Optional[CanaryConfig] = None,
    ) -> RolloutRecord:
        """
        Run a complete canary rollout: create → canary → soak → promote/rollback.

        This is the main entry point for automated canary rollouts.
        """
        import asyncio

        cfg = config or self._default_config

        # Create rollout
        record = self.create_rollout(
            canary_files=canary_files,
            remaining_files=remaining_files,
            episode_id=episode_id,
            config=cfg,
        )

        # Apply to canary
        record = await self.start_canary(record.rollout_id, patches)
        if record.stage == RolloutStage.FAILED:
            return record

        # Start soak
        record = await self.start_soak(record.rollout_id)

        # Soak loop
        soak_start = time.time()
        retries = 0

        while (time.time() - soak_start) < cfg.soak_duration_sec:
            await asyncio.sleep(cfg.check_interval_sec)

            check = await self.check_health(record.rollout_id)

            if record.stage in (RolloutStage.ROLLED_BACK, RolloutStage.FAILED):
                return record

            if not check.passed:
                retries += 1
                if retries >= cfg.max_soak_retries:
                    await self.rollback(
                        record.rollout_id,
                        RollbackTrigger.REGRESSION,
                        f"Soak failed after {retries} retries",
                    )
                    return record

        # Soak complete — promote
        if cfg.auto_promote and record.all_checks_passed:
            record = await self.promote(record.rollout_id)
        elif not record.all_checks_passed:
            await self.rollback(
                record.rollout_id,
                RollbackTrigger.VERIFICATION_FAILED,
                "Soak checks did not all pass",
            )

        return record

    # ── Query ─────────────────────────────────────────────────────────

    def get_rollout(self, rollout_id: str) -> Optional[RolloutRecord]:
        return self._rollouts.get(rollout_id)

    def list_rollouts(
        self,
        stage: Optional[RolloutStage] = None,
    ) -> List[Dict[str, Any]]:
        rollouts = self._rollouts.values()
        if stage:
            rollouts = [r for r in rollouts if r.stage == stage]
        return [r.to_dict() for r in rollouts]

    def _evict_oldest(self) -> None:
        """Remove oldest completed rollout."""
        completed = [
            (rid, r) for rid, r in self._rollouts.items()
            if r.stage in (
                RolloutStage.PROMOTED, RolloutStage.ROLLED_BACK,
                RolloutStage.FAILED,
            )
        ]
        if completed:
            oldest_id = min(completed, key=lambda x: x[1].created_at)[0]
            del self._rollouts[oldest_id]

    @property
    def stats(self) -> Dict[str, Any]:
        return {
            **self._stats,
            "activeRollouts": len([
                r for r in self._rollouts.values()
                if r.stage in (
                    RolloutStage.CANARY, RolloutStage.SOAKING,
                    RolloutStage.PROMOTING,
                )
            ]),
        }


# ── Module-level singleton ────────────────────────────────────────────

_canary_engine: Optional[CanaryRolloutEngine] = None


def get_canary_engine(**kwargs) -> CanaryRolloutEngine:
    global _canary_engine
    if _canary_engine is None:
        _canary_engine = CanaryRolloutEngine(**kwargs)
    return _canary_engine


def reset_canary_engine() -> None:
    global _canary_engine
    _canary_engine = None

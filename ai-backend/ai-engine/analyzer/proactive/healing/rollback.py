"""
Transactional Rollback System.

System-level rollback, not just UI-level undo in Monaco.

Provides repair transactions that:
1. Snapshot file state (content hashes + content)
2. Apply patch set atomically
3. Verify via verification pipeline
4. Commit only if ALL checks pass
5. Auto-rollback on failure/timeout/new-error-class

Tracks rollback reasons for learning.

Design:
- Each transaction is a set of file modifications
- Snapshots are stored in-memory (with optional disk persistence)
- Rollback restores exact original content
- Transaction log for audit trail
"""

from __future__ import annotations

import difflib
import hashlib
import logging
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Dict, List, Optional, Tuple

logger = logging.getLogger("healing.rollback")


# ── Transaction states ────────────────────────────────────────────────

class TransactionState(str, Enum):
    """States of a repair transaction."""
    PENDING = "pending"           # Created, no patches applied yet
    APPLYING = "applying"         # Patches being applied
    APPLIED = "applied"           # All patches applied, awaiting verification
    VERIFYING = "verifying"       # Verification in progress
    COMMITTED = "committed"       # Verification passed, transaction final
    ROLLING_BACK = "rolling_back" # Rolling back changes
    ROLLED_BACK = "rolled_back"   # All changes rolled back
    FAILED = "failed"             # Transaction failed (partial state)


# ── File snapshot ─────────────────────────────────────────────────────

@dataclass
class FileSnapshot:
    """Snapshot of a file's content at a point in time."""
    file_path: str
    content: str
    content_hash: str
    timestamp: float = field(default_factory=time.time)

    @staticmethod
    def from_content(file_path: str, content: str) -> "FileSnapshot":
        return FileSnapshot(
            file_path=file_path,
            content=content,
            content_hash=hashlib.sha256(content.encode()).hexdigest()[:16],
        )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "filePath": self.file_path,
            "contentHash": self.content_hash,
            "timestamp": self.timestamp,
            "contentLength": len(self.content),
        }


@dataclass
class FilePatch:
    """A patch to apply to a file."""
    file_path: str
    original_content: str
    patched_content: str
    diff_text: str = ""
    description: str = ""
    fix_ids: List[str] = field(default_factory=list)

    def __post_init__(self):
        if not self.diff_text:
            self.diff_text = self._compute_diff()

    def _compute_diff(self) -> str:
        """Compute unified diff."""
        orig_lines = self.original_content.splitlines(keepends=True)
        patch_lines = self.patched_content.splitlines(keepends=True)
        return "".join(difflib.unified_diff(
            orig_lines, patch_lines,
            fromfile=f"a/{self.file_path}",
            tofile=f"b/{self.file_path}",
        ))

    def to_dict(self) -> Dict[str, Any]:
        return {
            "filePath": self.file_path,
            "diffText": self.diff_text,
            "description": self.description,
            "fixIds": self.fix_ids,
            "linesChanged": self.diff_text.count("\n"),
        }


@dataclass
class RollbackReason:
    """Why a rollback happened — tracked for learning."""
    reason_type: str      # "verification_failed", "timeout", "new_error", "user_request", "budget_exhausted"
    details: str = ""
    verification_stage: str = ""  # Which verification stage failed
    new_errors: List[str] = field(default_factory=list)
    timestamp: float = field(default_factory=time.time)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "reasonType": self.reason_type,
            "details": self.details,
            "verificationStage": self.verification_stage,
            "newErrors": self.new_errors,
            "timestamp": self.timestamp,
        }


# ── Repair Transaction ───────────────────────────────────────────────

class RepairTransaction:
    """
    An atomic set of file modifications with rollback support.

    Usage:
        tx = RepairTransaction(episode_id="abc123")
        
        # Snapshot original state
        tx.snapshot_file("src/app.py", original_content)
        
        # Add patches
        tx.add_patch(FilePatch(
            file_path="src/app.py",
            original_content=original_content,
            patched_content=fixed_content,
        ))
        
        # Apply (calls write_fn for each patch)
        await tx.apply(write_fn)
        
        # Verify
        verification_result = await pipeline.run_pipeline(...)
        
        if verification_result.overall_passed:
            tx.commit()
        else:
            await tx.rollback(
                write_fn,
                reason=RollbackReason(
                    reason_type="verification_failed",
                    details="typecheck failed",
                ),
            )
    """

    def __init__(
        self,
        episode_id: str = "",
        transaction_id: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ):
        self.transaction_id = transaction_id or uuid.uuid4().hex[:12]
        self.episode_id = episode_id
        self.metadata = metadata or {}

        self._state = TransactionState.PENDING
        self._created_at = time.time()
        self._finished_at: Optional[float] = None

        # File snapshots (original state)
        self._snapshots: Dict[str, FileSnapshot] = {}

        # Patches to apply
        self._patches: List[FilePatch] = []

        # Applied patches (tracking)
        self._applied_patches: List[FilePatch] = []

        # Rollback info
        self._rollback_reason: Optional[RollbackReason] = None
        self._rollback_history: List[RollbackReason] = []

        # Listeners
        self._listeners: List[Callable] = []

        logger.debug(
            f"Transaction {self.transaction_id} created "
            f"(episode: {episode_id})"
        )

    @property
    def state(self) -> TransactionState:
        return self._state

    @property
    def is_terminal(self) -> bool:
        return self._state in {
            TransactionState.COMMITTED,
            TransactionState.ROLLED_BACK,
            TransactionState.FAILED,
        }

    @property
    def patches(self) -> List[FilePatch]:
        return list(self._patches)

    @property
    def snapshots(self) -> Dict[str, FileSnapshot]:
        return dict(self._snapshots)

    @property
    def rollback_reason(self) -> Optional[RollbackReason]:
        return self._rollback_reason

    def on_state_change(self, listener: Callable) -> Callable:
        self._listeners.append(listener)
        return lambda: self._listeners.remove(listener)

    def _set_state(self, new_state: TransactionState) -> None:
        old = self._state
        self._state = new_state
        if self.is_terminal:
            self._finished_at = time.time()
        logger.debug(
            f"Transaction {self.transaction_id}: "
            f"{old.value} → {new_state.value}"
        )
        for listener in self._listeners:
            try:
                listener(self, old, new_state)
            except Exception as e:
                logger.warning(f"Transaction listener error: {e}")

    # ── Snapshot & patch ──────────────────────────────────────────────

    def snapshot_file(self, file_path: str, content: str) -> FileSnapshot:
        """Take a snapshot of file content before modification."""
        snapshot = FileSnapshot.from_content(file_path, content)
        self._snapshots[file_path] = snapshot
        return snapshot

    def add_patch(self, patch: FilePatch) -> None:
        """Add a file patch to the transaction."""
        if self._state != TransactionState.PENDING:
            raise RuntimeError(
                f"Cannot add patches in state {self._state.value}"
            )
        # Auto-snapshot if not already done
        if patch.file_path not in self._snapshots:
            self.snapshot_file(patch.file_path, patch.original_content)
        self._patches.append(patch)

    # ── Apply ─────────────────────────────────────────────────────────

    async def apply(
        self,
        write_fn: Callable[[str, str], Any],
    ) -> bool:
        """
        Apply all patches using the provided write function.

        write_fn(file_path, new_content) -> None

        Returns True if all patches applied successfully.
        """
        if self._state != TransactionState.PENDING:
            raise RuntimeError(
                f"Cannot apply in state {self._state.value}"
            )

        self._set_state(TransactionState.APPLYING)
        self._applied_patches = []

        try:
            for patch in self._patches:
                if callable(write_fn) and _is_coroutine(write_fn):
                    await write_fn(patch.file_path, patch.patched_content)
                else:
                    write_fn(patch.file_path, patch.patched_content)
                self._applied_patches.append(patch)

            self._set_state(TransactionState.APPLIED)
            logger.info(
                f"Transaction {self.transaction_id}: "
                f"applied {len(self._applied_patches)} patches"
            )
            return True

        except Exception as e:
            logger.error(
                f"Transaction {self.transaction_id}: "
                f"apply failed at patch {len(self._applied_patches)}: {e}"
            )
            # Partial apply — need to rollback what we applied
            self._set_state(TransactionState.FAILED)
            return False

    def apply_sync(
        self,
        write_fn: Callable[[str, str], None],
    ) -> bool:
        """Synchronous version of apply()."""
        if self._state != TransactionState.PENDING:
            raise RuntimeError(
                f"Cannot apply in state {self._state.value}"
            )

        self._set_state(TransactionState.APPLYING)
        self._applied_patches = []

        try:
            for patch in self._patches:
                write_fn(patch.file_path, patch.patched_content)
                self._applied_patches.append(patch)

            self._set_state(TransactionState.APPLIED)
            return True
        except Exception as e:
            logger.error(f"Transaction {self.transaction_id}: apply failed: {e}")
            self._set_state(TransactionState.FAILED)
            return False

    # ── Commit ────────────────────────────────────────────────────────

    def commit(self) -> None:
        """Mark transaction as committed (verification passed)."""
        if self._state not in (
            TransactionState.APPLIED,
            TransactionState.VERIFYING,
        ):
            raise RuntimeError(
                f"Cannot commit in state {self._state.value}"
            )
        self._set_state(TransactionState.COMMITTED)
        logger.info(
            f"Transaction {self.transaction_id} committed "
            f"({len(self._applied_patches)} patches)"
        )

    # ── Rollback ──────────────────────────────────────────────────────

    async def rollback(
        self,
        write_fn: Callable[[str, str], Any],
        reason: Optional[RollbackReason] = None,
    ) -> bool:
        """
        Roll back all applied patches to original content.

        Returns True if rollback succeeded.
        """
        if self._state not in (
            TransactionState.APPLIED,
            TransactionState.VERIFYING,
            TransactionState.FAILED,
        ):
            raise RuntimeError(
                f"Cannot rollback in state {self._state.value}"
            )

        self._rollback_reason = reason
        if reason:
            self._rollback_history.append(reason)

        self._set_state(TransactionState.ROLLING_BACK)

        try:
            # Restore in reverse order
            for patch in reversed(self._applied_patches):
                snapshot = self._snapshots.get(patch.file_path)
                if snapshot:
                    if callable(write_fn) and _is_coroutine(write_fn):
                        await write_fn(patch.file_path, snapshot.content)
                    else:
                        write_fn(patch.file_path, snapshot.content)

            self._set_state(TransactionState.ROLLED_BACK)
            logger.info(
                f"Transaction {self.transaction_id} rolled back "
                f"({len(self._applied_patches)} patches restored)"
                f"{f': {reason.reason_type}' if reason else ''}"
            )
            return True

        except Exception as e:
            logger.error(
                f"Transaction {self.transaction_id}: rollback failed: {e}"
            )
            self._set_state(TransactionState.FAILED)
            return False

    def rollback_sync(
        self,
        write_fn: Callable[[str, str], None],
        reason: Optional[RollbackReason] = None,
    ) -> bool:
        """Synchronous version of rollback()."""
        if self._state not in (
            TransactionState.APPLIED,
            TransactionState.VERIFYING,
            TransactionState.FAILED,
        ):
            raise RuntimeError(
                f"Cannot rollback in state {self._state.value}"
            )

        self._rollback_reason = reason
        if reason:
            self._rollback_history.append(reason)

        self._set_state(TransactionState.ROLLING_BACK)

        try:
            for patch in reversed(self._applied_patches):
                snapshot = self._snapshots.get(patch.file_path)
                if snapshot:
                    write_fn(patch.file_path, snapshot.content)

            self._set_state(TransactionState.ROLLED_BACK)
            return True
        except Exception as e:
            logger.error(f"Transaction {self.transaction_id}: rollback failed: {e}")
            self._set_state(TransactionState.FAILED)
            return False

    # ── Verification gate ─────────────────────────────────────────────

    def begin_verification(self) -> None:
        """Mark that verification has started."""
        if self._state != TransactionState.APPLIED:
            raise RuntimeError(
                f"Cannot verify in state {self._state.value}"
            )
        self._set_state(TransactionState.VERIFYING)

    # ── Serialization ─────────────────────────────────────────────────

    def to_dict(self) -> Dict[str, Any]:
        return {
            "transactionId": self.transaction_id,
            "episodeId": self.episode_id,
            "state": self._state.value,
            "createdAt": self._created_at,
            "finishedAt": self._finished_at,
            "metadata": self.metadata,
            "snapshots": {
                fp: s.to_dict() for fp, s in self._snapshots.items()
            },
            "patches": [p.to_dict() for p in self._patches],
            "appliedPatches": len(self._applied_patches),
            "rollbackReason": (
                self._rollback_reason.to_dict()
                if self._rollback_reason else None
            ),
            "rollbackHistory": [r.to_dict() for r in self._rollback_history],
        }


# ── Transaction Manager ──────────────────────────────────────────────

class TransactionManager:
    """
    Manages repair transactions across the system.

    Provides:
    - Transaction creation and lookup
    - Active transaction tracking per file
    - Rollback-reason aggregation for learning
    - Audit trail
    """

    def __init__(self, max_transactions: int = 200):
        self._transactions: Dict[str, RepairTransaction] = {}
        self._active_by_file: Dict[str, str] = {}  # file_path → tx_id
        self._max_transactions = max_transactions

    def create_transaction(
        self,
        episode_id: str = "",
        metadata: Optional[Dict[str, Any]] = None,
    ) -> RepairTransaction:
        """Create a new transaction."""
        tx = RepairTransaction(
            episode_id=episode_id,
            metadata=metadata,
        )
        self._transactions[tx.transaction_id] = tx
        self._evict_if_needed()
        return tx

    def get(self, transaction_id: str) -> Optional[RepairTransaction]:
        return self._transactions.get(transaction_id)

    def get_active_for_file(self, file_path: str) -> Optional[RepairTransaction]:
        """Get the active (non-terminal) transaction for a file."""
        tx_id = self._active_by_file.get(file_path)
        if tx_id:
            tx = self._transactions.get(tx_id)
            if tx and not tx.is_terminal:
                return tx
            # Stale entry
            del self._active_by_file[file_path]
        return None

    def register_file_transaction(
        self, file_path: str, transaction_id: str
    ) -> None:
        """Register that a file is being modified by a transaction."""
        self._active_by_file[file_path] = transaction_id

    def list_recent(self, limit: int = 20) -> List[RepairTransaction]:
        txs = sorted(
            self._transactions.values(),
            key=lambda tx: tx._created_at,
            reverse=True,
        )
        return txs[:limit]

    def rollback_reasons_summary(self) -> Dict[str, int]:
        """Aggregate rollback reasons for learning."""
        reasons: Dict[str, int] = {}
        for tx in self._transactions.values():
            if tx.rollback_reason:
                rt = tx.rollback_reason.reason_type
                reasons[rt] = reasons.get(rt, 0) + 1
        return reasons

    def stats(self) -> Dict[str, Any]:
        by_state: Dict[str, int] = {}
        for tx in self._transactions.values():
            state = tx.state.value
            by_state[state] = by_state.get(state, 0) + 1

        return {
            "total": len(self._transactions),
            "activeFiles": len(self._active_by_file),
            "byState": by_state,
            "rollbackReasons": self.rollback_reasons_summary(),
        }

    def _evict_if_needed(self) -> None:
        if len(self._transactions) <= self._max_transactions:
            return
        terminal = sorted(
            [
                (tid, tx) for tid, tx in self._transactions.items()
                if tx.is_terminal
            ],
            key=lambda x: x[1]._created_at,
        )
        while len(self._transactions) > self._max_transactions and terminal:
            tid, _ = terminal.pop(0)
            del self._transactions[tid]


# ── Helpers ───────────────────────────────────────────────────────────

def _is_coroutine(fn: Any) -> bool:
    """Check if a callable is a coroutine function."""
    import asyncio
    return asyncio.iscoroutinefunction(fn)


# ── Module-level singleton ────────────────────────────────────────────

_transaction_manager: Optional[TransactionManager] = None


def get_transaction_manager() -> TransactionManager:
    """Get or create the global transaction manager."""
    global _transaction_manager
    if _transaction_manager is None:
        _transaction_manager = TransactionManager()
    return _transaction_manager


def reset_transaction_manager() -> None:
    """Reset (for testing)."""
    global _transaction_manager
    _transaction_manager = None

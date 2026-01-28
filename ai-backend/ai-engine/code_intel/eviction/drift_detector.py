"""
Drift Detection - Detect when indexed content diverges from actual files.

This is CRITICAL for correctness. If the index is stale, the AI will:
1. Reference code that no longer exists
2. Miss new functions
3. Make incorrect edits

Drift types:
- File modified but not re-indexed
- File deleted but still in index
- New files not indexed
- Symbol locations changed (code moved)

Detection strategies:
- File hash comparison
- Modification time tracking
- Symbol signature hashing
- Periodic full scan

Resolution:
- Re-index drifted files
- Expire stale cache entries
- Signal to retrieval that context may be incomplete
"""

from __future__ import annotations

import hashlib
import logging
import time
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple

from ..core.types import SemanticChunk


logger = logging.getLogger("code_intel.eviction.drift")


class DriftType(Enum):
    """Type of drift detected."""
    
    FILE_MODIFIED = "file_modified"      # File content changed
    FILE_DELETED = "file_deleted"        # File no longer exists
    FILE_NEW = "file_new"                # New file not indexed
    SYMBOL_MOVED = "symbol_moved"        # Symbol location changed
    SYMBOL_SIGNATURE = "symbol_signature"  # Signature changed
    INDEX_CORRUPTED = "index_corrupted"  # Index data is invalid


class DriftSeverity(Enum):
    """Severity of drift."""
    
    LOW = "low"        # Minor drift, index still usable
    MEDIUM = "medium"  # Significant drift, may affect retrieval
    HIGH = "high"      # Severe drift, index unreliable
    CRITICAL = "critical"  # Index completely stale


@dataclass
class DriftReport:
    """Report of detected drift."""
    
    # Drifted items
    modified_files: List[str] = field(default_factory=list)
    deleted_files: List[str] = field(default_factory=list)
    new_files: List[str] = field(default_factory=list)
    moved_symbols: List[Tuple[str, str, str]] = field(default_factory=list)  # (name, old_file, new_file)
    
    # Statistics
    total_drift_count: int = 0
    severity: DriftSeverity = DriftSeverity.LOW
    
    # Timing
    detected_at: float = 0.0
    time_since_index: float = 0.0
    
    # Recommendations
    files_to_reindex: Set[str] = field(default_factory=set)
    chunks_to_expire: Set[str] = field(default_factory=set)
    
    def is_significant(self) -> bool:
        """Check if drift is significant enough to act on."""
        return self.severity in (DriftSeverity.HIGH, DriftSeverity.CRITICAL)
    
    def get_summary(self) -> str:
        """Get human-readable summary."""
        lines = [f"Drift Report ({self.severity.value}):"]
        
        if self.modified_files:
            lines.append(f"  Modified: {len(self.modified_files)} files")
            for f in self.modified_files[:3]:
                lines.append(f"    ~ {f}")
        
        if self.deleted_files:
            lines.append(f"  Deleted: {len(self.deleted_files)} files")
            for f in self.deleted_files[:3]:
                lines.append(f"    - {f}")
        
        if self.new_files:
            lines.append(f"  New: {len(self.new_files)} files")
            for f in self.new_files[:3]:
                lines.append(f"    + {f}")
        
        if self.files_to_reindex:
            lines.append(f"  Action: Re-index {len(self.files_to_reindex)} files")
        
        return "\n".join(lines)


class DriftDetector:
    """
    Detect drift between index and actual files.
    
    Uses multiple strategies:
    1. File hash tracking (most reliable)
    2. Modification time checking (fast)
    3. Symbol signature comparison (semantic)
    """
    
    def __init__(
        self,
        workspace_root: str,
        index_metadata: Dict[str, Dict],
    ):
        self.workspace_root = Path(workspace_root)
        self.index_metadata = index_metadata  # file_path -> {hash, mtime, symbols}
        
        # Track file hashes
        self._file_hashes: Dict[str, str] = {}
        self._file_mtimes: Dict[str, float] = {}
        
        # Detection settings
        self.check_interval_seconds = 60  # How often to check
        self._last_check = 0.0
    
    def detect(
        self,
        files_to_check: Optional[List[str]] = None,
        full_scan: bool = False,
    ) -> DriftReport:
        """
        Detect drift in workspace.
        
        Args:
            files_to_check: Specific files to check (None = all indexed)
            full_scan: Also check for new files
            
        Returns:
            DriftReport with detected drift
        """
        report = DriftReport(detected_at=time.time())
        
        # Get files to check
        if files_to_check:
            check_files = files_to_check
        else:
            check_files = list(self.index_metadata.keys())
        
        # Check each indexed file
        for file_path in check_files:
            drift = self._check_file(file_path)
            if drift:
                self._record_drift(report, file_path, drift)
        
        # Check for new files if requested
        if full_scan:
            new_files = self._find_new_files()
            report.new_files.extend(new_files)
            report.files_to_reindex.update(new_files)
        
        # Calculate severity
        report.total_drift_count = (
            len(report.modified_files) +
            len(report.deleted_files) +
            len(report.new_files)
        )
        report.severity = self._calculate_severity(report)
        
        self._last_check = time.time()
        return report
    
    def _check_file(self, file_path: str) -> Optional[DriftType]:
        """Check a single file for drift."""
        full_path = self.workspace_root / file_path
        
        # Check if file exists
        if not full_path.exists():
            return DriftType.FILE_DELETED
        
        # Get current state
        try:
            current_mtime = full_path.stat().st_mtime
            current_hash = self._compute_file_hash(full_path)
        except Exception as e:
            logger.warning(f"Error checking file {file_path}: {e}")
            return None
        
        # Get indexed state
        indexed = self.index_metadata.get(file_path, {})
        indexed_hash = indexed.get("hash", "")
        indexed_mtime = indexed.get("mtime", 0)
        
        # Check for modification
        if current_hash != indexed_hash:
            return DriftType.FILE_MODIFIED
        
        # Even if hash matches, flag if mtime is much newer
        if current_mtime - indexed_mtime > 3600:  # 1 hour
            return DriftType.FILE_MODIFIED
        
        return None
    
    def _compute_file_hash(self, path: Path) -> str:
        """Compute hash of file contents."""
        try:
            content = path.read_bytes()
            return hashlib.sha256(content).hexdigest()[:16]
        except Exception:
            return ""
    
    def _find_new_files(self) -> List[str]:
        """Find files not in index."""
        new_files = []
        indexed = set(self.index_metadata.keys())
        
        # Walk workspace
        for path in self.workspace_root.rglob("*"):
            if not path.is_file():
                continue
            
            # Skip hidden and common excludes
            rel_path = str(path.relative_to(self.workspace_root))
            if any(part.startswith(".") for part in rel_path.split("/")):
                continue
            if any(x in rel_path for x in ["node_modules", "__pycache__", ".git", "dist", "build"]):
                continue
            
            # Check if indexed
            if rel_path not in indexed:
                # Only include code files
                if path.suffix in (".py", ".js", ".ts", ".jsx", ".tsx", ".java", ".go", ".rs", ".cpp", ".c", ".h"):
                    new_files.append(rel_path)
        
        return new_files
    
    def _record_drift(
        self,
        report: DriftReport,
        file_path: str,
        drift_type: DriftType,
    ) -> None:
        """Record drift in report."""
        if drift_type == DriftType.FILE_MODIFIED:
            report.modified_files.append(file_path)
            report.files_to_reindex.add(file_path)
        elif drift_type == DriftType.FILE_DELETED:
            report.deleted_files.append(file_path)
            # Find chunks to expire
            if file_path in self.index_metadata:
                chunks = self.index_metadata[file_path].get("chunks", [])
                report.chunks_to_expire.update(chunks)
    
    def _calculate_severity(self, report: DriftReport) -> DriftSeverity:
        """Calculate overall severity of drift."""
        total = report.total_drift_count
        
        if total == 0:
            return DriftSeverity.LOW
        elif total <= 3:
            return DriftSeverity.LOW
        elif total <= 10:
            return DriftSeverity.MEDIUM
        elif total <= 50:
            return DriftSeverity.HIGH
        else:
            return DriftSeverity.CRITICAL
    
    def update_metadata(
        self,
        file_path: str,
        file_hash: str,
        mtime: float,
        chunks: List[str],
    ) -> None:
        """Update tracked metadata for a file."""
        self.index_metadata[file_path] = {
            "hash": file_hash,
            "mtime": mtime,
            "chunks": chunks,
        }
    
    def should_check(self) -> bool:
        """Check if enough time has passed since last drift check."""
        return time.time() - self._last_check > self.check_interval_seconds


class AutoDriftResolver:
    """
    Automatically resolve drift by triggering re-indexing.
    
    Strategies:
    - Immediate re-index for high severity
    - Background re-index for medium severity
    - Lazy re-index for low severity (on next query)
    """
    
    def __init__(
        self,
        indexer,  # DualIndexer or similar
        on_reindex_complete: Optional[callable] = None,
    ):
        self.indexer = indexer
        self.on_reindex_complete = on_reindex_complete
        
        # Queue of files to reindex
        self._pending_files: List[str] = []
        self._in_progress: Set[str] = set()
    
    async def resolve(self, report: DriftReport) -> Dict[str, int]:
        """
        Resolve drift based on report.
        
        Returns:
            Statistics about resolution
        """
        stats = {"files_reindexed": 0, "chunks_expired": 0}
        
        if not report.is_significant() and not report.files_to_reindex:
            return stats
        
        # Expire chunks from deleted files
        if report.chunks_to_expire:
            await self._expire_chunks(report.chunks_to_expire)
            stats["chunks_expired"] = len(report.chunks_to_expire)
        
        # Re-index modified and new files
        for file_path in report.files_to_reindex:
            if file_path not in self._in_progress:
                self._in_progress.add(file_path)
                try:
                    await self._reindex_file(file_path)
                    stats["files_reindexed"] += 1
                finally:
                    self._in_progress.discard(file_path)
        
        if self.on_reindex_complete:
            self.on_reindex_complete(stats)
        
        return stats
    
    async def _expire_chunks(self, chunk_ids: Set[str]) -> None:
        """Remove expired chunks from index."""
        if hasattr(self.indexer, "remove_chunks"):
            await self.indexer.remove_chunks(list(chunk_ids))
    
    async def _reindex_file(self, file_path: str) -> None:
        """Re-index a single file."""
        if hasattr(self.indexer, "index_file"):
            await self.indexer.index_file(file_path)
    
    def queue_file(self, file_path: str) -> None:
        """Queue a file for later re-indexing."""
        if file_path not in self._pending_files:
            self._pending_files.append(file_path)
    
    async def process_queue(self, max_files: int = 10) -> int:
        """Process queued files."""
        processed = 0
        while self._pending_files and processed < max_files:
            file_path = self._pending_files.pop(0)
            await self._reindex_file(file_path)
            processed += 1
        return processed


# Convenience function
def check_drift(
    workspace_root: str,
    index_metadata: Dict[str, Dict],
    full_scan: bool = False,
) -> DriftReport:
    """
    Convenience function to check for drift.
    
    Args:
        workspace_root: Path to workspace
        index_metadata: Current index metadata
        full_scan: Whether to scan for new files
        
    Returns:
        DriftReport
    """
    detector = DriftDetector(workspace_root, index_metadata)
    return detector.detect(full_scan=full_scan)

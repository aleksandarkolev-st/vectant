"""
Conflict Detector - Detect conflicts between edits and external changes.

Detects:
- Concurrent modifications to same file
- Conflicting edits to same lines
- External changes since context was loaded
"""

from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple

from .edit_planner import EditPlan, PlannedEdit


logger = logging.getLogger("code_intel.editing.conflict")


class ConflictType(Enum):
    """Types of conflicts."""
    
    FILE_MODIFIED = "file_modified"  # File changed externally
    FILE_DELETED = "file_deleted"  # File deleted externally
    FILE_CREATED = "file_created"  # File created (when we want to create)
    OVERLAPPING_LINES = "overlapping_lines"  # Multiple edits to same lines
    DEPENDENCY_MISSING = "dependency_missing"  # Edit depends on non-existent code


@dataclass
class Conflict:
    """A detected conflict."""
    
    conflict_type: ConflictType
    file_path: str
    description: str
    
    # Related edits
    edit_ids: List[str] = field(default_factory=list)
    
    # Affected lines
    lines: Optional[Tuple[int, int]] = None
    
    # Resolution options
    can_merge: bool = False
    suggested_resolution: str = ""


@dataclass
class ConflictReport:
    """Report of all conflicts in a plan."""
    
    has_conflicts: bool = False
    conflicts: List[Conflict] = field(default_factory=list)
    
    # Statistics
    files_with_conflicts: int = 0
    total_conflicts: int = 0
    
    def get_summary(self) -> str:
        """Get summary of conflicts."""
        if not self.has_conflicts:
            return "No conflicts detected"
        
        lines = [f"⚠️ {self.total_conflicts} conflict(s) in {self.files_with_conflicts} file(s)"]
        
        for conflict in self.conflicts[:5]:
            lines.append(f"  - {conflict.file_path}: {conflict.description}")
        
        if len(self.conflicts) > 5:
            lines.append(f"  ... and {len(self.conflicts) - 5} more")
        
        return "\n".join(lines)


class ConflictDetector:
    """
    Detect conflicts before executing edits.
    
    Checks:
    - File modifications since context was loaded
    - Overlapping edits within a plan
    - Cross-plan conflicts
    """
    
    def __init__(
        self,
        workspace_root: str,
    ):
        self.workspace_root = Path(workspace_root)
        
        # Track known file states
        self._file_hashes: Dict[str, str] = {}
    
    def snapshot_files(self, file_paths: List[str]) -> Dict[str, str]:
        """
        Take a snapshot of current file hashes.
        
        Call this when loading context to later detect changes.
        """
        hashes = {}
        
        for file_path in file_paths:
            hash_value = self._compute_hash(file_path)
            if hash_value:
                hashes[file_path] = hash_value
                self._file_hashes[file_path] = hash_value
        
        return hashes
    
    def detect_conflicts(
        self,
        plan: EditPlan,
        original_hashes: Optional[Dict[str, str]] = None,
    ) -> ConflictReport:
        """
        Detect conflicts in an edit plan.
        
        Args:
            plan: The edit plan to check
            original_hashes: File hashes from when context was loaded
            
        Returns:
            ConflictReport
        """
        report = ConflictReport()
        original_hashes = original_hashes or self._file_hashes
        
        # Check each file
        files_checked: Set[str] = set()
        
        for edit in plan.edits:
            file_path = edit.location.file_path
            
            if file_path not in files_checked:
                # Check for external modifications
                self._check_file_changes(file_path, original_hashes, report)
                files_checked.add(file_path)
        
        # Check for overlapping edits within the plan
        self._check_internal_overlaps(plan, report)
        
        # Update statistics
        report.total_conflicts = len(report.conflicts)
        report.files_with_conflicts = len(set(c.file_path for c in report.conflicts))
        report.has_conflicts = report.total_conflicts > 0
        
        return report
    
    def _check_file_changes(
        self,
        file_path: str,
        original_hashes: Dict[str, str],
        report: ConflictReport,
    ) -> None:
        """Check if a file has changed since snapshot."""
        full_path = self.workspace_root / file_path
        
        # Get original hash
        original = original_hashes.get(file_path)
        
        # Get current hash
        current = self._compute_hash(file_path)
        
        if original and not current:
            # File was deleted
            report.conflicts.append(Conflict(
                conflict_type=ConflictType.FILE_DELETED,
                file_path=file_path,
                description="File was deleted since context was loaded",
                suggested_resolution="Recreate the file or update the edit plan",
            ))
        elif original and current and original != current:
            # File was modified
            report.conflicts.append(Conflict(
                conflict_type=ConflictType.FILE_MODIFIED,
                file_path=file_path,
                description="File was modified since context was loaded",
                can_merge=True,
                suggested_resolution="Reload context and re-plan edits",
            ))
    
    def _check_internal_overlaps(
        self,
        plan: EditPlan,
        report: ConflictReport,
    ) -> None:
        """Check for overlapping edits within the plan."""
        # Group edits by file
        by_file: Dict[str, List[PlannedEdit]] = {}
        
        for edit in plan.edits:
            file_path = edit.location.file_path
            if file_path not in by_file:
                by_file[file_path] = []
            by_file[file_path].append(edit)
        
        # Check each file
        for file_path, edits in by_file.items():
            if len(edits) < 2:
                continue
            
            # Check all pairs for overlap
            for i, edit1 in enumerate(edits):
                for edit2 in edits[i + 1:]:
                    overlap = self._find_overlap(
                        edit1.location.start_line, edit1.location.end_line,
                        edit2.location.start_line, edit2.location.end_line,
                    )
                    
                    if overlap:
                        report.conflicts.append(Conflict(
                            conflict_type=ConflictType.OVERLAPPING_LINES,
                            file_path=file_path,
                            description=f"Edits {edit1.id} and {edit2.id} overlap at lines {overlap[0]}-{overlap[1]}",
                            edit_ids=[edit1.id, edit2.id],
                            lines=overlap,
                            can_merge=False,
                            suggested_resolution="Combine overlapping edits into a single edit",
                        ))
    
    def _find_overlap(
        self,
        start1: int, end1: int,
        start2: int, end2: int,
    ) -> Optional[Tuple[int, int]]:
        """Find overlapping line range between two edits."""
        overlap_start = max(start1, start2)
        overlap_end = min(end1, end2)
        
        if overlap_start <= overlap_end:
            return (overlap_start, overlap_end)
        
        return None
    
    def _compute_hash(self, file_path: str) -> Optional[str]:
        """Compute hash of file content."""
        full_path = self.workspace_root / file_path
        
        if not full_path.exists():
            return None
        
        try:
            with open(full_path, "rb") as f:
                return hashlib.md5(f.read()).hexdigest()
        except Exception:
            return None
    
    def check_plan_compatibility(
        self,
        plan1: EditPlan,
        plan2: EditPlan,
    ) -> ConflictReport:
        """
        Check if two plans can be executed together.
        
        Useful for checking concurrent edit requests.
        """
        report = ConflictReport()
        
        # Find files affected by both plans
        files1 = set(plan1.get_affected_files())
        files2 = set(plan2.get_affected_files())
        common_files = files1 & files2
        
        if not common_files:
            return report  # No conflicts possible
        
        # Check for overlapping edits in common files
        for file_path in common_files:
            edits1 = [e for e in plan1.edits if e.location.file_path == file_path]
            edits2 = [e for e in plan2.edits if e.location.file_path == file_path]
            
            for e1 in edits1:
                for e2 in edits2:
                    overlap = self._find_overlap(
                        e1.location.start_line, e1.location.end_line,
                        e2.location.start_line, e2.location.end_line,
                    )
                    
                    if overlap:
                        report.conflicts.append(Conflict(
                            conflict_type=ConflictType.OVERLAPPING_LINES,
                            file_path=file_path,
                            description=f"Plan {plan1.id} and {plan2.id} have conflicting edits",
                            edit_ids=[e1.id, e2.id],
                            lines=overlap,
                        ))
        
        report.total_conflicts = len(report.conflicts)
        report.files_with_conflicts = len(common_files)
        report.has_conflicts = report.total_conflicts > 0
        
        return report

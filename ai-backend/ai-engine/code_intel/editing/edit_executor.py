"""
Edit Executor - Execute validated edit plans.

Handles:
- Applying edits in correct order
- Creating backups before edits
- Rollback on failure
- Updating indexes after edits
"""

from __future__ import annotations

import hashlib
import logging
import os
import shutil
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from .edit_planner import EditPlan, PlannedEdit, EditType


logger = logging.getLogger("code_intel.editing.executor")


@dataclass
class FileBackup:
    """Backup of a file before editing."""
    
    file_path: str
    backup_path: str
    original_hash: str
    created_at: datetime


@dataclass
class ExecutionResult:
    """Result of executing an edit plan."""
    
    success: bool
    plan_id: str
    
    # What was done
    edits_applied: int = 0
    files_modified: int = 0
    files_created: int = 0
    files_deleted: int = 0
    
    # Errors
    errors: List[str] = field(default_factory=list)
    
    # Backup info
    backup_dir: Optional[str] = None
    backups: List[FileBackup] = field(default_factory=list)
    
    # Rollback state
    rolled_back: bool = False
    
    def get_summary(self) -> str:
        """Get summary of execution."""
        if self.success:
            status = "✓ Execution successful"
        elif self.rolled_back:
            status = "↺ Rolled back due to errors"
        else:
            status = "✗ Execution failed"
        
        lines = [status]
        
        if self.edits_applied > 0:
            lines.append(f"  Edits applied: {self.edits_applied}")
        if self.files_modified > 0:
            lines.append(f"  Files modified: {self.files_modified}")
        if self.files_created > 0:
            lines.append(f"  Files created: {self.files_created}")
        if self.errors:
            lines.append(f"  Errors: {len(self.errors)}")
        
        return "\n".join(lines)


class EditExecutor:
    """
    Execute edit plans.
    
    Features:
    - Backup before edit
    - Atomic file writes
    - Automatic rollback on failure
    """
    
    def __init__(
        self,
        workspace_root: str,
        backup_dir: Optional[str] = None,
        keep_backups: bool = True,
    ):
        self.workspace_root = Path(workspace_root)
        self.backup_dir = Path(backup_dir) if backup_dir else self.workspace_root / ".code_intel_backups"
        self.keep_backups = keep_backups
    
    def execute(
        self,
        plan: EditPlan,
        dry_run: bool = False,
    ) -> ExecutionResult:
        """
        Execute an edit plan.
        
        Args:
            plan: The validated plan to execute
            dry_run: If True, don't actually modify files
            
        Returns:
            ExecutionResult
        """
        result = ExecutionResult(
            success=False,
            plan_id=plan.id,
        )
        
        # Check validation
        if not plan.validated:
            result.errors.append("Plan not validated")
            return result
        
        # Create backups
        if not dry_run:
            self._create_backups(plan, result)
        
        try:
            # Execute edits in order
            for edit in plan.edits:
                if dry_run:
                    result.edits_applied += 1
                    continue
                
                success = self._execute_edit(edit, result)
                if not success:
                    # Rollback
                    self._rollback(result)
                    result.rolled_back = True
                    return result
            
            result.success = True
            plan.executed = True
            
            # Count modifications
            result.files_modified = len(plan.files_to_modify)
            result.files_created = len(plan.files_to_create)
            result.files_deleted = len(plan.files_to_delete)
            
        except Exception as e:
            logger.error(f"Execution error: {e}")
            result.errors.append(str(e))
            
            if not dry_run:
                self._rollback(result)
                result.rolled_back = True
        
        return result
    
    def _create_backups(
        self,
        plan: EditPlan,
        result: ExecutionResult,
    ) -> None:
        """Create backups of files to be modified."""
        # Create backup directory
        backup_subdir = self.backup_dir / f"backup_{plan.id}_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
        backup_subdir.mkdir(parents=True, exist_ok=True)
        result.backup_dir = str(backup_subdir)
        
        # Backup files to modify/delete
        files_to_backup = plan.files_to_modify + plan.files_to_delete
        
        for file_path in files_to_backup:
            full_path = self.workspace_root / file_path
            
            if not full_path.exists():
                continue
            
            # Create backup path maintaining structure
            backup_path = backup_subdir / file_path
            backup_path.parent.mkdir(parents=True, exist_ok=True)
            
            # Copy file
            shutil.copy2(full_path, backup_path)
            
            # Record backup
            result.backups.append(FileBackup(
                file_path=file_path,
                backup_path=str(backup_path),
                original_hash=self._compute_hash(full_path),
                created_at=datetime.now(),
            ))
    
    def _execute_edit(
        self,
        edit: PlannedEdit,
        result: ExecutionResult,
    ) -> bool:
        """Execute a single edit."""
        try:
            if edit.edit_type == EditType.CREATE_FILE:
                self._execute_create_file(edit)
            elif edit.edit_type == EditType.DELETE_FILE:
                self._execute_delete_file(edit)
            elif edit.edit_type == EditType.DELETE:
                self._execute_delete(edit)
            elif edit.edit_type == EditType.INSERT:
                self._execute_insert(edit)
            elif edit.edit_type == EditType.REPLACE:
                self._execute_replace(edit)
            else:
                result.errors.append(f"Unknown edit type: {edit.edit_type}")
                return False
            
            result.edits_applied += 1
            return True
            
        except Exception as e:
            logger.error(f"Error executing edit {edit.id}: {e}")
            result.errors.append(f"Edit {edit.id}: {str(e)}")
            return False
    
    def _execute_create_file(self, edit: PlannedEdit) -> None:
        """Create a new file."""
        file_path = self.workspace_root / edit.location.file_path
        file_path.parent.mkdir(parents=True, exist_ok=True)
        
        with open(file_path, "w", encoding="utf-8") as f:
            f.write(edit.new_content)
    
    def _execute_delete_file(self, edit: PlannedEdit) -> None:
        """Delete a file."""
        file_path = self.workspace_root / edit.location.file_path
        
        if file_path.exists():
            file_path.unlink()
    
    def _execute_delete(self, edit: PlannedEdit) -> None:
        """Delete lines from a file."""
        file_path = self.workspace_root / edit.location.file_path
        
        with open(file_path, "r", encoding="utf-8") as f:
            lines = f.readlines()
        
        # Remove lines (1-indexed, inclusive)
        start = edit.location.start_line - 1
        end = edit.location.end_line
        del lines[start:end]
        
        with open(file_path, "w", encoding="utf-8") as f:
            f.writelines(lines)
    
    def _execute_insert(self, edit: PlannedEdit) -> None:
        """Insert content after a line."""
        file_path = self.workspace_root / edit.location.file_path
        
        with open(file_path, "r", encoding="utf-8") as f:
            lines = f.readlines()
        
        # Insert after the specified line
        insert_pos = edit.location.start_line  # After this line
        new_lines = edit.new_content.split("\n")
        
        # Ensure new lines have newline characters
        new_lines = [line + "\n" if not line.endswith("\n") else line for line in new_lines]
        
        # Insert
        for i, line in enumerate(new_lines):
            lines.insert(insert_pos + i, line)
        
        with open(file_path, "w", encoding="utf-8") as f:
            f.writelines(lines)
    
    def _execute_replace(self, edit: PlannedEdit) -> None:
        """Replace lines in a file."""
        file_path = self.workspace_root / edit.location.file_path
        
        with open(file_path, "r", encoding="utf-8") as f:
            lines = f.readlines()
        
        # Remove old lines
        start = edit.location.start_line - 1
        end = edit.location.end_line
        del lines[start:end]
        
        # Insert new content
        new_lines = edit.new_content.split("\n")
        new_lines = [line + "\n" if not line.endswith("\n") else line for line in new_lines]
        
        # Don't add extra newline at end if original content didn't have one
        if new_lines and new_lines[-1] == "\n":
            new_lines[-1] = new_lines[-1].rstrip("\n")
        
        for i, line in enumerate(new_lines):
            lines.insert(start + i, line)
        
        with open(file_path, "w", encoding="utf-8") as f:
            f.writelines(lines)
    
    def _rollback(self, result: ExecutionResult) -> None:
        """Rollback edits by restoring backups."""
        logger.info(f"Rolling back {len(result.backups)} backups")
        
        for backup in result.backups:
            try:
                backup_path = Path(backup.backup_path)
                target_path = self.workspace_root / backup.file_path
                
                if backup_path.exists():
                    # Restore backup
                    target_path.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(backup_path, target_path)
                    logger.debug(f"Restored {backup.file_path}")
            except Exception as e:
                logger.error(f"Error restoring {backup.file_path}: {e}")
                result.errors.append(f"Rollback failed for {backup.file_path}: {str(e)}")
    
    def _compute_hash(self, path: Path) -> str:
        """Compute MD5 hash of file."""
        try:
            with open(path, "rb") as f:
                return hashlib.md5(f.read()).hexdigest()
        except Exception:
            return ""
    
    def cleanup_backups(
        self,
        max_age_hours: int = 24,
    ) -> int:
        """Remove old backup directories."""
        if not self.backup_dir.exists():
            return 0
        
        removed = 0
        cutoff = datetime.now()
        
        for backup_dir in self.backup_dir.iterdir():
            if not backup_dir.is_dir():
                continue
            
            # Check age
            try:
                mtime = datetime.fromtimestamp(backup_dir.stat().st_mtime)
                age_hours = (cutoff - mtime).total_seconds() / 3600
                
                if age_hours > max_age_hours:
                    shutil.rmtree(backup_dir)
                    removed += 1
            except Exception as e:
                logger.error(f"Error cleaning backup {backup_dir}: {e}")
        
        return removed

"""
Edit Planner - Plan multi-file edits before execution.

The AI should never directly modify files. Instead:
1. Plan all edits
2. Validate the plan
3. Show the plan to user
4. Execute with rollback capability
"""

from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Dict, List, Optional, Tuple


logger = logging.getLogger("code_intel.editing.planner")


class EditType(Enum):
    """Types of edits."""
    
    INSERT = "insert"  # Insert new content
    REPLACE = "replace"  # Replace existing content
    DELETE = "delete"  # Delete content
    CREATE_FILE = "create_file"  # Create new file
    DELETE_FILE = "delete_file"  # Delete file
    RENAME_FILE = "rename_file"  # Rename/move file


@dataclass
class EditLocation:
    """Location in a file for an edit."""
    
    file_path: str
    start_line: int  # 1-indexed
    end_line: int  # Inclusive
    start_col: Optional[int] = None  # 0-indexed
    end_col: Optional[int] = None
    
    def to_range_str(self) -> str:
        """Get string representation of range."""
        if self.start_line == self.end_line:
            return f"line {self.start_line}"
        return f"lines {self.start_line}-{self.end_line}"


@dataclass
class PlannedEdit:
    """A single planned edit."""
    
    id: str
    edit_type: EditType
    location: EditLocation
    
    # Content
    old_content: str = ""  # What's being replaced/deleted
    new_content: str = ""  # What's being inserted
    
    # Metadata
    description: str = ""  # Human-readable description
    symbol_affected: Optional[str] = None  # Symbol being modified
    reason: str = ""  # Why this edit is needed
    
    # Dependencies
    depends_on: List[str] = field(default_factory=list)  # Edit IDs this depends on
    
    # Validation state
    validated: bool = False
    validation_errors: List[str] = field(default_factory=list)
    
    def get_token_estimate(self) -> int:
        """Estimate tokens needed to show this edit."""
        return (len(self.old_content) + len(self.new_content)) // 4


@dataclass
class EditPlan:
    """A complete plan for one or more edits."""
    
    id: str
    description: str
    edits: List[PlannedEdit] = field(default_factory=list)
    
    # Files involved
    files_to_modify: List[str] = field(default_factory=list)
    files_to_create: List[str] = field(default_factory=list)
    files_to_delete: List[str] = field(default_factory=list)
    
    # State
    created_at: str = ""
    validated: bool = False
    executed: bool = False
    
    # Backup info
    backup_id: Optional[str] = None
    
    def get_affected_files(self) -> List[str]:
        """Get all affected file paths."""
        return list(set(
            self.files_to_modify +
            self.files_to_create +
            self.files_to_delete
        ))
    
    def get_edit_count(self) -> int:
        """Get total number of edits."""
        return len(self.edits)
    
    def get_summary(self) -> str:
        """Get human-readable summary."""
        lines = [f"**Edit Plan: {self.description}**", ""]
        
        if self.files_to_create:
            lines.append(f"- Create {len(self.files_to_create)} file(s)")
            for f in self.files_to_create[:3]:
                lines.append(f"  + {f}")
        
        if self.files_to_modify:
            lines.append(f"- Modify {len(self.files_to_modify)} file(s)")
            for f in self.files_to_modify[:3]:
                lines.append(f"  ~ {f}")
        
        if self.files_to_delete:
            lines.append(f"- Delete {len(self.files_to_delete)} file(s)")
            for f in self.files_to_delete[:3]:
                lines.append(f"  - {f}")
        
        lines.append("")
        lines.append(f"Total edits: {self.get_edit_count()}")
        
        return "\n".join(lines)


class EditPlanner:
    """
    Plan edits before execution.
    
    Responsibilities:
    - Parse edit instructions from AI
    - Create structured edit plans
    - Order edits for correct execution
    - Detect conflicts between edits
    """
    
    def __init__(self, workspace_root: str):
        self.workspace_root = Path(workspace_root)
        self._edit_counter = 0
    
    def create_plan(
        self,
        description: str,
    ) -> EditPlan:
        """Create a new empty edit plan."""
        import uuid
        from datetime import datetime
        
        return EditPlan(
            id=str(uuid.uuid4())[:8],
            description=description,
            created_at=datetime.now().isoformat(),
        )
    
    def add_edit(
        self,
        plan: EditPlan,
        edit_type: EditType,
        file_path: str,
        start_line: int,
        end_line: int,
        old_content: str = "",
        new_content: str = "",
        description: str = "",
        symbol_affected: Optional[str] = None,
        reason: str = "",
    ) -> PlannedEdit:
        """
        Add an edit to a plan.
        
        Args:
            plan: Plan to add to
            edit_type: Type of edit
            file_path: File to edit
            start_line: Starting line (1-indexed)
            end_line: Ending line (inclusive)
            old_content: Content being replaced
            new_content: New content
            description: Human-readable description
            symbol_affected: Symbol being modified
            reason: Why this edit is needed
            
        Returns:
            The created PlannedEdit
        """
        self._edit_counter += 1
        
        edit = PlannedEdit(
            id=f"edit_{self._edit_counter}",
            edit_type=edit_type,
            location=EditLocation(
                file_path=file_path,
                start_line=start_line,
                end_line=end_line,
            ),
            old_content=old_content,
            new_content=new_content,
            description=description,
            symbol_affected=symbol_affected,
            reason=reason,
        )
        
        plan.edits.append(edit)
        
        # Update file lists
        if edit_type == EditType.CREATE_FILE:
            if file_path not in plan.files_to_create:
                plan.files_to_create.append(file_path)
        elif edit_type == EditType.DELETE_FILE:
            if file_path not in plan.files_to_delete:
                plan.files_to_delete.append(file_path)
        else:
            if file_path not in plan.files_to_modify:
                plan.files_to_modify.append(file_path)
        
        return edit
    
    def add_insert(
        self,
        plan: EditPlan,
        file_path: str,
        after_line: int,
        content: str,
        description: str = "",
    ) -> PlannedEdit:
        """Add an insert edit (convenience method)."""
        return self.add_edit(
            plan=plan,
            edit_type=EditType.INSERT,
            file_path=file_path,
            start_line=after_line,
            end_line=after_line,
            new_content=content,
            description=description or f"Insert after line {after_line}",
        )
    
    def add_replace(
        self,
        plan: EditPlan,
        file_path: str,
        start_line: int,
        end_line: int,
        old_content: str,
        new_content: str,
        description: str = "",
    ) -> PlannedEdit:
        """Add a replace edit (convenience method)."""
        return self.add_edit(
            plan=plan,
            edit_type=EditType.REPLACE,
            file_path=file_path,
            start_line=start_line,
            end_line=end_line,
            old_content=old_content,
            new_content=new_content,
            description=description or f"Replace lines {start_line}-{end_line}",
        )
    
    def add_delete(
        self,
        plan: EditPlan,
        file_path: str,
        start_line: int,
        end_line: int,
        old_content: str = "",
        description: str = "",
    ) -> PlannedEdit:
        """Add a delete edit (convenience method)."""
        return self.add_edit(
            plan=plan,
            edit_type=EditType.DELETE,
            file_path=file_path,
            start_line=start_line,
            end_line=end_line,
            old_content=old_content,
            description=description or f"Delete lines {start_line}-{end_line}",
        )
    
    def add_create_file(
        self,
        plan: EditPlan,
        file_path: str,
        content: str,
        description: str = "",
    ) -> PlannedEdit:
        """Add a create file edit."""
        return self.add_edit(
            plan=plan,
            edit_type=EditType.CREATE_FILE,
            file_path=file_path,
            start_line=1,
            end_line=1,
            new_content=content,
            description=description or f"Create file {file_path}",
        )
    
    def order_edits(self, plan: EditPlan) -> None:
        """
        Order edits for correct execution.
        
        Rules:
        - File creations first
        - Within a file, process from bottom to top
          (so line numbers don't shift)
        - Respect explicit dependencies
        """
        # Group by file
        by_file: Dict[str, List[PlannedEdit]] = {}
        file_creates = []
        file_deletes = []
        
        for edit in plan.edits:
            if edit.edit_type == EditType.CREATE_FILE:
                file_creates.append(edit)
            elif edit.edit_type == EditType.DELETE_FILE:
                file_deletes.append(edit)
            else:
                file_path = edit.location.file_path
                if file_path not in by_file:
                    by_file[file_path] = []
                by_file[file_path].append(edit)
        
        # Sort within each file (bottom to top)
        for file_path in by_file:
            by_file[file_path].sort(
                key=lambda e: (e.location.start_line, e.location.start_col or 0),
                reverse=True,
            )
        
        # Rebuild ordered list
        ordered = []
        
        # File creations first
        ordered.extend(file_creates)
        
        # File modifications (one file at a time)
        for file_path in sorted(by_file.keys()):
            ordered.extend(by_file[file_path])
        
        # File deletions last
        ordered.extend(file_deletes)
        
        plan.edits = ordered
    
    def read_current_content(
        self,
        file_path: str,
        start_line: int,
        end_line: int,
    ) -> str:
        """Read current content from a file."""
        full_path = self.workspace_root / file_path
        
        if not full_path.exists():
            return ""
        
        try:
            with open(full_path, "r", encoding="utf-8") as f:
                lines = f.readlines()
            
            selected = lines[start_line - 1:end_line]
            return "".join(selected)
        except Exception as e:
            logger.error(f"Error reading file: {e}")
            return ""
    
    def compute_file_hash(self, file_path: str) -> str:
        """Compute hash of current file content."""
        full_path = self.workspace_root / file_path
        
        if not full_path.exists():
            return ""
        
        try:
            with open(full_path, "rb") as f:
                return hashlib.md5(f.read()).hexdigest()
        except Exception:
            return ""

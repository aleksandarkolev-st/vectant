"""
Editing Workflow Module - Safe code modifications.

Supports multi-file edits with:
- Pre-edit context verification
- Edit planning and validation
- Conflict detection
- Rollback capability
- Index updates after edits
"""

from .edit_planner import (
    EditPlanner,
    EditPlan,
    PlannedEdit,
    EditLocation,
    EditType,
)
from .edit_validator import (
    EditValidator,
    ValidationResult,
    ValidationIssue,
)
from .edit_executor import (
    EditExecutor,
    ExecutionResult,
    FileBackup,
)
from .conflict_detector import (
    ConflictDetector,
    ConflictReport,
    Conflict,
    ConflictType,
)
from .edit_session import (
    EditSession,
    EditSessionManager,
    SessionResult,
    SessionState,
)


__all__ = [
    # Planner
    "EditPlanner",
    "EditPlan",
    "PlannedEdit",
    "EditLocation",
    "EditType",
    # Validator
    "EditValidator",
    "ValidationResult",
    "ValidationIssue",
    # Executor
    "EditExecutor",
    "ExecutionResult",
    "FileBackup",
    # Conflict Detector
    "ConflictDetector",
    "ConflictReport",
    "Conflict",
    "ConflictType",
    # Session
    "EditSession",
    "EditSessionManager",
    "SessionResult",
    "SessionState",
]

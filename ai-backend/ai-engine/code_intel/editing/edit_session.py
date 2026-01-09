"""
Edit Session - Orchestrate complete edit workflow.

Brings together all editing components into a cohesive workflow:
1. Plan edits
2. Detect conflicts
3. Validate changes
4. Execute with backup
5. Verify results
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Dict, List, Optional, Callable

from .edit_planner import EditPlan, EditPlanner, PlannedEdit
from .edit_validator import EditValidator, ValidationResult
from .edit_executor import EditExecutor, ExecutionResult
from .conflict_detector import ConflictDetector, ConflictReport


logger = logging.getLogger("code_intel.editing.session")


class SessionState(Enum):
    """State of an edit session."""
    
    CREATED = "created"
    PLANNING = "planning"
    VALIDATING = "validating"
    EXECUTING = "executing"
    COMPLETED = "completed"
    FAILED = "failed"
    ROLLED_BACK = "rolled_back"


@dataclass
class SessionEvent:
    """Event in session history."""
    
    timestamp: float
    event_type: str
    details: Dict[str, Any] = field(default_factory=dict)


@dataclass
class SessionResult:
    """Result of edit session."""
    
    success: bool
    state: SessionState
    plan: Optional[EditPlan] = None
    validation: Optional[ValidationResult] = None
    conflicts: Optional[ConflictReport] = None
    execution: Optional[ExecutionResult] = None
    
    # Statistics
    files_modified: int = 0
    edits_applied: int = 0
    duration_ms: float = 0.0
    
    # Errors
    error: Optional[str] = None
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        return {
            "success": self.success,
            "state": self.state.value,
            "files_modified": self.files_modified,
            "edits_applied": self.edits_applied,
            "duration_ms": self.duration_ms,
            "error": self.error,
        }


class EditSession:
    """
    Orchestrate a complete edit workflow.
    
    Manages the lifecycle of an edit operation:
    - Planning
    - Conflict detection
    - Validation
    - Execution
    - Rollback
    """
    
    def __init__(
        self,
        workspace_root: str,
        session_id: Optional[str] = None,
    ):
        self.workspace_root = Path(workspace_root)
        self.session_id = session_id or f"session_{int(time.time() * 1000)}"
        
        # Components
        self.planner = EditPlanner()
        self.validator = EditValidator(workspace_root)
        self.executor = EditExecutor(workspace_root)
        self.conflict_detector = ConflictDetector(workspace_root)
        
        # State
        self.state = SessionState.CREATED
        self.plan: Optional[EditPlan] = None
        self._start_time: Optional[float] = None
        
        # History
        self.events: List[SessionEvent] = []
        
        # Callbacks
        self._on_state_change: Optional[Callable[[SessionState], None]] = None
        self._on_progress: Optional[Callable[[str, float], None]] = None
        
        # File state snapshot
        self._file_hashes: Dict[str, str] = {}
    
    def on_state_change(self, callback: Callable[[SessionState], None]) -> None:
        """Register callback for state changes."""
        self._on_state_change = callback
    
    def on_progress(self, callback: Callable[[str, float], None]) -> None:
        """Register callback for progress updates."""
        self._on_progress = callback
    
    def _set_state(self, state: SessionState) -> None:
        """Update session state."""
        old_state = self.state
        self.state = state
        
        self._add_event("state_change", {
            "from": old_state.value,
            "to": state.value,
        })
        
        if self._on_state_change:
            try:
                self._on_state_change(state)
            except Exception:
                pass
    
    def _add_event(self, event_type: str, details: Dict[str, Any] = None) -> None:
        """Add event to history."""
        self.events.append(SessionEvent(
            timestamp=time.time(),
            event_type=event_type,
            details=details or {},
        ))
    
    def _progress(self, message: str, progress: float) -> None:
        """Report progress."""
        if self._on_progress:
            try:
                self._on_progress(message, progress)
            except Exception:
                pass
    
    def create_plan(self, plan_id: Optional[str] = None) -> EditPlan:
        """
        Create a new edit plan for this session.
        
        Returns:
            EditPlan to add edits to
        """
        if self.plan is not None:
            raise ValueError("Session already has a plan")
        
        self._set_state(SessionState.PLANNING)
        self.plan = EditPlan(id=plan_id or f"plan_{self.session_id}")
        self._start_time = time.time()
        
        return self.plan
    
    def snapshot_context(self, file_paths: List[str]) -> None:
        """
        Snapshot files before editing.
        
        Call this when loading context to detect later changes.
        """
        self._file_hashes = self.conflict_detector.snapshot_files(file_paths)
        self._add_event("snapshot", {
            "files": len(file_paths),
        })
    
    def execute(
        self,
        dry_run: bool = False,
        skip_validation: bool = False,
    ) -> SessionResult:
        """
        Execute the edit plan.
        
        Args:
            dry_run: If True, validate but don't execute
            skip_validation: If True, skip validation step
            
        Returns:
            SessionResult
        """
        if self.plan is None:
            return SessionResult(
                success=False,
                state=SessionState.FAILED,
                error="No plan created",
            )
        
        start_time = time.time()
        
        try:
            # Step 1: Order edits
            self._progress("Ordering edits", 0.1)
            self.planner.order_edits(self.plan)
            
            # Step 2: Check for conflicts
            self._progress("Checking conflicts", 0.2)
            conflicts = self.conflict_detector.detect_conflicts(
                self.plan,
                self._file_hashes,
            )
            
            if conflicts.has_conflicts:
                self._set_state(SessionState.FAILED)
                return SessionResult(
                    success=False,
                    state=self.state,
                    plan=self.plan,
                    conflicts=conflicts,
                    error=f"Conflicts detected: {conflicts.get_summary()}",
                )
            
            # Step 3: Validate
            if not skip_validation:
                self._progress("Validating edits", 0.4)
                self._set_state(SessionState.VALIDATING)
                
                validation = self.validator.validate_plan(self.plan)
                
                if not validation.is_valid:
                    self._set_state(SessionState.FAILED)
                    return SessionResult(
                        success=False,
                        state=self.state,
                        plan=self.plan,
                        validation=validation,
                        error=f"Validation failed: {validation.get_summary()}",
                    )
            else:
                validation = None
            
            # Step 4: Execute (unless dry run)
            if dry_run:
                self._set_state(SessionState.COMPLETED)
                return SessionResult(
                    success=True,
                    state=self.state,
                    plan=self.plan,
                    validation=validation,
                    conflicts=conflicts,
                    duration_ms=(time.time() - start_time) * 1000,
                )
            
            self._progress("Executing edits", 0.6)
            self._set_state(SessionState.EXECUTING)
            
            execution = self.executor.execute_plan(self.plan)
            
            if not execution.success:
                self._set_state(SessionState.FAILED)
                return SessionResult(
                    success=False,
                    state=self.state,
                    plan=self.plan,
                    validation=validation,
                    conflicts=conflicts,
                    execution=execution,
                    error=f"Execution failed: {execution.error}",
                )
            
            # Success
            self._progress("Complete", 1.0)
            self._set_state(SessionState.COMPLETED)
            
            return SessionResult(
                success=True,
                state=self.state,
                plan=self.plan,
                validation=validation,
                conflicts=conflicts,
                execution=execution,
                files_modified=len(self.plan.get_affected_files()),
                edits_applied=len(execution.successful_edits),
                duration_ms=(time.time() - start_time) * 1000,
            )
        
        except Exception as e:
            logger.exception("Session failed")
            self._set_state(SessionState.FAILED)
            return SessionResult(
                success=False,
                state=self.state,
                error=str(e),
                duration_ms=(time.time() - start_time) * 1000,
            )
    
    def rollback(self) -> bool:
        """
        Rollback all changes made by this session.
        
        Returns:
            True if rollback successful
        """
        if self.state not in [SessionState.COMPLETED, SessionState.FAILED]:
            logger.warning(f"Cannot rollback in state: {self.state}")
            return False
        
        self._add_event("rollback_started")
        
        success = self.executor.rollback()
        
        if success:
            self._set_state(SessionState.ROLLED_BACK)
            self._add_event("rollback_completed")
        else:
            self._add_event("rollback_failed")
        
        return success
    
    def get_history(self) -> List[Dict[str, Any]]:
        """Get session event history."""
        return [
            {
                "timestamp": e.timestamp,
                "event_type": e.event_type,
                "details": e.details,
            }
            for e in self.events
        ]


class EditSessionManager:
    """
    Manage multiple edit sessions.
    
    Provides session lifecycle management and conflict detection
    across concurrent sessions.
    """
    
    def __init__(self, workspace_root: str):
        self.workspace_root = Path(workspace_root)
        self._sessions: Dict[str, EditSession] = {}
        self._active_session: Optional[str] = None
    
    def create_session(self, session_id: Optional[str] = None) -> EditSession:
        """
        Create a new edit session.
        
        Args:
            session_id: Optional custom session ID
            
        Returns:
            EditSession
        """
        session = EditSession(
            workspace_root=str(self.workspace_root),
            session_id=session_id,
        )
        
        self._sessions[session.session_id] = session
        self._active_session = session.session_id
        
        return session
    
    def get_session(self, session_id: str) -> Optional[EditSession]:
        """Get session by ID."""
        return self._sessions.get(session_id)
    
    def get_active_session(self) -> Optional[EditSession]:
        """Get currently active session."""
        if self._active_session:
            return self._sessions.get(self._active_session)
        return None
    
    def close_session(self, session_id: str) -> None:
        """
        Close and cleanup a session.
        
        Args:
            session_id: Session to close
        """
        session = self._sessions.get(session_id)
        if session:
            # Cleanup backups if completed successfully
            if session.state == SessionState.COMPLETED:
                session.executor.cleanup_backups()
            
            del self._sessions[session_id]
            
            if self._active_session == session_id:
                self._active_session = None
    
    def list_sessions(self) -> List[Dict[str, Any]]:
        """List all sessions with their states."""
        return [
            {
                "id": s.session_id,
                "state": s.state.value,
                "edits": len(s.plan.edits) if s.plan else 0,
            }
            for s in self._sessions.values()
        ]
    
    def check_concurrent_conflicts(self) -> ConflictReport:
        """
        Check for conflicts between active sessions.
        
        Returns:
            ConflictReport
        """
        active_plans = [
            s.plan
            for s in self._sessions.values()
            if s.plan and s.state in [SessionState.PLANNING, SessionState.VALIDATING]
        ]
        
        if len(active_plans) < 2:
            return ConflictReport()  # No conflicts possible
        
        # Check all pairs
        detector = ConflictDetector(str(self.workspace_root))
        combined = ConflictReport()
        
        for i, plan1 in enumerate(active_plans):
            for plan2 in active_plans[i + 1:]:
                report = detector.check_plan_compatibility(plan1, plan2)
                combined.conflicts.extend(report.conflicts)
        
        combined.total_conflicts = len(combined.conflicts)
        combined.has_conflicts = combined.total_conflicts > 0
        
        return combined

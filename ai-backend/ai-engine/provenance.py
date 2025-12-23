"""
AI Change Provenance Tracking
=============================
Attaches provenance metadata to every AI-generated change for debugging.
Logs prompt, model, hash, and verifier result for full traceability.
"""

from __future__ import annotations

import hashlib
import json
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel


class ChangeType(str, Enum):
    """Type of AI-generated change."""
    ANALYSIS = "analysis"
    SUGGESTION = "suggestion"
    REFACTOR = "refactor"
    SPLIT = "split"
    GENERATE = "generate"
    FIX = "fix"


class VerificationStatus(str, Enum):
    """Status from verifier."""
    PENDING = "pending"
    PASSED = "passed"
    WARNED = "warned"
    FAILED = "failed"
    REPAIRED = "repaired"
    SKIPPED = "skipped"


@dataclass
class PromptInfo:
    """Information about the prompt used."""
    system_prompt_hash: str
    user_prompt: str
    user_prompt_hash: str
    context_files: List[str]
    context_size_bytes: int
    focus_file: Optional[str] = None


@dataclass
class ModelInfo:
    """Information about the model used."""
    provider: str
    model_name: str
    temperature: float
    max_tokens: int
    actual_tokens_used: int = 0
    latency_ms: float = 0.0


@dataclass
class VerifierInfo:
    """Information about verification result."""
    status: VerificationStatus
    violations: List[str]
    original_hash: str
    verified_hash: str
    auto_repaired: bool = False
    duration_ms: float = 0.0


@dataclass
class ProvenanceRecord:
    """Complete provenance record for an AI change."""
    # Identification
    record_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    timestamp: float = field(default_factory=time.time)
    
    # Change info
    change_type: ChangeType = ChangeType.SUGGESTION
    target_file: Optional[str] = None
    target_language: str = "unknown"
    
    # Input info
    original_code_hash: str = ""
    prompt_info: Optional[PromptInfo] = None
    
    # Model info
    model_info: Optional[ModelInfo] = None
    
    # Output info
    output_hash: str = ""
    output_size_bytes: int = 0
    
    # Verification info
    verifier_info: Optional[VerifierInfo] = None
    
    # Result
    accepted: bool = False
    applied_at: Optional[float] = None
    rejected_reason: Optional[str] = None
    
    # Debugging
    session_id: Optional[str] = None
    user_id: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for serialization."""
        return {
            "record_id": self.record_id,
            "timestamp": self.timestamp,
            "timestamp_iso": datetime.fromtimestamp(self.timestamp).isoformat(),
            "change_type": self.change_type.value,
            "target_file": self.target_file,
            "target_language": self.target_language,
            "original_code_hash": self.original_code_hash,
            "prompt_info": {
                "system_prompt_hash": self.prompt_info.system_prompt_hash,
                "user_prompt_hash": self.prompt_info.user_prompt_hash,
                "user_prompt_preview": self.prompt_info.user_prompt[:100] if self.prompt_info else None,
                "context_files": self.prompt_info.context_files if self.prompt_info else [],
                "context_size_bytes": self.prompt_info.context_size_bytes if self.prompt_info else 0,
                "focus_file": self.prompt_info.focus_file if self.prompt_info else None,
            } if self.prompt_info else None,
            "model_info": {
                "provider": self.model_info.provider,
                "model_name": self.model_info.model_name,
                "temperature": self.model_info.temperature,
                "max_tokens": self.model_info.max_tokens,
                "actual_tokens_used": self.model_info.actual_tokens_used,
                "latency_ms": self.model_info.latency_ms,
            } if self.model_info else None,
            "output_hash": self.output_hash,
            "output_size_bytes": self.output_size_bytes,
            "verifier_info": {
                "status": self.verifier_info.status.value,
                "violations": self.verifier_info.violations,
                "original_hash": self.verifier_info.original_hash,
                "verified_hash": self.verifier_info.verified_hash,
                "auto_repaired": self.verifier_info.auto_repaired,
                "duration_ms": self.verifier_info.duration_ms,
            } if self.verifier_info else None,
            "accepted": self.accepted,
            "applied_at": self.applied_at,
            "rejected_reason": self.rejected_reason,
            "session_id": self.session_id,
            "user_id": self.user_id,
            "metadata": self.metadata,
        }
    
    def to_json(self) -> str:
        """Convert to JSON string."""
        return json.dumps(self.to_dict(), indent=2)
    
    def summary(self) -> str:
        """Generate human-readable summary."""
        lines = [
            f"AI Change [{self.record_id[:8]}]",
            f"  Type: {self.change_type.value}",
            f"  Target: {self.target_file or 'N/A'}",
            f"  Model: {self.model_info.model_name if self.model_info else 'N/A'}",
            f"  Output hash: {self.output_hash[:16]}",
        ]
        
        if self.verifier_info:
            lines.append(f"  Verified: {self.verifier_info.status.value}")
            if self.verifier_info.violations:
                lines.append(f"  Violations: {len(self.verifier_info.violations)}")
        
        if self.accepted:
            lines.append(f"  Status: ACCEPTED")
        elif self.rejected_reason:
            lines.append(f"  Status: REJECTED ({self.rejected_reason})")
        else:
            lines.append(f"  Status: PENDING")
        
        return "\n".join(lines)


class ProvenanceTracker:
    """Tracks provenance for all AI-generated changes."""
    
    def __init__(self, max_records: int = 10000):
        self._records: Dict[str, ProvenanceRecord] = {}
        self._records_by_file: Dict[str, List[str]] = {}
        self._records_by_session: Dict[str, List[str]] = {}
        self._max_records = max_records
    
    def create_record(
        self,
        change_type: ChangeType,
        original_code: str,
        prompt: str,
        system_prompt: str,
        target_file: Optional[str] = None,
        target_language: str = "unknown",
        context_files: Optional[List[str]] = None,
        focus_file: Optional[str] = None,
        session_id: Optional[str] = None,
        user_id: Optional[str] = None,
    ) -> ProvenanceRecord:
        """Create a new provenance record."""
        record = ProvenanceRecord(
            change_type=change_type,
            target_file=target_file,
            target_language=target_language,
            original_code_hash=self._hash(original_code),
            prompt_info=PromptInfo(
                system_prompt_hash=self._hash(system_prompt),
                user_prompt=prompt,
                user_prompt_hash=self._hash(prompt),
                context_files=context_files or [],
                context_size_bytes=len(original_code.encode()),
                focus_file=focus_file,
            ),
            session_id=session_id,
            user_id=user_id,
        )
        
        self._store_record(record)
        return record
    
    def update_model_info(
        self,
        record_id: str,
        provider: str,
        model_name: str,
        temperature: float,
        max_tokens: int,
        actual_tokens: int = 0,
        latency_ms: float = 0.0,
    ) -> None:
        """Update record with model information."""
        if record_id in self._records:
            self._records[record_id].model_info = ModelInfo(
                provider=provider,
                model_name=model_name,
                temperature=temperature,
                max_tokens=max_tokens,
                actual_tokens_used=actual_tokens,
                latency_ms=latency_ms,
            )
    
    def update_output(
        self,
        record_id: str,
        output: str,
    ) -> None:
        """Update record with output information."""
        if record_id in self._records:
            self._records[record_id].output_hash = self._hash(output)
            self._records[record_id].output_size_bytes = len(output.encode())
    
    def update_verification(
        self,
        record_id: str,
        status: VerificationStatus,
        violations: List[str],
        original_hash: str,
        verified_hash: str,
        auto_repaired: bool = False,
        duration_ms: float = 0.0,
    ) -> None:
        """Update record with verification result."""
        if record_id in self._records:
            self._records[record_id].verifier_info = VerifierInfo(
                status=status,
                violations=violations,
                original_hash=original_hash,
                verified_hash=verified_hash,
                auto_repaired=auto_repaired,
                duration_ms=duration_ms,
            )
    
    def mark_accepted(self, record_id: str) -> None:
        """Mark a change as accepted."""
        if record_id in self._records:
            self._records[record_id].accepted = True
            self._records[record_id].applied_at = time.time()
    
    def mark_rejected(self, record_id: str, reason: str) -> None:
        """Mark a change as rejected."""
        if record_id in self._records:
            self._records[record_id].accepted = False
            self._records[record_id].rejected_reason = reason
    
    def add_metadata(self, record_id: str, key: str, value: Any) -> None:
        """Add custom metadata to a record."""
        if record_id in self._records:
            self._records[record_id].metadata[key] = value
    
    def get_record(self, record_id: str) -> Optional[ProvenanceRecord]:
        """Get a record by ID."""
        return self._records.get(record_id)
    
    def get_records_for_file(self, file_path: str) -> List[ProvenanceRecord]:
        """Get all records for a file."""
        record_ids = self._records_by_file.get(file_path, [])
        return [self._records[rid] for rid in record_ids if rid in self._records]
    
    def get_records_for_session(self, session_id: str) -> List[ProvenanceRecord]:
        """Get all records for a session."""
        record_ids = self._records_by_session.get(session_id, [])
        return [self._records[rid] for rid in record_ids if rid in self._records]
    
    def get_recent_records(self, count: int = 10) -> List[ProvenanceRecord]:
        """Get most recent records."""
        sorted_records = sorted(
            self._records.values(),
            key=lambda r: r.timestamp,
            reverse=True
        )
        return sorted_records[:count]
    
    def get_statistics(self) -> Dict[str, Any]:
        """Get provenance statistics."""
        records = list(self._records.values())
        
        if not records:
            return {"total_records": 0}
        
        by_type = {}
        by_status = {}
        accepted_count = 0
        rejected_count = 0
        
        for r in records:
            by_type[r.change_type.value] = by_type.get(r.change_type.value, 0) + 1
            
            if r.verifier_info:
                status = r.verifier_info.status.value
                by_status[status] = by_status.get(status, 0) + 1
            
            if r.accepted:
                accepted_count += 1
            elif r.rejected_reason:
                rejected_count += 1
        
        return {
            "total_records": len(records),
            "by_change_type": by_type,
            "by_verification_status": by_status,
            "accepted": accepted_count,
            "rejected": rejected_count,
            "pending": len(records) - accepted_count - rejected_count,
            "unique_files": len(self._records_by_file),
            "unique_sessions": len(self._records_by_session),
        }
    
    def export_records(self, record_ids: Optional[List[str]] = None) -> str:
        """Export records as JSON."""
        if record_ids:
            records = [self._records[rid] for rid in record_ids if rid in self._records]
        else:
            records = list(self._records.values())
        
        return json.dumps([r.to_dict() for r in records], indent=2)
    
    def _store_record(self, record: ProvenanceRecord) -> None:
        """Store a record with indexing."""
        # Enforce max records limit
        if len(self._records) >= self._max_records:
            # Remove oldest record
            oldest = min(self._records.values(), key=lambda r: r.timestamp)
            self._remove_record(oldest.record_id)
        
        self._records[record.record_id] = record
        
        if record.target_file:
            if record.target_file not in self._records_by_file:
                self._records_by_file[record.target_file] = []
            self._records_by_file[record.target_file].append(record.record_id)
        
        if record.session_id:
            if record.session_id not in self._records_by_session:
                self._records_by_session[record.session_id] = []
            self._records_by_session[record.session_id].append(record.record_id)
    
    def _remove_record(self, record_id: str) -> None:
        """Remove a record and its indexes."""
        if record_id not in self._records:
            return
        
        record = self._records.pop(record_id)
        
        if record.target_file and record.target_file in self._records_by_file:
            self._records_by_file[record.target_file] = [
                rid for rid in self._records_by_file[record.target_file]
                if rid != record_id
            ]
        
        if record.session_id and record.session_id in self._records_by_session:
            self._records_by_session[record.session_id] = [
                rid for rid in self._records_by_session[record.session_id]
                if rid != record_id
            ]
    
    @staticmethod
    def _hash(content: str) -> str:
        """Generate hash of content."""
        return hashlib.sha256(content.encode()).hexdigest()[:16]


# Global tracker instance
_global_tracker: Optional[ProvenanceTracker] = None


def get_provenance_tracker() -> ProvenanceTracker:
    """Get or create the global provenance tracker."""
    global _global_tracker
    if _global_tracker is None:
        _global_tracker = ProvenanceTracker()
    return _global_tracker


# Helper function for easy provenance tracking in AI calls
def track_ai_call(
    change_type: ChangeType,
    original_code: str,
    prompt: str,
    system_prompt: str = "",
    target_file: Optional[str] = None,
    target_language: str = "unknown",
    session_id: Optional[str] = None,
) -> str:
    """Create a provenance record and return its ID for later updates."""
    tracker = get_provenance_tracker()
    record = tracker.create_record(
        change_type=change_type,
        original_code=original_code,
        prompt=prompt,
        system_prompt=system_prompt,
        target_file=target_file,
        target_language=target_language,
        session_id=session_id,
    )
    return record.record_id

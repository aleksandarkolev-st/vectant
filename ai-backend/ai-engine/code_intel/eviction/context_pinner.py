"""
Context Pinner - Explicitly pin context to prevent eviction.

Use cases:
- User explicitly asks to keep something in context
- AI is currently working with specific code
- Code being actively edited
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Dict, List, Optional, Set

from .context_tracker import ContextTracker


logger = logging.getLogger("code_intel.eviction.pinner")


class PinReason(Enum):
    """Why something was pinned."""
    
    USER_REQUEST = "user_request"  # User explicitly asked
    ACTIVE_EDIT = "active_edit"  # Currently being edited
    AI_WORKING = "ai_working"  # AI is working with it
    DEPENDENCY = "dependency"  # Required by pinned item
    IMPORTANT = "important"  # Marked as important


@dataclass
class Pin:
    """A pinned item."""
    
    chunk_id: str
    reason: PinReason
    created_at: datetime
    expires_at: Optional[datetime] = None
    metadata: Dict = field(default_factory=dict)
    
    def is_expired(self) -> bool:
        """Check if pin has expired."""
        if self.expires_at is None:
            return False
        return datetime.now() > self.expires_at


class ContextPinner:
    """
    Manage explicit context pinning.
    
    Pins prevent chunks from being evicted.
    """
    
    def __init__(
        self,
        tracker: ContextTracker,
        max_pins: int = 50,
    ):
        self.tracker = tracker
        self.max_pins = max_pins
        self.pins: Dict[str, Pin] = {}
    
    def pin(
        self,
        chunk_id: str,
        reason: PinReason = PinReason.USER_REQUEST,
        duration_seconds: Optional[int] = None,
        metadata: Optional[Dict] = None,
    ) -> bool:
        """
        Pin a chunk.
        
        Args:
            chunk_id: Chunk to pin
            reason: Why it's being pinned
            duration_seconds: How long to keep pinned (None = forever)
            metadata: Additional data about the pin
            
        Returns:
            True if pinned successfully
        """
        # Check limit
        if len(self.pins) >= self.max_pins and chunk_id not in self.pins:
            logger.warning(f"Pin limit reached ({self.max_pins})")
            return False
        
        # Create pin
        expires = None
        if duration_seconds:
            from datetime import timedelta
            expires = datetime.now() + timedelta(seconds=duration_seconds)
        
        self.pins[chunk_id] = Pin(
            chunk_id=chunk_id,
            reason=reason,
            created_at=datetime.now(),
            expires_at=expires,
            metadata=metadata or {},
        )
        
        # Update tracker
        self.tracker.pin(chunk_id)
        
        logger.debug(f"Pinned chunk {chunk_id} ({reason.value})")
        return True
    
    def unpin(self, chunk_id: str) -> bool:
        """
        Unpin a chunk.
        
        Args:
            chunk_id: Chunk to unpin
            
        Returns:
            True if unpinned (was pinned)
        """
        if chunk_id not in self.pins:
            return False
        
        del self.pins[chunk_id]
        self.tracker.unpin(chunk_id)
        
        logger.debug(f"Unpinned chunk {chunk_id}")
        return True
    
    def is_pinned(self, chunk_id: str) -> bool:
        """Check if a chunk is pinned."""
        if chunk_id not in self.pins:
            return False
        
        pin = self.pins[chunk_id]
        if pin.is_expired():
            self.unpin(chunk_id)
            return False
        
        return True
    
    def get_pin(self, chunk_id: str) -> Optional[Pin]:
        """Get pin info for a chunk."""
        return self.pins.get(chunk_id)
    
    def get_pinned_chunks(self) -> List[str]:
        """Get all pinned chunk IDs."""
        self.cleanup_expired()
        return list(self.pins.keys())
    
    def get_pins_by_reason(self, reason: PinReason) -> List[Pin]:
        """Get all pins with a specific reason."""
        self.cleanup_expired()
        return [p for p in self.pins.values() if p.reason == reason]
    
    def cleanup_expired(self) -> int:
        """Remove expired pins."""
        expired = [
            chunk_id for chunk_id, pin in self.pins.items()
            if pin.is_expired()
        ]
        
        for chunk_id in expired:
            self.unpin(chunk_id)
        
        return len(expired)
    
    def pin_file(
        self,
        file_path: str,
        reason: PinReason = PinReason.USER_REQUEST,
    ) -> int:
        """
        Pin all chunks from a file.
        
        Returns number of chunks pinned.
        """
        pinned = 0
        
        for chunk_id, chunk in self.tracker.state.current_chunks.items():
            if chunk.file_path == file_path:
                if self.pin(chunk_id, reason):
                    pinned += 1
        
        return pinned
    
    def pin_symbol(
        self,
        symbol_name: str,
        reason: PinReason = PinReason.USER_REQUEST,
    ) -> bool:
        """
        Pin a chunk by symbol name.
        
        Returns True if found and pinned.
        """
        for chunk_id, chunk in self.tracker.state.current_chunks.items():
            if chunk.symbol_name == symbol_name:
                return self.pin(chunk_id, reason)
        
        return False
    
    def unpin_all(self, reason: Optional[PinReason] = None) -> int:
        """
        Unpin all chunks (optionally filtered by reason).
        
        Returns number unpinned.
        """
        if reason is None:
            count = len(self.pins)
            for chunk_id in list(self.pins.keys()):
                self.unpin(chunk_id)
            return count
        
        unpinned = 0
        for chunk_id, pin in list(self.pins.items()):
            if pin.reason == reason:
                self.unpin(chunk_id)
                unpinned += 1
        
        return unpinned
    
    def get_stats(self) -> Dict:
        """Get pinning statistics."""
        self.cleanup_expired()
        
        by_reason = {}
        for pin in self.pins.values():
            reason = pin.reason.value
            by_reason[reason] = by_reason.get(reason, 0) + 1
        
        return {
            "total_pinned": len(self.pins),
            "max_pins": self.max_pins,
            "by_reason": by_reason,
        }

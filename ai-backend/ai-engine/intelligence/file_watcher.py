"""
File Watcher - Server-Side File Change Detection

This module monitors file changes in the container filesystem and triggers
the Intelligence Aggregator when files are modified.

The watcher is notified via:
1. Y.js document changes (real-time as user types)
2. Direct file system changes (git operations, external edits)
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from enum import Enum
from typing import Any, Callable, Dict, List, Optional, Set
from collections import defaultdict
import time
import hashlib


logger = logging.getLogger('intelligence.file_watcher')


class FileChangeType(str, Enum):
    """Type of file change."""
    CREATED = "created"
    MODIFIED = "modified"
    DELETED = "deleted"
    RENAMED = "renamed"


@dataclass
class FileChangeEvent:
    """Event representing a file change."""
    path: str
    change_type: FileChangeType
    content: Optional[str] = None
    content_hash: Optional[str] = None
    language: Optional[str] = None
    old_path: Optional[str] = None  # For renames
    timestamp: float = 0.0
    
    def __post_init__(self):
        if not self.timestamp:
            self.timestamp = time.time()
        if self.content and not self.content_hash:
            self.content_hash = hashlib.sha256(self.content.encode()).hexdigest()[:16]


class FileWatcher:
    """
    Server-side file watcher that triggers analysis on file changes.
    
    This integrates with:
    1. Y.js document observers (real-time typing)
    2. File system watchers (external changes)
    
    Features:
    - Debounced change notifications
    - Language detection
    - Dependency tracking
    """
    
    def __init__(
        self,
        debounce_ms: int = 300,
        batch_window_ms: int = 100,
    ):
        self._debounce_ms = debounce_ms
        self._batch_window_ms = batch_window_ms
        
        # Pending changes per file (for debouncing)
        self._pending: Dict[str, FileChangeEvent] = {}
        self._pending_timers: Dict[str, asyncio.Task] = {}
        
        # Subscribers for change events
        self._subscribers: List[Callable[[FileChangeEvent], None]] = []
        
        # File state tracking
        self._file_hashes: Dict[str, str] = {}
        self._file_languages: Dict[str, str] = {}
        
        # Dependency graph
        self._dependents: Dict[str, Set[str]] = defaultdict(set)  # file -> files that depend on it
        
        logger.info(f"FileWatcher initialized (debounce={debounce_ms}ms)")
    
    def subscribe(self, callback: Callable[[FileChangeEvent], None]) -> Callable[[], None]:
        """
        Subscribe to file change events.
        
        Returns an unsubscribe function.
        """
        self._subscribers.append(callback)
        return lambda: self._subscribers.remove(callback)
    
    def notify_change(
        self,
        path: str,
        content: str,
        change_type: FileChangeType = FileChangeType.MODIFIED,
        language: Optional[str] = None,
    ):
        """
        Notify the watcher of a file change.
        
        This is called by:
        - Y.js document observers when content changes
        - File system watchers for external changes
        """
        content_hash = hashlib.sha256(content.encode()).hexdigest()[:16]
        
        # Check if content actually changed
        if self._file_hashes.get(path) == content_hash:
            return  # No actual change
        
        # Detect language if not provided
        if not language:
            language = self._detect_language(path)
        
        # Create change event
        event = FileChangeEvent(
            path=path,
            change_type=change_type,
            content=content,
            content_hash=content_hash,
            language=language,
        )
        
        # Update tracking
        self._file_hashes[path] = content_hash
        if language:
            self._file_languages[path] = language
        
        # Debounce the notification
        self._schedule_notification(event)
    
    def notify_deletion(self, path: str):
        """Notify the watcher of a file deletion."""
        self._file_hashes.pop(path, None)
        self._file_languages.pop(path, None)
        
        event = FileChangeEvent(
            path=path,
            change_type=FileChangeType.DELETED,
        )
        
        self._emit_event(event)
        
        # Also notify dependents
        for dependent in self._dependents.get(path, []):
            # Trigger re-analysis of dependent files
            # (they may have errors now due to missing dependency)
            pass
    
    def register_dependency(self, file_path: str, depends_on: str):
        """
        Register that file_path depends on depends_on.
        
        When depends_on changes, file_path should be re-analyzed.
        """
        self._dependents[depends_on].add(file_path)
    
    def get_dependents(self, file_path: str) -> Set[str]:
        """Get all files that depend on the given file."""
        return self._dependents.get(file_path, set())
    
    def get_all_tracked_files(self) -> Dict[str, str]:
        """Get all tracked files with their languages."""
        return dict(self._file_languages)
    
    def _schedule_notification(self, event: FileChangeEvent):
        """Schedule a debounced notification."""
        path = event.path
        
        # Cancel existing timer
        if path in self._pending_timers:
            self._pending_timers[path].cancel()
        
        # Store pending event
        self._pending[path] = event
        
        # Schedule new timer
        async def delayed_emit():
            await asyncio.sleep(self._debounce_ms / 1000.0)
            if path in self._pending:
                evt = self._pending.pop(path)
                self._pending_timers.pop(path, None)
                self._emit_event(evt)
                
                # Also notify dependents
                for dependent in self._dependents.get(path, []):
                    # Schedule re-analysis of dependent
                    logger.debug(f"Dependency changed: {dependent} depends on {path}")
        
        self._pending_timers[path] = asyncio.create_task(delayed_emit())
    
    def _emit_event(self, event: FileChangeEvent):
        """Emit event to all subscribers."""
        for subscriber in self._subscribers:
            try:
                subscriber(event)
            except Exception as e:
                logger.error(f"File watcher subscriber error: {e}")
    
    def _detect_language(self, path: str) -> Optional[str]:
        """Detect language from file extension."""
        ext_map = {
            '.py': 'python',
            '.js': 'javascript',
            '.jsx': 'javascript',
            '.ts': 'typescript',
            '.tsx': 'typescript',
            '.cpp': 'cpp',
            '.cc': 'cpp',
            '.cxx': 'cpp',
            '.c': 'c',
            '.h': 'cpp',
            '.hpp': 'cpp',
            '.rs': 'rust',
            '.go': 'go',
            '.java': 'java',
            '.rb': 'ruby',
            '.php': 'php',
            '.cs': 'csharp',
            '.swift': 'swift',
            '.kt': 'kotlin',
            '.scala': 'scala',
            '.html': 'html',
            '.css': 'css',
            '.scss': 'scss',
            '.json': 'json',
            '.yaml': 'yaml',
            '.yml': 'yaml',
            '.xml': 'xml',
            '.md': 'markdown',
            '.sql': 'sql',
            '.sh': 'shell',
            '.bash': 'shell',
        }
        
        import os
        _, ext = os.path.splitext(path.lower())
        return ext_map.get(ext)
    
    def flush(self):
        """Flush all pending notifications immediately."""
        for path, event in list(self._pending.items()):
            if path in self._pending_timers:
                self._pending_timers[path].cancel()
            self._emit_event(event)
        
        self._pending.clear()
        self._pending_timers.clear()


# Singleton instance
_file_watcher: Optional[FileWatcher] = None


def get_file_watcher() -> FileWatcher:
    """Get or create the global FileWatcher instance."""
    global _file_watcher
    
    if _file_watcher is None:
        _file_watcher = FileWatcher()
    
    return _file_watcher

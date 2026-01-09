"""
Summary Store - Persistence layer for file and repo summaries.

Handles:
- Storage of summaries
- Cache invalidation
- Incremental updates
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Set

from ..core.types import FileSummary, RepoSummary


logger = logging.getLogger("code_intel.summaries.store")


class SummaryStore:
    """
    Persistent storage for code summaries.
    
    Features:
    - JSON persistence
    - Hash-based invalidation
    - Lazy loading
    """
    
    def __init__(self, storage_dir: str):
        """
        Initialize store.
        
        Args:
            storage_dir: Directory for summary storage
        """
        self.storage_dir = Path(storage_dir)
        self.storage_dir.mkdir(parents=True, exist_ok=True)
        
        # Paths
        self.file_summaries_path = self.storage_dir / "file_summaries.json"
        self.repo_summary_path = self.storage_dir / "repo_summary.json"
        self.metadata_path = self.storage_dir / "summary_metadata.json"
        
        # In-memory cache
        self._file_summaries: Optional[Dict[str, FileSummary]] = None
        self._repo_summary: Optional[RepoSummary] = None
        self._metadata: Optional[Dict] = None
    
    # -------------------------------------------------------------------------
    # File Summaries
    # -------------------------------------------------------------------------
    
    def get_file_summary(self, file_path: str) -> Optional[FileSummary]:
        """Get summary for a specific file."""
        summaries = self._load_file_summaries()
        return summaries.get(file_path)
    
    def get_all_file_summaries(self) -> Dict[str, FileSummary]:
        """Get all file summaries."""
        return self._load_file_summaries().copy()
    
    def set_file_summary(self, file_path: str, summary: FileSummary) -> None:
        """Store summary for a file."""
        summaries = self._load_file_summaries()
        summaries[file_path] = summary
        self._save_file_summaries(summaries)
    
    def set_file_summaries(self, summaries: Dict[str, FileSummary]) -> None:
        """Store multiple file summaries."""
        existing = self._load_file_summaries()
        existing.update(summaries)
        self._save_file_summaries(existing)
    
    def remove_file_summary(self, file_path: str) -> None:
        """Remove summary for a file."""
        summaries = self._load_file_summaries()
        if file_path in summaries:
            del summaries[file_path]
            self._save_file_summaries(summaries)
    
    def clear_file_summaries(self) -> None:
        """Clear all file summaries."""
        self._file_summaries = {}
        self._save_file_summaries({})
    
    def _load_file_summaries(self) -> Dict[str, FileSummary]:
        """Load file summaries from disk."""
        if self._file_summaries is not None:
            return self._file_summaries
        
        if not self.file_summaries_path.exists():
            self._file_summaries = {}
            return self._file_summaries
        
        try:
            with open(self.file_summaries_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            
            self._file_summaries = {
                path: FileSummary(**summary)
                for path, summary in data.items()
            }
        except Exception as e:
            logger.error(f"Failed to load file summaries: {e}")
            self._file_summaries = {}
        
        return self._file_summaries
    
    def _save_file_summaries(self, summaries: Dict[str, FileSummary]) -> None:
        """Save file summaries to disk."""
        self._file_summaries = summaries
        
        data = {
            path: summary.to_dict()
            for path, summary in summaries.items()
        }
        
        try:
            with open(self.file_summaries_path, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2)
        except Exception as e:
            logger.error(f"Failed to save file summaries: {e}")
    
    # -------------------------------------------------------------------------
    # Repo Summary
    # -------------------------------------------------------------------------
    
    def get_repo_summary(self) -> Optional[RepoSummary]:
        """Get repository summary."""
        if self._repo_summary is not None:
            return self._repo_summary
        
        if not self.repo_summary_path.exists():
            return None
        
        try:
            with open(self.repo_summary_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            self._repo_summary = RepoSummary(**data)
        except Exception as e:
            logger.error(f"Failed to load repo summary: {e}")
            return None
        
        return self._repo_summary
    
    def set_repo_summary(self, summary: RepoSummary) -> None:
        """Store repository summary."""
        self._repo_summary = summary
        
        try:
            with open(self.repo_summary_path, "w", encoding="utf-8") as f:
                json.dump(summary.to_dict(), f, indent=2)
        except Exception as e:
            logger.error(f"Failed to save repo summary: {e}")
    
    def clear_repo_summary(self) -> None:
        """Clear repository summary."""
        self._repo_summary = None
        if self.repo_summary_path.exists():
            self.repo_summary_path.unlink()
    
    # -------------------------------------------------------------------------
    # Metadata & State
    # -------------------------------------------------------------------------
    
    def get_metadata(self) -> Dict:
        """Get store metadata."""
        if self._metadata is not None:
            return self._metadata
        
        if not self.metadata_path.exists():
            self._metadata = {
                "created_at": datetime.now().isoformat(),
                "updated_at": datetime.now().isoformat(),
                "version": "1.0.0",
                "file_hashes": {},
            }
            self._save_metadata()
            return self._metadata
        
        try:
            with open(self.metadata_path, "r", encoding="utf-8") as f:
                self._metadata = json.load(f)
        except Exception as e:
            logger.error(f"Failed to load metadata: {e}")
            self._metadata = {"file_hashes": {}}
        
        return self._metadata
    
    def _save_metadata(self) -> None:
        """Save metadata to disk."""
        if self._metadata is None:
            return
        
        self._metadata["updated_at"] = datetime.now().isoformat()
        
        try:
            with open(self.metadata_path, "w", encoding="utf-8") as f:
                json.dump(self._metadata, f, indent=2)
        except Exception as e:
            logger.error(f"Failed to save metadata: {e}")
    
    # -------------------------------------------------------------------------
    # Cache Invalidation
    # -------------------------------------------------------------------------
    
    def is_file_stale(self, file_path: str, content_hash: str) -> bool:
        """
        Check if file summary needs updating.
        
        Args:
            file_path: Path to the file
            content_hash: Current content hash
            
        Returns:
            True if summary is stale/missing
        """
        metadata = self.get_metadata()
        stored_hash = metadata.get("file_hashes", {}).get(file_path)
        return stored_hash != content_hash
    
    def get_stale_files(
        self,
        current_hashes: Dict[str, str]
    ) -> Set[str]:
        """
        Get list of files needing summary updates.
        
        Args:
            current_hashes: Map of file_path -> content_hash
            
        Returns:
            Set of file paths needing updates
        """
        metadata = self.get_metadata()
        stored_hashes = metadata.get("file_hashes", {})
        
        stale = set()
        
        # Check for new or modified files
        for file_path, current_hash in current_hashes.items():
            if stored_hashes.get(file_path) != current_hash:
                stale.add(file_path)
        
        return stale
    
    def get_removed_files(
        self,
        current_files: Set[str]
    ) -> Set[str]:
        """
        Get files that were removed.
        
        Args:
            current_files: Set of current file paths
            
        Returns:
            Set of removed file paths
        """
        metadata = self.get_metadata()
        stored_files = set(metadata.get("file_hashes", {}).keys())
        return stored_files - current_files
    
    def update_file_hash(self, file_path: str, content_hash: str) -> None:
        """Update stored hash for a file."""
        metadata = self.get_metadata()
        if "file_hashes" not in metadata:
            metadata["file_hashes"] = {}
        metadata["file_hashes"][file_path] = content_hash
        self._save_metadata()
    
    def update_file_hashes(self, hashes: Dict[str, str]) -> None:
        """Update multiple file hashes."""
        metadata = self.get_metadata()
        if "file_hashes" not in metadata:
            metadata["file_hashes"] = {}
        metadata["file_hashes"].update(hashes)
        self._save_metadata()
    
    def remove_file_hash(self, file_path: str) -> None:
        """Remove stored hash for a file."""
        metadata = self.get_metadata()
        if "file_hashes" in metadata and file_path in metadata["file_hashes"]:
            del metadata["file_hashes"][file_path]
            self._save_metadata()
    
    # -------------------------------------------------------------------------
    # Bulk Operations
    # -------------------------------------------------------------------------
    
    def clear_all(self) -> None:
        """Clear all stored data."""
        self.clear_file_summaries()
        self.clear_repo_summary()
        self._metadata = None
        if self.metadata_path.exists():
            self.metadata_path.unlink()
    
    def get_stats(self) -> Dict:
        """Get storage statistics."""
        summaries = self._load_file_summaries()
        repo = self.get_repo_summary()
        metadata = self.get_metadata()
        
        return {
            "file_summary_count": len(summaries),
            "has_repo_summary": repo is not None,
            "tracked_files": len(metadata.get("file_hashes", {})),
            "storage_dir": str(self.storage_dir),
            "created_at": metadata.get("created_at"),
            "updated_at": metadata.get("updated_at"),
        }


class IncrementalSummaryManager:
    """
    Manages incremental summary updates.
    
    Only re-summarizes files that have changed.
    """
    
    def __init__(
        self,
        store: SummaryStore,
        file_summarizer,  # FileSummarizer
        repo_summarizer,  # RepoSummarizer
    ):
        self.store = store
        self.file_summarizer = file_summarizer
        self.repo_summarizer = repo_summarizer
    
    def sync(
        self,
        file_hashes: Dict[str, str],
        file_chunks: Dict[str, List],  # file_path -> List[SemanticChunk]
    ) -> Dict[str, int]:
        """
        Synchronize summaries with current file state.
        
        Args:
            file_hashes: Current content hashes
            file_chunks: Current semantic chunks per file
            
        Returns:
            Stats about sync operation
        """
        stats = {"added": 0, "updated": 0, "removed": 0, "unchanged": 0}
        
        current_files = set(file_hashes.keys())
        
        # Find stale and removed files
        stale_files = self.store.get_stale_files(file_hashes)
        removed_files = self.store.get_removed_files(current_files)
        
        # Remove summaries for deleted files
        for file_path in removed_files:
            self.store.remove_file_summary(file_path)
            self.store.remove_file_hash(file_path)
            stats["removed"] += 1
        
        # Update summaries for changed files
        new_summaries = {}
        new_hashes = {}
        
        for file_path in stale_files:
            if file_path not in file_chunks:
                continue
            
            chunks = file_chunks[file_path]
            if not chunks:
                continue
            
            # Check if this is new or updated
            existing = self.store.get_file_summary(file_path)
            
            # Generate new summary
            summary = self.file_summarizer.summarize(file_path, chunks)
            new_summaries[file_path] = summary
            new_hashes[file_path] = file_hashes[file_path]
            
            if existing:
                stats["updated"] += 1
            else:
                stats["added"] += 1
        
        # Bulk save
        if new_summaries:
            self.store.set_file_summaries(new_summaries)
            self.store.update_file_hashes(new_hashes)
        
        # Count unchanged
        stats["unchanged"] = len(current_files) - stats["added"] - stats["updated"]
        
        # Update repo summary if anything changed
        if stats["added"] + stats["updated"] + stats["removed"] > 0:
            all_summaries = self.store.get_all_file_summaries()
            repo_summary = self.repo_summarizer.summarize()
            self.store.set_repo_summary(repo_summary)
        
        return stats

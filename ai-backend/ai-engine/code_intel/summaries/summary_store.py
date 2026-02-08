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

from ..core.types import FileSummary, RepoSummary, ModuleSummary


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
        self.module_summaries_path = self.storage_dir / "module_summaries.json"
        self.metadata_path = self.storage_dir / "summary_metadata.json"
        
        # In-memory cache
        self._file_summaries: Optional[Dict[str, FileSummary]] = None
        self._repo_summary: Optional[RepoSummary] = None
        self._module_summaries: Optional[Dict[str, ModuleSummary]] = None
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

    # -------------------------------------------------------------------------
    # Module Summaries
    # -------------------------------------------------------------------------

    def get_module_summary(self, module_path: str) -> Optional[ModuleSummary]:
        summaries = self._load_module_summaries()
        return summaries.get(module_path)

    def get_all_module_summaries(self) -> Dict[str, ModuleSummary]:
        return self._load_module_summaries().copy()

    def set_module_summary(self, module_path: str, summary: ModuleSummary) -> None:
        summaries = self._load_module_summaries()
        summaries[module_path] = summary
        self._save_module_summaries(summaries)

    def set_module_summaries(self, summaries: Dict[str, ModuleSummary]) -> None:
        existing = self._load_module_summaries()
        existing.update(summaries)
        self._save_module_summaries(existing)

    def remove_module_summary(self, module_path: str) -> None:
        summaries = self._load_module_summaries()
        if module_path in summaries:
            del summaries[module_path]
            self._save_module_summaries(summaries)

    def clear_module_summaries(self) -> None:
        self._module_summaries = {}
        self._save_module_summaries({})

    def _load_module_summaries(self) -> Dict[str, ModuleSummary]:
        if self._module_summaries is not None:
            return self._module_summaries
        if not self.module_summaries_path.exists():
            self._module_summaries = {}
            return self._module_summaries
        try:
            with open(self.module_summaries_path, "r", encoding="utf-8") as f:
                data = json.load(f)

            def _normalize(summary: Dict) -> Dict:
                return {
                    "module_path": summary.get("module_path") or summary.get("modulePath") or "",
                    "summary": summary.get("summary", ""),
                    "key_symbols": summary.get("key_symbols") or summary.get("keySymbols") or [],
                    "dependencies": summary.get("dependencies") or [],
                    "content_hash": summary.get("content_hash") or summary.get("contentHash") or "",
                    "chunking_version": summary.get("chunking_version", ""),
                }

            self._module_summaries = {
                path: ModuleSummary(**_normalize(summary))
                for path, summary in data.items()
            }
        except Exception as e:
            logger.error(f"Failed to load module summaries: {e}")
            self._module_summaries = {}
        return self._module_summaries

    def _save_module_summaries(self, summaries: Dict[str, ModuleSummary]) -> None:
        self._module_summaries = summaries
        data = {path: summary.to_dict() for path, summary in summaries.items()}
        try:
            with open(self.module_summaries_path, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2)
        except Exception as e:
            logger.error(f"Failed to save module summaries: {e}")
    
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

            def _normalize(summary: Dict) -> Dict:
                return {
                    "file_path": summary.get("file_path") or summary.get("file"),
                    "language": summary.get("language", ""),
                    "responsibility": summary.get("responsibility", ""),
                    "public_api": summary.get("public_api") or summary.get("publicApi") or [],
                    "dependencies": summary.get("dependencies") or [],
                    "side_effects": summary.get("side_effects") or summary.get("sideEffects") or [],
                    "content_hash": summary.get("content_hash") or summary.get("contentHash") or "",
                    "chunking_version": summary.get("chunking_version", ""),
                    "chunk_ids": summary.get("chunk_ids") or summary.get("chunkIds") or [],
                    "evidence": summary.get("evidence") or {},
                }

            self._file_summaries = {
                path: FileSummary(**_normalize(summary))
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
            self._repo_summary = RepoSummary(**self._normalize_repo_summary_data(data))
        except Exception as e:
            logger.error(f"Failed to load repo summary: {e}")
            return None
        
        return self._repo_summary
    
    def set_repo_summary(self, summary: RepoSummary) -> None:
        """Store repository summary."""
        self._repo_summary = summary

        data = {
            "architecture": summary.architecture,
            "entry_points": summary.entry_points,
            "subsystems": summary.subsystems,
            "conventions": summary.conventions,
            "languages": summary.languages,
            "frameworks": summary.frameworks,
            "total_files": summary.total_files,
            "total_symbols": summary.total_symbols,
            "state_hash": summary.state_hash,
            "token_count": summary.token_count,
            # Legacy/compat fields
            "entryPoints": summary.entry_points,
            "stats": {
                "files": summary.total_files,
                "symbols": summary.total_symbols,
            },
        }
        
        try:
            with open(self.repo_summary_path, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2)
        except Exception as e:
            logger.error(f"Failed to save repo summary: {e}")
    
    def clear_repo_summary(self) -> None:
        """Clear repository summary."""
        self._repo_summary = None
        if self.repo_summary_path.exists():
            self.repo_summary_path.unlink()

    def _normalize_repo_summary_data(self, data: Dict) -> Dict:
        """Normalize repo summary data across schema versions."""
        normalized = dict(data)

        if "entry_points" not in normalized and "entryPoints" in normalized:
            normalized["entry_points"] = normalized.pop("entryPoints")

        if "stats" in normalized:
            stats = normalized.pop("stats") or {}
            normalized.setdefault("total_files", stats.get("files", 0))
            normalized.setdefault("total_symbols", stats.get("symbols", 0))

        normalized.setdefault("total_files", 0)
        normalized.setdefault("total_symbols", 0)
        normalized.setdefault("state_hash", "unknown")

        return normalized
    
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

    def get_file_hashes(self) -> Dict[str, str]:
        """Get stored file hashes map."""
        metadata = self.get_metadata()
        return dict(metadata.get("file_hashes", {}))
    
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
        self.clear_module_summaries()
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
            "module_summary_count": len(self._load_module_summaries()),
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
        module_summarizer=None,  # ModuleSummarizer
        file_reader=None,
        facts_store=None,
    ):
        self.store = store
        self.file_summarizer = file_summarizer
        self.repo_summarizer = repo_summarizer
        self.module_summarizer = module_summarizer
        self.file_reader = file_reader
        self.facts_store = facts_store
    
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

        # Detect renames by matching content hashes
        stored_hashes = self.store.get_file_hashes()
        hash_to_current_files: Dict[str, List[str]] = {}
        for path, h in file_hashes.items():
            hash_to_current_files.setdefault(h, []).append(path)

        renamed_map: Dict[str, str] = {}
        for old_path in list(removed_files):
            old_hash = stored_hashes.get(old_path)
            if not old_hash:
                continue
            candidates = hash_to_current_files.get(old_hash, [])
            if candidates:
                new_path = candidates[0]
                renamed_map[old_path] = new_path
                removed_files.discard(old_path)
                # Update summary and hash to new path
                existing_summary = self.store.get_file_summary(old_path)
                if existing_summary:
                    existing_summary.file_path = new_path
                    self.store.set_file_summary(new_path, existing_summary)
                self.store.remove_file_summary(old_path)
                self.store.update_file_hash(new_path, old_hash)
                self.store.remove_file_hash(old_path)
                if self.facts_store:
                    self.facts_store.remove_facts_for_file(old_path)
        
        # Remove summaries for deleted files
        for file_path in removed_files:
            self.store.remove_file_summary(file_path)
            self.store.remove_file_hash(file_path)
            if self.facts_store:
                self.facts_store.remove_facts_for_file(file_path)
            stats["removed"] += 1
        
        # Update summaries for changed files
        new_summaries = {}
        new_hashes = {}
        
        for file_path in stale_files:
            if file_path not in file_chunks:
                self.store.remove_file_summary(file_path)
                self.store.remove_file_hash(file_path)
                if self.facts_store:
                    self.facts_store.remove_facts_for_file(file_path)
                stats["removed"] += 1
                continue
            
            chunks = file_chunks[file_path]
            if not chunks:
                self.store.remove_file_summary(file_path)
                self.store.remove_file_hash(file_path)
                if self.facts_store:
                    self.facts_store.remove_facts_for_file(file_path)
                stats["removed"] += 1
                continue

            file_obj = None
            if self.file_reader is not None:
                try:
                    file_obj = self.file_reader.get_file(file_path)
                except Exception:
                    file_obj = None
            if not file_obj:
                self.store.remove_file_summary(file_path)
                self.store.remove_file_hash(file_path)
                if self.facts_store:
                    self.facts_store.remove_facts_for_file(file_path)
                stats["removed"] += 1
                continue
            
            # Check if this is new or updated
            existing = self.store.get_file_summary(file_path)
            
            # Generate new summary
            summary = self.file_summarizer.summarize_from_chunks(
                file_path=file_path,
                language=file_obj.language or "",
                content=file_obj.content,
                content_hash=file_obj.content_hash,
                chunks=chunks,
            )
            new_summaries[file_path] = summary
            new_hashes[file_path] = file_hashes[file_path]

            if self.facts_store:
                self.facts_store.update_facts_for_file(file_path, chunks)
            
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
        
        # Update module summaries for changed files
        if self.module_summarizer and (stats["added"] + stats["updated"] + stats["removed"] > 0):
            self._update_module_summaries(file_hashes, file_chunks)

        # Update repo summary if anything changed
        if stats["added"] + stats["updated"] + stats["removed"] > 0:
            all_summaries = self.store.get_all_file_summaries()
            repo_summary = self.repo_summarizer.summarize()
            self.store.set_repo_summary(repo_summary)
        
        return stats

    def _update_module_summaries(
        self,
        file_hashes: Dict[str, str],
        file_chunks: Dict[str, List],
    ) -> None:
        if not self.module_summarizer:
            return

        # Group by module path (module_group from chunks)
        module_to_files: Dict[str, List[str]] = {}
        module_to_chunks: Dict[str, List] = {}

        for path, chunks in file_chunks.items():
            if not chunks:
                continue
            module = chunks[0].metadata.module_group or path.rsplit("/", 1)[0]
            module_to_files.setdefault(module, []).append(path)
            module_to_chunks.setdefault(module, []).extend(chunks)

        new_summaries = {}
        for module_path, files in module_to_files.items():
            # Compute module content hash from member files
            hash_input = "|".join(sorted(file_hashes.get(f, "") for f in files))
            content_hash = hashlib.sha256(hash_input.encode()).hexdigest()

            file_summaries = {f: self.store.get_file_summary(f) for f in files}
            file_summaries = {k: v for k, v in file_summaries.items() if v is not None}

            summary = self.module_summarizer.summarize(
                module_path=module_path,
                file_summaries=file_summaries,
                chunks=module_to_chunks[module_path],
                content_hash=content_hash,
            )
            if summary:
                new_summaries[module_path] = summary

        if new_summaries:
            self.store.set_module_summaries(new_summaries)

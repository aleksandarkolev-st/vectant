"""
Facts Store - Lightweight structured memory extracted from code.

Stores small triples (subject, predicate, object) grounded to chunk IDs.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Dict, List, Optional, Set

from ..core.types import SemanticChunk

logger = logging.getLogger("code_intel.summaries.facts")


@dataclass(frozen=True)
class Fact:
    subject: str
    predicate: str
    object: str
    file_path: str
    chunk_id: str
    content_hash: str
    chunking_version: str


class FactsStore:
    """
    Simple persisted facts store.

    Extracts facts from chunks and persists to JSON.
    """

    def __init__(self, storage_dir: str):
        self.storage_dir = Path(storage_dir)
        self.storage_dir.mkdir(parents=True, exist_ok=True)
        self.facts_path = self.storage_dir / "facts.json"
        self._facts: List[Fact] = []
        self._loaded = False
        self._gc_cursor = 0

    def _load(self) -> None:
        if self._loaded:
            return
        if not self.facts_path.exists():
            self._facts = []
            self._loaded = True
            return
        try:
            with open(self.facts_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            def _normalize(rec: Dict) -> Dict:
                return {
                    "subject": rec.get("subject", ""),
                    "predicate": rec.get("predicate", ""),
                    "object": rec.get("object", ""),
                    "file_path": rec.get("file_path") or rec.get("filePath") or "",
                    "chunk_id": rec.get("chunk_id") or rec.get("chunkId") or "",
                    "content_hash": rec.get("content_hash") or rec.get("contentHash") or "",
                    "chunking_version": rec.get("chunking_version") or rec.get("chunkingVersion") or "",
                }
            self._facts = [Fact(**_normalize(rec)) for rec in data]
            self._loaded = True
        except Exception as e:
            logger.error(f"Failed to load facts store: {e}")
            self._facts = []
            self._loaded = True

    def _save(self) -> None:
        try:
            with open(self.facts_path, "w", encoding="utf-8") as f:
                json.dump([asdict(fact) for fact in self._facts], f, indent=2)
        except Exception as e:
            logger.error(f"Failed to save facts store: {e}")

    def get_facts(self) -> List[Fact]:
        self._load()
        return list(self._facts)

    def purge_stale(
        self,
        file_reader,
        chunking_version: str,
        max_scan: int = 200,
        files: Optional[Set[str]] = None,
    ) -> int:
        """Purge stale facts incrementally (capped per call)."""
        self._load()
        if not self._facts:
            return 0

        removed = 0
        scanned = 0
        idx = self._gc_cursor

        while scanned < max_scan and self._facts:
            if idx >= len(self._facts):
                idx = 0
            fact = self._facts[idx]

            if files and fact.file_path not in files:
                idx += 1
                scanned += 1
                continue

            current_hash = file_reader.get_file_hash(fact.file_path)
            stale = False
            if not current_hash:
                stale = True
            elif fact.content_hash and current_hash != fact.content_hash:
                stale = True
            elif fact.chunking_version and fact.chunking_version != chunking_version:
                stale = True

            if stale:
                del self._facts[idx]
                removed += 1
                # Do not advance idx on removal (next item shifts in)
            else:
                idx += 1
            scanned += 1

        self._gc_cursor = idx if self._facts else 0
        if removed:
            self._save()
        return removed

    def remove_facts_for_file(self, file_path: str) -> None:
        self._load()
        before = len(self._facts)
        self._facts = [f for f in self._facts if f.file_path != file_path]
        if len(self._facts) != before:
            self._save()

    def update_facts_for_file(self, file_path: str, chunks: List[SemanticChunk]) -> None:
        self._load()
        self.remove_facts_for_file(file_path)
        new_facts: List[Fact] = []

        for chunk in chunks:
            symbol = chunk.metadata.qualified_name or chunk.metadata.symbol_name
            if symbol:
                new_facts.append(Fact(
                    subject=file_path,
                    predicate="defines",
                    object=symbol,
                    file_path=file_path,
                    chunk_id=chunk.id,
                    content_hash=chunk.content_hash,
                    chunking_version=chunk.metadata.chunking_version,
                ))

            for imp in chunk.metadata.imports_used or []:
                new_facts.append(Fact(
                    subject=file_path,
                    predicate="imports",
                    object=imp,
                    file_path=file_path,
                    chunk_id=chunk.id,
                    content_hash=chunk.content_hash,
                    chunking_version=chunk.metadata.chunking_version,
                ))

            for exp in chunk.metadata.exports_provided or []:
                new_facts.append(Fact(
                    subject=file_path,
                    predicate="exports",
                    object=exp,
                    file_path=file_path,
                    chunk_id=chunk.id,
                    content_hash=chunk.content_hash,
                    chunking_version=chunk.metadata.chunking_version,
                ))

        # Deduplicate
        seen: Set[str] = set()
        for fact in new_facts:
            key = f"{fact.subject}|{fact.predicate}|{fact.object}|{fact.chunk_id}"
            if key in seen:
                continue
            seen.add(key)
            self._facts.append(fact)

        self._save()

"""
Spec Index - Lightweight spec layer from docs/tests.

Builds in-memory spec chunks from docs and test files and enables
query-time spec alignment scoring.
"""

from __future__ import annotations

import fnmatch
import hashlib
import logging
import os
import re
from dataclasses import dataclass
from typing import Dict, Iterable, List, Optional, Tuple

from ..core.config import RetrievalConfig
from ..core.types import ChunkMetadata, SemanticChunk, SymbolType

logger = logging.getLogger("code_intel.retrieval.spec_index")


@dataclass
class SpecChunkRecord:
    chunk: SemanticChunk
    kind: str  # "docs" | "tests"
    score: float = 0.0


class SpecIndex:
    """Build a lightweight spec layer from docs/tests."""

    def __init__(
        self,
        workspace_root: str,
        config: Optional[RetrievalConfig] = None,
        file_reader=None,
    ):
        self.workspace_root = os.path.abspath(workspace_root)
        self.config = config or RetrievalConfig()
        self.file_reader = file_reader
        self._chunks: List[SpecChunkRecord] = []
        self._file_hashes: Dict[str, str] = {}
        self._built = False

    def get_spec_chunks(self, query: str) -> List[SpecChunkRecord]:
        if not self.config.enable_spec_layer:
            return []
        self._ensure_built()
        if not self._chunks:
            return []

        terms = self._tokenize(query)
        if not terms:
            return []

        scored: List[SpecChunkRecord] = []
        for rec in self._chunks:
            text = rec.chunk.code_body or ""
            score = self._score_terms(text, terms)
            if score <= 0:
                continue
            scored.append(SpecChunkRecord(chunk=rec.chunk, kind=rec.kind, score=score))

        scored.sort(key=lambda r: r.score, reverse=True)
        return scored[: self.config.spec_max_chunks]

    def _ensure_built(self) -> None:
        if self._built and not self._needs_rebuild():
            return
        self._built = True
        self._chunks.clear()
        self._file_hashes.clear()

        doc_files = self._collect_files(self.config.spec_doc_globs)
        test_files = self._collect_files(self.config.spec_test_globs)

        for fp in doc_files:
            self._add_file_chunks(fp, kind="docs")
        for fp in test_files:
            self._add_file_chunks(fp, kind="tests")

        logger.info(f"SpecIndex built: {len(self._chunks)} spec chunks")

    def _needs_rebuild(self) -> bool:
        if not self._file_hashes:
            return True
        for fp, prev_hash in self._file_hashes.items():
            current_hash = self._get_file_hash(fp)
            if current_hash and current_hash != prev_hash:
                return True
        return False

    def _collect_files(self, globs: Iterable[str]) -> List[str]:
        matches: List[str] = []
        for root, _, files in os.walk(self.workspace_root):
            rel_root = os.path.relpath(root, self.workspace_root)
            for name in files:
                rel = os.path.normpath(os.path.join(rel_root, name))
                rel_posix = rel.replace("\\", "/")
                for pattern in globs:
                    if fnmatch.fnmatch(rel_posix, pattern):
                        matches.append(rel_posix)
                        break
        return list(dict.fromkeys(matches))

    def _add_file_chunks(self, rel_path: str, kind: str) -> None:
        content = self._read_file(rel_path)
        if not content:
            return
        file_hash = self._get_file_hash(rel_path) or self._hash_text(content)
        self._file_hashes[rel_path] = file_hash

        chunks = self._chunk_text(content)
        for idx, text in enumerate(chunks):
            symbol_name = f"spec:{rel_path}#{idx}"
            metadata = ChunkMetadata(
                file_path=rel_path,
                start_line=1,
                end_line=max(1, text.count("\n") + 1),
                symbol_name=symbol_name,
                qualified_name=symbol_name,
                symbol_type=SymbolType.MODULE,
                signature="",
                docstring="",
                language="spec",
                is_public=True,
                is_test=(kind == "tests"),
                module_group=os.path.dirname(rel_path).replace("\\", "/"),
                chunking_version="spec-v1",
            )
            chunk = SemanticChunk(
                id="",
                _code_body=text,
                metadata=metadata,
                content_hash=file_hash,
            )
            self._chunks.append(SpecChunkRecord(chunk=chunk, kind=kind, score=0.0))

    def _read_file(self, rel_path: str) -> str:
        try:
            abs_path = os.path.join(self.workspace_root, rel_path)
            with open(abs_path, "rb") as f:
                data = f.read()
            return data.decode("utf-8", errors="ignore")
        except Exception:
            return ""

    def _get_file_hash(self, rel_path: str) -> str:
        if self.file_reader and hasattr(self.file_reader, "get_file_hash"):
            return self.file_reader.get_file_hash(rel_path)
        try:
            abs_path = os.path.join(self.workspace_root, rel_path)
            with open(abs_path, "rb") as f:
                data = f.read()
            return hashlib.sha256(data).hexdigest()[:16]
        except Exception:
            return ""

    def _hash_text(self, text: str) -> str:
        return hashlib.sha256(text.encode("utf-8", errors="ignore")).hexdigest()[:16]

    def _chunk_text(self, text: str) -> List[str]:
        # Split by headings or blank lines, then pack into size-limited chunks
        parts = re.split(r"\n\s*#+\s+|\n\s*\n", text)
        chunks: List[str] = []
        buf = ""
        max_chars = max(500, int(self.config.spec_chunk_chars))
        for part in parts:
            part = part.strip()
            if not part:
                continue
            if len(buf) + len(part) + 2 > max_chars:
                if buf:
                    chunks.append(buf.strip())
                buf = part
            else:
                buf = (buf + "\n\n" + part).strip()
        if buf:
            chunks.append(buf.strip())
        return chunks

    def _tokenize(self, text: str) -> List[str]:
        return [t for t in re.findall(r"[A-Za-z_][A-Za-z0-9_]{2,}", text.lower())]

    def _score_terms(self, text: str, terms: List[str]) -> float:
        if not text or not terms:
            return 0.0
        text_lower = text.lower()
        hits = sum(1 for t in set(terms) if t in text_lower)
        return hits / max(1, len(set(terms)))

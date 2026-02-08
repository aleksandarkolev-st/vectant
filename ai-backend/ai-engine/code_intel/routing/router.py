from __future__ import annotations

import logging
import time
from typing import List, Optional, Set

from .intent_classifier import IntentClassifier
from .types import QueryIntent, RoutingResult
from ..core.config import get_config
from .change_impact import ChangeImpactModel
from .project_dna import ProjectDNA


logger = logging.getLogger("code_intel.routing.router")


class QueryRouter:
    def __init__(self, structural_index, lexical_index=None, vector_index=None, file_reader=None):
        self.structural_index = structural_index
        self.lexical_index = lexical_index
        self.vector_index = vector_index
        self.file_reader = file_reader
        self.config = get_config()
        self.intent_classifier = IntentClassifier()
        workspace_root = getattr(file_reader, "root", None) or "."
        self.change_impact = ChangeImpactModel(workspace_root)
        self.project_dna = ProjectDNA(structural_index)

    def route(self, parsed_query, query_text: str, editor_context: Optional[str] = None) -> RoutingResult:
        if not self.config.routing.enable_router:
            return RoutingResult(intent=QueryIntent.UNKNOWN)

        intent = self.intent_classifier.classify(query_text, editor_context)
        result = RoutingResult(intent=intent)

        seed_symbols = list(dict.fromkeys(parsed_query.symbol_names or []))
        seed_files = list(dict.fromkeys(parsed_query.file_patterns or []))

        # Editor context hints (open file, cursor)
        if editor_context:
            file_hints = self._extract_file_hints(editor_context)
            seed_files.extend(file_hints)

        # Expand symbols from lexical search
        if self.lexical_index and query_text:
            lex_results = self.lexical_index.search(query_text, k=self.config.retrieval.bm25_top_k)
            for r in lex_results[: self.config.routing.max_seed_chunks]:
                result.seed_chunks.append(r.chunk_id)
                if r.chunk and r.chunk.symbol_name:
                    seed_symbols.append(r.chunk.symbol_name)
                if r.chunk and r.chunk.file_path:
                    seed_files.append(r.chunk.file_path)

        # Resolve symbols to chunks
        seed_chunks = set(result.seed_chunks)
        for sym in seed_symbols[: self.config.routing.max_seed_symbols]:
            for cid in self.structural_index.find_chunks_for_symbol(sym):
                seed_chunks.add(cid)

        # Expand by file patterns
        seed_files = seed_files[: self.config.routing.max_seed_files]
        for fp in seed_files:
            for cid in self.structural_index.get_chunks_for_file(fp):
                seed_chunks.add(cid)

        # Graph expansion from seeds
        expanded = self._expand_graph(seed_chunks, max_hops=self.config.routing.max_graph_hops)
        seed_chunks.update(expanded)

        # Hot path boosts
        centrality = self.structural_index.compute_call_centrality()
        for qn, score in sorted(centrality.items(), key=lambda x: x[1], reverse=True)[:50]:
            cid = self.structural_index.graph.get_chunk_id(qn)
            if cid:
                result.boosts_by_chunk[cid] = result.boosts_by_chunk.get(cid, 0.0) + self.config.routing.hot_path_boost

        # Recent edit boosts
        self._apply_recent_edit_boosts(result, seed_files)

        # Change impact boosts (git co-change neighborhoods)
        self._apply_change_impact_boosts(result, seed_files)

        # Project DNA routing boosts (module alignment)
        self._apply_project_dna_boosts(result, query_text)

        result.seed_symbols = seed_symbols[: self.config.routing.max_seed_symbols]
        result.seed_files = seed_files[: self.config.routing.max_seed_files]
        result.seed_chunks = list(seed_chunks)[: self.config.routing.max_seed_chunks]
        result.query_terms = self._extract_terms(query_text)
        result.rationale = f"Intent={intent.value} seeds={len(result.seed_chunks)}"
        return result

    def _expand_graph(self, seed_chunks: Set[str], max_hops: int = 2) -> Set[str]:
        if not seed_chunks or max_hops <= 0:
            return set()
        expanded = set(seed_chunks)
        frontier = set(seed_chunks)
        for _ in range(max_hops):
            next_frontier = set()
            for cid in frontier:
                related = self.structural_index.get_related_chunks(cid)
                for rid in related:
                    if rid not in expanded:
                        expanded.add(rid)
                        next_frontier.add(rid)
            frontier = next_frontier
            if not frontier:
                break
        return expanded

    def _apply_recent_edit_boosts(self, result: RoutingResult, seed_files: List[str]) -> None:
        if not self.file_reader or not hasattr(self.file_reader, "get_file_stat"):
            return
        now_ns = int(time.time() * 1e9)
        window_ns = int(self.config.routing.recent_edit_window_hours * 3600 * 1e9)

        for fp in seed_files:
            stat = self.file_reader.get_file_stat(fp)
            if not stat:
                continue
            age_ns = now_ns - int(stat.get("mtime_ns", 0))
            if age_ns <= window_ns:
                result.boosts_by_file[fp] = result.boosts_by_file.get(fp, 0.0) + self.config.routing.recent_edit_boost

    def _apply_change_impact_boosts(self, result: RoutingResult, seed_files: List[str]) -> None:
        if not seed_files or not self.config.retrieval.enable_change_impact:
            return
        neighbors = self.change_impact.get_neighbors(seed_files)
        for fp in neighbors:
            result.boosts_by_file[fp] = result.boosts_by_file.get(fp, 0.0) + self.config.retrieval.change_impact_boost

    def _apply_project_dna_boosts(self, result: RoutingResult, query_text: str) -> None:
        modules = self.project_dna.score_modules(query_text or "")
        if not modules:
            return
        for module in modules:
            for fp in self.structural_index.list_files():
                if module and fp.startswith(module):
                    result.boosts_by_file[fp] = result.boosts_by_file.get(fp, 0.0) + (self.config.routing.hot_path_boost * 0.5)

    def _extract_terms(self, query_text: str) -> List[str]:
        if not query_text:
            return []
        terms = [t for t in query_text.replace("/", " ").split() if len(t) > 2]
        return list(dict.fromkeys(terms))

    def _extract_file_hints(self, text: str) -> List[str]:
        import re
        matches = re.findall(r"([A-Za-z0-9_./\\-]+\.[A-Za-z0-9_]+)", text)
        return list(dict.fromkeys(matches))

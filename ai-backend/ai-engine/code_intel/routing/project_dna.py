"""
Project DNA - Lightweight learned routing signal from repo structure.
"""

from __future__ import annotations

import logging
import re
from collections import Counter, defaultdict
from typing import Dict, Iterable, List

from ..core.types import get_module_group

logger = logging.getLogger("code_intel.routing.project_dna")


class ProjectDNA:
    def __init__(self, structural_index):
        self.structural_index = structural_index
        self._module_terms: Dict[str, Counter] = defaultdict(Counter)
        self._built = False

    def build(self) -> None:
        if self._built:
            return
        self._built = True
        files = self.structural_index.list_files()
        for fp in files:
            symbols = self.structural_index.get_file_symbols(fp)
            module = get_module_group(fp, "")
            terms = self._tokenize(fp)
            for sym in symbols:
                terms.extend(self._tokenize(sym))
            if terms:
                self._module_terms[module].update(terms)

    def score_modules(self, query: str, top_k: int = 5) -> List[str]:
        self.build()
        terms = self._tokenize(query)
        if not terms:
            return []
        scores: Dict[str, int] = {}
        for module, counter in self._module_terms.items():
            scores[module] = sum(counter.get(t, 0) for t in terms)
        ranked = sorted(scores.items(), key=lambda x: x[1], reverse=True)
        return [m for m, s in ranked[:top_k] if s > 0]

    def _tokenize(self, text: str) -> List[str]:
        return re.findall(r"[A-Za-z_][A-Za-z0-9_]{2,}", text.lower())

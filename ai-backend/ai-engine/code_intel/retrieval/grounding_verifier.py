"""
Structured Grounding Verifier
Maps code references in output to context spans and rejects ungrounded symbols.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class GroundingResult:
    is_grounded: bool
    mapping: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    ungrounded: List[str] = field(default_factory=list)


class GroundingVerifier:
    def __init__(self, allowed_symbols: Optional[List[str]] = None):
        self.allowed_symbols = set(allowed_symbols or [])

    def verify(self, output_text: str, context_spans: List[Dict[str, Any]]) -> GroundingResult:
        symbol_to_span: Dict[str, Dict[str, Any]] = {}
        for span in context_spans:
            sym = span.get("symbol")
            if sym:
                symbol_to_span[sym] = span
        self.allowed_symbols |= set(symbol_to_span.keys())

        referenced = self._extract_symbols(output_text)
        ungrounded = [s for s in referenced if s not in self.allowed_symbols]

        mapping: Dict[str, Dict[str, Any]] = {}
        for s in referenced:
            if s in symbol_to_span:
                mapping[s] = symbol_to_span[s]

        return GroundingResult(
            is_grounded=len(ungrounded) == 0,
            mapping=mapping,
            ungrounded=ungrounded,
        )

    def _extract_symbols(self, text: str) -> List[str]:
        # Prefer backticked identifiers
        backticked = re.findall(r"`([A-Za-z_][A-Za-z0-9_]*)`", text)
        # Also capture CamelCase / snake_case identifiers
        identifiers = re.findall(r"\b[A-Za-z_][A-Za-z0-9_]{2,}\b", text)
        combined = backticked + identifiers
        # Deduplicate preserving order
        seen = set()
        result = []
        for s in combined:
            if s in seen:
                continue
            seen.add(s)
            result.append(s)
        return result

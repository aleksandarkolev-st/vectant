from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, List, Set


class QueryIntent(str, Enum):
    DEBUG = "debug"
    REFACTOR = "refactor"
    GENERATE = "generate"
    EXPLAIN = "explain"
    NAVIGATE = "navigate"
    TEST = "test"
    PERFORMANCE = "performance"
    UNKNOWN = "unknown"


@dataclass
class RoutingResult:
    intent: QueryIntent
    seed_symbols: List[str] = field(default_factory=list)
    seed_files: List[str] = field(default_factory=list)
    seed_chunks: List[str] = field(default_factory=list)
    query_terms: List[str] = field(default_factory=list)
    rationale: str = ""
    boosts_by_file: Dict[str, float] = field(default_factory=dict)
    boosts_by_chunk: Dict[str, float] = field(default_factory=dict)
    metadata: Dict[str, str] = field(default_factory=dict)

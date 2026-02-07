"""
Query Processor - Parse and prepare user queries for retrieval.

Responsibilities:
- Extract key concepts from user query
- Identify likely symbol names, file paths, patterns
- Determine query intent (find, understand, modify, debug)
- Generate search embeddings
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from enum import Enum
from typing import List, Optional, Set, Tuple

import numpy as np


logger = logging.getLogger("code_intel.retrieval.query")


class QueryIntent(Enum):
    """Types of user intent."""
    FIND = "find"  # Find where something is defined/used
    UNDERSTAND = "understand"  # Understand how something works
    MODIFY = "modify"  # Make changes to code
    DEBUG = "debug"  # Debug an issue
    CREATE = "create"  # Create new code
    REVIEW = "review"  # Review/explain existing code


@dataclass
class ParsedQuery:
    """Parsed representation of user query."""
    
    # Original query
    raw_query: str
    
    # Detected intent
    intent: QueryIntent
    
    # Extracted components
    symbol_names: List[str] = field(default_factory=list)
    file_patterns: List[str] = field(default_factory=list)
    language_hints: List[str] = field(default_factory=list)
    error_patterns: List[str] = field(default_factory=list)
    
    # Folder scope - when user mentions a folder, restrict retrieval to it
    # e.g., "explain test-1" -> folder_scope = "test-1"
    folder_scope: Optional[str] = None
    
    # Search-optimized text
    search_text: str = ""
    
    # Embedding (set by embedder)
    embedding: Optional[np.ndarray] = None
    
    # Confidence in intent detection
    intent_confidence: float = 0.0


class QueryProcessor:
    """
    Process user queries for code retrieval.
    
    Extracts structure from natural language queries.
    """
    
    # Intent keywords
    INTENT_PATTERNS = {
        QueryIntent.FIND: [
            r"\bfind\b", r"\bwhere\b", r"\blocate\b", r"\bsearch\b",
            r"\blook for\b", r"\bshow me\b",
        ],
        QueryIntent.UNDERSTAND: [
            r"\bhow does\b", r"\bexplain\b", r"\bwhat does\b", r"\bunderstand\b",
            r"\bwalk.*through\b", r"\bdescribe\b",
        ],
        QueryIntent.MODIFY: [
            r"\bchange\b", r"\bmodify\b", r"\bupdate\b", r"\bedit\b",
            r"\badd\b", r"\bremove\b", r"\brefactor\b", r"\brename\b",
        ],
        QueryIntent.DEBUG: [
            r"\berror\b", r"\bbug\b", r"\bfix\b", r"\bwhy\b.*\bnot\b",
            r"\bdoesn't work\b", r"\bfailing\b", r"\bbroken\b", r"\bissue\b",
        ],
        QueryIntent.CREATE: [
            r"\bcreate\b", r"\bimplement\b", r"\bbuild\b", r"\bwrite\b",
            r"\bgenerate\b", r"\bmake\b.*\bnew\b",
        ],
        QueryIntent.REVIEW: [
            r"\breview\b", r"\bcheck\b", r"\banalyze\b", r"\blook at\b",
            r"\bexamine\b",
        ],
    }
    
    # Symbol patterns (code identifiers)
    SYMBOL_PATTERNS = [
        r"\b([A-Z][a-zA-Z0-9]+(?:Service|Controller|Handler|Manager|Provider|Factory))\b",
        r"\b([a-z_][a-zA-Z0-9_]+)\s*\(",  # Function calls
        r"`([a-zA-Z_][a-zA-Z0-9_]*)`",  # Backtick-quoted identifiers
        r"class\s+([A-Z][a-zA-Z0-9]+)",  # Class mentions
        r"function\s+([a-zA-Z_][a-zA-Z0-9_]+)",  # Function mentions
        r"def\s+([a-z_][a-zA-Z0-9_]+)",  # Python function mentions
    ]
    
    # File patterns
    FILE_PATTERNS = [
        r"([a-zA-Z_][a-zA-Z0-9_/\\.-]*\.(py|js|ts|tsx|jsx|java|go|rs|cpp|c|h))",
        r"in\s+([a-zA-Z_][a-zA-Z0-9_/\\.-]+)",  # "in folder/file"
    ]
    
    # Language hints
    LANGUAGE_HINTS = {
        "python": ["python", "py", "django", "flask", "fastapi"],
        "typescript": ["typescript", "ts", "tsx", "angular"],
        "javascript": ["javascript", "js", "jsx", "node", "react"],
        "java": ["java", "spring", "maven", "gradle"],
        "go": ["golang", "go"],
        "rust": ["rust", "rs", "cargo"],
    }
    
    # Error patterns
    ERROR_PATTERNS = [
        r"(\w+Error):?\s*(.+?)(?:\n|$)",
        r"(\w+Exception):?\s*(.+?)(?:\n|$)",
        r"line\s+(\d+)",
        r"at\s+([a-zA-Z_][a-zA-Z0-9_/.]+):(\d+)",
    ]
    
    def __init__(self):
        pass
    
    # Folder scope patterns - detect when user mentions a specific folder
    # These patterns extract folder names like "test-1", "src/components", etc.
    FOLDER_SCOPE_PATTERNS = [
        # "explain test-1", "describe src/utils", "analyze my-folder"
        r"(?:explain|describe|show|analyze|understand)\s+([a-zA-Z_][a-zA-Z0-9_-]*(?:/[a-zA-Z_][a-zA-Z0-9_-]*)*)(?:\s|$|\?|\.)",
        # "in test-1", "about src/lib", "from components"
        r"(?:in|about|from)\s+([a-zA-Z_][a-zA-Z0-9_-]*(?:/[a-zA-Z_][a-zA-Z0-9_-]*)*)(?:\s|$|\?|\.)",
        # "the test-1 folder", "src directory", "utils module"
        r"(?:the\s+)?([a-zA-Z_][a-zA-Z0-9_-]*(?:/[a-zA-Z_][a-zA-Z0-9_-]*)*)(?:\s+folder|\s+directory|\s+module|\s+package)",
        # Just a folder name at the start: "test-1"
        r"^([a-zA-Z_][a-zA-Z0-9_-]*)$",
    ]
    
    def process(self, query: str) -> ParsedQuery:
        """
        Process a user query.
        
        Args:
            query: User's natural language query
            
        Returns:
            ParsedQuery with extracted components
        """
        # Detect intent
        intent, confidence = self._detect_intent(query)
        
        # Extract symbols
        symbols = self._extract_symbols(query)
        
        # Extract file patterns
        files = self._extract_file_patterns(query)
        
        # Extract folder scope (for scoped retrieval)
        folder_scope = self._extract_folder_scope(query)
        
        # Detect language hints
        languages = self._detect_languages(query)
        
        # Extract error patterns (for debug queries)
        errors = self._extract_errors(query) if intent == QueryIntent.DEBUG else []
        
        # Generate search-optimized text
        search_text = self._optimize_for_search(query, symbols, files)
        
        return ParsedQuery(
            raw_query=query,
            intent=intent,
            intent_confidence=confidence,
            symbol_names=symbols,
            file_patterns=files,
            folder_scope=folder_scope,
            language_hints=languages,
            error_patterns=errors,
            search_text=search_text,
        )
    
    def _detect_intent(self, query: str) -> Tuple[QueryIntent, float]:
        """Detect query intent."""
        query_lower = query.lower()
        
        scores = {}
        for intent, patterns in self.INTENT_PATTERNS.items():
            score = sum(
                1 for pattern in patterns
                if re.search(pattern, query_lower)
            )
            if score > 0:
                scores[intent] = score
        
        if not scores:
            # Default to UNDERSTAND
            return QueryIntent.UNDERSTAND, 0.3
        
        # Pick highest scoring intent
        best_intent = max(scores, key=scores.get)
        total_matches = sum(scores.values())
        confidence = scores[best_intent] / total_matches if total_matches > 0 else 0.5
        
        return best_intent, confidence
    
    def _extract_symbols(self, query: str) -> List[str]:
        """Extract potential symbol names."""
        symbols = set()
        
        for pattern in self.SYMBOL_PATTERNS:
            matches = re.findall(pattern, query)
            for match in matches:
                if isinstance(match, tuple):
                    match = match[0]
                if len(match) > 2 and not self._is_common_word(match):
                    symbols.add(match)
        
        return list(symbols)
    
    def _extract_file_patterns(self, query: str) -> List[str]:
        """Extract file path patterns."""
        files = set()
        
        for pattern in self.FILE_PATTERNS:
            matches = re.findall(pattern, query)
            for match in matches:
                if isinstance(match, tuple):
                    match = match[0]
                files.add(match)
        
        return list(files)
    
    def _detect_languages(self, query: str) -> List[str]:
        """Detect language hints."""
        query_lower = query.lower()
        detected = []
        
        for lang, keywords in self.LANGUAGE_HINTS.items():
            for kw in keywords:
                if kw in query_lower:
                    detected.append(lang)
                    break
        
        return detected
    
    def _extract_errors(self, query: str) -> List[str]:
        """Extract error patterns."""
        errors = []
        
        for pattern in self.ERROR_PATTERNS:
            matches = re.findall(pattern, query)
            errors.extend(str(m) for m in matches)
        
        return errors
    
    def _extract_folder_scope(self, query: str) -> Optional[str]:
        """
        Extract folder scope from query.
        
        If user mentions a specific folder (e.g., "explain test-1"),
        we should scope retrieval to only that folder.
        """
        query_lower = query.lower().strip()
        
        # Try each pattern
        for pattern in self.FOLDER_SCOPE_PATTERNS:
            matches = re.findall(pattern, query_lower, re.IGNORECASE)
            for match in matches:
                if isinstance(match, tuple):
                    match = match[0]
                # Validate it looks like a folder (not a common word)
                if match and not self._is_common_word(match) and len(match) > 1:
                    # Skip if it matches a file extension pattern
                    if re.search(r"\.(py|js|ts|tsx|jsx|java|go|rs|cpp|c|h|hpp)$", match):
                        continue
                    logger.info(f"Detected folder scope: '{match}' from query: '{query}'")
                    return match
        
        return None
    
    def _optimize_for_search(
        self,
        query: str,
        symbols: List[str],
        files: List[str],
    ) -> str:
        """
        Create search-optimized text.
        
        Removes noise, emphasizes key terms.
        """
        # Start with cleaned query
        search_text = query
        
        # Remove common filler words
        fillers = [
            "please", "can you", "could you", "i want to", "i need to",
            "help me", "show me how to", "the", "a", "an",
        ]
        for filler in fillers:
            search_text = re.sub(rf"\b{filler}\b", "", search_text, flags=re.IGNORECASE)
        
        # Emphasize symbols by keeping them
        # Already in the text, no need to duplicate
        
        # Clean up whitespace
        search_text = " ".join(search_text.split())
        
        return search_text
    
    def _is_common_word(self, word: str) -> bool:
        """Check if word is too common to be a symbol."""
        common = {
            "the", "is", "are", "was", "were", "be", "been",
            "have", "has", "had", "do", "does", "did",
            "will", "would", "could", "should", "can",
            "this", "that", "these", "those",
            "what", "where", "when", "how", "why", "which",
            "file", "code", "function", "method", "class",
            "error", "bug", "issue", "problem",
        }
        return word.lower() in common


def process_query(query: str) -> ParsedQuery:
    """Convenience function to process a query."""
    processor = QueryProcessor()
    return processor.process(query)

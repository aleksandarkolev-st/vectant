"""
Root-Cause Diagnosis Layer.

Goes beyond surface-level "compiler error at line X" to build
a cause graph that identifies the actual root cause.

Diagnosis agent builds:
- Error symptom analysis
- Likely source file(s)
- Dependency chain from error to root cause
- Recent edits that may have caused the issue
- Prior failed fix attempts
- Confidence-ranked root cause candidates

This avoids dumb retry loops and makes multi-file fixes possible.
"""

from __future__ import annotations

import hashlib
import logging
import re
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

logger = logging.getLogger("healing.diagnosis")


# ── Cause types ───────────────────────────────────────────────────────

class CauseType(str, Enum):
    """Types of root causes."""
    SYNTAX_ERROR = "syntax_error"
    MISSING_IMPORT = "missing_import"
    WRONG_IMPORT_PATH = "wrong_import_path"
    TYPE_MISMATCH = "type_mismatch"
    UNDEFINED_VARIABLE = "undefined_variable"
    MISSING_DEPENDENCY = "missing_dependency"
    CONFIG_ERROR = "config_error"
    API_CONTRACT_BREAK = "api_contract_break"
    STALE_CACHE = "stale_cache"
    MERGE_CONFLICT_RESIDUE = "merge_conflict_residue"
    CIRCULAR_DEPENDENCY = "circular_dependency"
    VERSION_MISMATCH = "version_mismatch"
    RUNTIME_EXCEPTION = "runtime_exception"
    NULL_REFERENCE = "null_reference"
    MISSING_AWAIT = "missing_await"
    OFF_BY_ONE = "off_by_one"
    RESOURCE_LEAK = "resource_leak"
    UNKNOWN = "unknown"


class ErrorSource(str, Enum):
    """Where the error was detected."""
    COMPILER = "compiler"
    LINTER = "linter"
    TYPECHECK = "typecheck"
    RUNTIME = "runtime"
    TEST = "test"
    USER_REPORT = "user_report"
    HMR = "hmr"
    BUILD_SYSTEM = "build_system"


# ── Data structures ───────────────────────────────────────────────────

@dataclass
class ErrorSymptom:
    """Parsed representation of an error."""
    raw_message: str
    error_code: str = ""
    file_path: str = ""
    line: int = 0
    column: int = 0
    source: ErrorSource = ErrorSource.COMPILER
    severity: str = "error"        # "error", "warning", "info"
    category: str = ""             # e.g., "TS2304", "E0001", "SyntaxError"
    stack_trace: str = ""
    timestamp: float = field(default_factory=time.time)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "rawMessage": self.raw_message,
            "errorCode": self.error_code,
            "filePath": self.file_path,
            "line": self.line,
            "column": self.column,
            "source": self.source.value,
            "severity": self.severity,
            "category": self.category,
            "stackTrace": self.stack_trace,
        }


@dataclass
class CauseCandidate:
    """A potential root cause with confidence."""
    cause_type: CauseType
    description: str
    file_path: str
    line: int = 0
    confidence: float = 0.5
    evidence: List[str] = field(default_factory=list)
    related_files: List[str] = field(default_factory=list)
    suggested_fix: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "causeType": self.cause_type.value,
            "description": self.description,
            "filePath": self.file_path,
            "line": self.line,
            "confidence": round(self.confidence, 3),
            "evidence": self.evidence,
            "relatedFiles": self.related_files,
            "suggestedFix": self.suggested_fix,
        }


@dataclass
class CauseGraph:
    """A graph of related causes forming the diagnosis."""
    symptom: ErrorSymptom
    candidates: List[CauseCandidate] = field(default_factory=list)
    dependency_chain: List[str] = field(default_factory=list)
    recent_edits: List[Dict[str, Any]] = field(default_factory=list)
    prior_attempts: List[Dict[str, Any]] = field(default_factory=list)
    affected_files: Set[str] = field(default_factory=set)
    diagnosis_confidence: float = 0.0
    elapsed_ms: float = 0.0

    @property
    def primary_cause(self) -> Optional[CauseCandidate]:
        """The highest-confidence cause candidate."""
        if not self.candidates:
            return None
        return max(self.candidates, key=lambda c: c.confidence)

    @property
    def is_multi_file(self) -> bool:
        """Does the diagnosis span multiple files?"""
        files = set()
        for c in self.candidates:
            files.add(c.file_path)
            files.update(c.related_files)
        return len(files) > 1

    def to_dict(self) -> Dict[str, Any]:
        primary = self.primary_cause
        return {
            "symptom": self.symptom.to_dict(),
            "primaryCause": primary.to_dict() if primary else None,
            "candidates": [c.to_dict() for c in self.candidates],
            "dependencyChain": self.dependency_chain,
            "recentEdits": self.recent_edits,
            "priorAttempts": self.prior_attempts,
            "affectedFiles": list(self.affected_files),
            "diagnosisConfidence": round(self.diagnosis_confidence, 3),
            "isMultiFile": self.is_multi_file,
            "elapsedMs": round(self.elapsed_ms, 1),
        }


# ── Error parsers (extract structure from raw error messages) ─────────

class ErrorParser:
    """
    Parses raw error messages into structured ErrorSymptom objects.

    Supports:
    - Python tracebacks
    - JavaScript/TypeScript errors
    - Go compiler errors
    - Rust compiler errors
    - Generic file:line:col patterns
    """

    # Common error patterns
    _PATTERNS = {
        "python_syntax": re.compile(
            r'File "([^"]+)", line (\d+).*\n\s*(.+)\n\s*\^\n(\w+Error: .+)',
            re.MULTILINE,
        ),
        "python_traceback": re.compile(
            r'File "([^"]+)", line (\d+), in (\w+)\n\s*(.+)',
            re.MULTILINE,
        ),
        "python_import": re.compile(
            r'ModuleNotFoundError: No module named [\'"]([^\'"]+)[\'"]',
        ),
        "ts_error": re.compile(
            r'(.+)\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*(.+)',
        ),
        "eslint_error": re.compile(
            r'(\d+):(\d+)\s+(error|warning)\s+(.+?)\s+([\w/-]+)$',
            re.MULTILINE,
        ),
        "go_error": re.compile(
            r'(.+\.go):(\d+):(\d+):\s*(.+)',
        ),
        "rust_error": re.compile(
            r'error\[(\w+)\]:\s*(.+)\n\s*-->\s*(.+):(\d+):(\d+)',
            re.MULTILINE,
        ),
        "generic_file_line": re.compile(
            r'([^\s:]+):(\d+)(?::(\d+))?(?::\s*|\s+)(error|Error|ERROR)(?::\s*|\s+)(.+)',
        ),
        "node_error": re.compile(
            r'(.+)\n\s+at\s+(.+?)\s+\(([^:]+):(\d+):(\d+)\)',
            re.MULTILINE,
        ),
    }

    def parse(
        self,
        error_text: str,
        source: ErrorSource = ErrorSource.COMPILER,
    ) -> List[ErrorSymptom]:
        """Parse error text into structured symptoms."""
        symptoms = []

        # Try each pattern
        for pattern_name, pattern in self._PATTERNS.items():
            for match in pattern.finditer(error_text):
                symptom = self._extract_symptom(
                    pattern_name, match, error_text, source
                )
                if symptom:
                    symptoms.append(symptom)

        # If no patterns matched, create a generic symptom
        if not symptoms and error_text.strip():
            symptoms.append(ErrorSymptom(
                raw_message=error_text.strip()[:500],
                source=source,
            ))

        return symptoms

    def _extract_symptom(
        self,
        pattern_name: str,
        match: re.Match,
        full_text: str,
        source: ErrorSource,
    ) -> Optional[ErrorSymptom]:
        """Extract an ErrorSymptom from a regex match."""
        try:
            if pattern_name == "python_syntax":
                return ErrorSymptom(
                    raw_message=match.group(4),
                    file_path=match.group(1),
                    line=int(match.group(2)),
                    source=source,
                    category="SyntaxError",
                )
            elif pattern_name == "python_traceback":
                return ErrorSymptom(
                    raw_message=match.group(4).strip(),
                    file_path=match.group(1),
                    line=int(match.group(2)),
                    source=source,
                    stack_trace=full_text,
                )
            elif pattern_name == "python_import":
                return ErrorSymptom(
                    raw_message=f"Module not found: {match.group(1)}",
                    source=source,
                    category="ImportError",
                )
            elif pattern_name == "ts_error":
                return ErrorSymptom(
                    raw_message=match.group(5),
                    error_code=match.group(4),
                    file_path=match.group(1),
                    line=int(match.group(2)),
                    column=int(match.group(3)),
                    source=source,
                    category=match.group(4),
                )
            elif pattern_name == "go_error":
                return ErrorSymptom(
                    raw_message=match.group(4),
                    file_path=match.group(1),
                    line=int(match.group(2)),
                    column=int(match.group(3)),
                    source=source,
                )
            elif pattern_name == "rust_error":
                return ErrorSymptom(
                    raw_message=match.group(2),
                    error_code=match.group(1),
                    file_path=match.group(3),
                    line=int(match.group(4)),
                    column=int(match.group(5)),
                    source=source,
                    category=match.group(1),
                )
            elif pattern_name == "generic_file_line":
                return ErrorSymptom(
                    raw_message=match.group(5),
                    file_path=match.group(1),
                    line=int(match.group(2)),
                    column=int(match.group(3)) if match.group(3) else 0,
                    source=source,
                )
            elif pattern_name == "node_error":
                return ErrorSymptom(
                    raw_message=match.group(1),
                    file_path=match.group(3),
                    line=int(match.group(4)),
                    column=int(match.group(5)),
                    source=source,
                    stack_trace=full_text,
                )
        except (ValueError, IndexError):
            pass
        return None


# ── Diagnosis Agent ───────────────────────────────────────────────────

class DiagnosisAgent:
    """
    Builds a cause graph from error symptoms.

    Process:
    1. Parse error message into structured symptom
    2. Identify likely cause type from patterns
    3. Trace dependency chain
    4. Check recent edits
    5. Check prior failed attempts
    6. Rank cause candidates by confidence

    Can operate in two modes:
    - Fast (regex-only): pattern matching, ~10ms
    - Deep (LLM-assisted): sends context to AI for root cause, ~5s
    """

    def __init__(
        self,
        error_parser: Optional[ErrorParser] = None,
        dep_graph_fn: Optional[Callable] = None,
        recent_edits_fn: Optional[Callable] = None,
        read_file_fn: Optional[Callable] = None,
    ):
        self._parser = error_parser or ErrorParser()
        self._dep_graph_fn = dep_graph_fn  # (file_path) -> list of deps
        self._recent_edits_fn = recent_edits_fn  # () -> list of {file, timestamp}
        self._read_file_fn = read_file_fn  # (file_path) -> str

        # Error pattern → cause type mappings
        self._cause_patterns: List[Tuple[re.Pattern, CauseType, float]] = [
            # Syntax errors
            (re.compile(r"SyntaxError|unexpected token|unexpected end", re.I),
             CauseType.SYNTAX_ERROR, 0.95),
            # Import errors
            (re.compile(r"cannot find module|ModuleNotFoundError|import.*not found", re.I),
             CauseType.MISSING_IMPORT, 0.90),
            (re.compile(r"cannot resolve|unable to resolve|resolve.*failed", re.I),
             CauseType.WRONG_IMPORT_PATH, 0.85),
            # Type errors
            (re.compile(r"Type.*not assignable|type mismatch|incompatible type", re.I),
             CauseType.TYPE_MISMATCH, 0.80),
            (re.compile(r"TS2304|is not defined|undeclared|not declared", re.I),
             CauseType.UNDEFINED_VARIABLE, 0.85),
            # Null/undefined
            (re.compile(r"null|undefined is not|cannot read property|NullPointerException", re.I),
             CauseType.NULL_REFERENCE, 0.80),
            # Async issues
            (re.compile(r"missing await|not a promise|unhandled promise", re.I),
             CauseType.MISSING_AWAIT, 0.85),
            # Dependency issues
            (re.compile(r"peer dependency|version.*conflict|incompatible.*version", re.I),
             CauseType.VERSION_MISMATCH, 0.75),
            (re.compile(r"circular dependency|circular import|cycle.*detected", re.I),
             CauseType.CIRCULAR_DEPENDENCY, 0.90),
            # Merge conflict leftovers
            (re.compile(r"<<<<<<|>>>>>>|======.*HEAD", re.I),
             CauseType.MERGE_CONFLICT_RESIDUE, 0.98),
            # Config errors
            (re.compile(r"configuration.*error|invalid.*config|missing.*field.*config", re.I),
             CauseType.CONFIG_ERROR, 0.70),
            # Resource leaks
            (re.compile(r"EMFILE|too many open|connection.*limit|pool.*exhausted", re.I),
             CauseType.RESOURCE_LEAK, 0.75),
        ]

    def diagnose(
        self,
        error_text: str,
        file_path: str = "",
        language: str = "",
        source: ErrorSource = ErrorSource.COMPILER,
        prior_attempts: Optional[List[Dict[str, Any]]] = None,
    ) -> CauseGraph:
        """
        Build a cause graph from error text.

        Fast mode (regex-only), returns in ~10ms.
        """
        start = time.perf_counter()

        # Step 1: Parse error
        symptoms = self._parser.parse(error_text, source)
        primary_symptom = symptoms[0] if symptoms else ErrorSymptom(
            raw_message=error_text[:500],
            file_path=file_path,
            source=source,
        )
        if file_path and not primary_symptom.file_path:
            primary_symptom.file_path = file_path

        # Step 2: Identify cause candidates from patterns
        candidates = self._identify_causes(error_text, file_path)

        # Step 3: Get dependency chain
        dep_chain = []
        if self._dep_graph_fn and file_path:
            try:
                dep_chain = self._dep_graph_fn(file_path)
            except Exception as e:
                logger.debug(f"Dep graph lookup failed: {e}")

        # Step 4: Get recent edits
        recent_edits = []
        if self._recent_edits_fn:
            try:
                recent_edits = self._recent_edits_fn()
            except Exception as e:
                logger.debug(f"Recent edits lookup failed: {e}")

        # Step 5: Build affected files set
        affected = set()
        affected.add(file_path)
        for symptom in symptoms:
            if symptom.file_path:
                affected.add(symptom.file_path)
        for candidate in candidates:
            affected.add(candidate.file_path)
            affected.update(candidate.related_files)

        # Compute overall confidence
        if candidates:
            max_conf = max(c.confidence for c in candidates)
        else:
            max_conf = 0.0

        elapsed = (time.perf_counter() - start) * 1000

        graph = CauseGraph(
            symptom=primary_symptom,
            candidates=sorted(candidates, key=lambda c: c.confidence, reverse=True),
            dependency_chain=dep_chain,
            recent_edits=recent_edits[:10],
            prior_attempts=prior_attempts or [],
            affected_files=affected,
            diagnosis_confidence=max_conf,
            elapsed_ms=elapsed,
        )

        logger.info(
            f"Diagnosis: {len(candidates)} cause candidates, "
            f"primary={graph.primary_cause.cause_type.value if graph.primary_cause else 'unknown'}, "
            f"confidence={max_conf:.2f}, "
            f"multi_file={graph.is_multi_file}, "
            f"in {elapsed:.1f}ms"
        )

        return graph

    def _identify_causes(
        self,
        error_text: str,
        file_path: str,
    ) -> List[CauseCandidate]:
        """Match error text against cause patterns."""
        candidates = []
        seen_types = set()

        for pattern, cause_type, base_confidence in self._cause_patterns:
            matches = pattern.findall(error_text)
            if matches and cause_type not in seen_types:
                seen_types.add(cause_type)
                evidence = [m if isinstance(m, str) else str(m) for m in matches[:3]]
                candidates.append(CauseCandidate(
                    cause_type=cause_type,
                    description=f"Detected {cause_type.value}: {evidence[0][:100]}",
                    file_path=file_path,
                    confidence=base_confidence,
                    evidence=evidence,
                ))

        # If no patterns matched, add UNKNOWN
        if not candidates:
            candidates.append(CauseCandidate(
                cause_type=CauseType.UNKNOWN,
                description=f"Unknown error: {error_text[:100]}",
                file_path=file_path,
                confidence=0.2,
                evidence=[error_text[:200]],
            ))

        return candidates

    async def diagnose_deep(
        self,
        error_text: str,
        file_path: str = "",
        language: str = "",
        source: ErrorSource = ErrorSource.COMPILER,
        code: str = "",
        llm_fn: Optional[Callable] = None,
        prior_attempts: Optional[List[Dict[str, Any]]] = None,
    ) -> CauseGraph:
        """
        Deep diagnosis using LLM.

        Sends error + code context to LLM for root cause analysis.
        Falls back to fast diagnosis if LLM is unavailable.
        """
        # Get fast diagnosis first
        graph = self.diagnose(
            error_text, file_path, language, source, prior_attempts
        )

        # If no LLM function or no code, return fast result
        if not llm_fn or not code:
            return graph

        start = time.perf_counter()

        try:
            prompt = self._build_diagnosis_prompt(
                error_text, code, language, file_path,
                graph.dependency_chain, graph.recent_edits,
                prior_attempts,
            )

            response = await llm_fn(prompt)
            llm_candidates = self._parse_llm_diagnosis(response, file_path)

            if llm_candidates:
                # Merge LLM candidates with regex candidates
                graph.candidates = self._merge_candidates(
                    graph.candidates, llm_candidates
                )
                graph.diagnosis_confidence = max(
                    c.confidence for c in graph.candidates
                )

        except Exception as e:
            logger.warning(f"LLM diagnosis failed: {e}")

        graph.elapsed_ms += (time.perf_counter() - start) * 1000
        return graph

    def _build_diagnosis_prompt(
        self,
        error_text: str,
        code: str,
        language: str,
        file_path: str,
        dependency_chain: List[str],
        recent_edits: List[Dict[str, Any]],
        prior_attempts: Optional[List[Dict[str, Any]]],
    ) -> str:
        """Build a prompt for LLM root cause diagnosis."""
        parts = [
            "You are a root-cause diagnosis agent. Analyze this error and identify the root cause.",
            "",
            f"## Error",
            f"```",
            error_text[:1000],
            f"```",
            "",
            f"## File: {file_path} ({language})",
            f"```{language}",
            code[:3000],
            f"```",
        ]

        if dependency_chain:
            parts.extend([
                "",
                "## Dependency chain",
                ", ".join(dependency_chain[:10]),
            ])

        if recent_edits:
            parts.extend([
                "",
                "## Recently edited files",
            ])
            for edit in recent_edits[:5]:
                parts.append(f"- {edit.get('file', '?')} (edited {edit.get('ago', '?')} ago)")

        if prior_attempts:
            parts.extend([
                "",
                "## Prior fix attempts (all failed)",
            ])
            for attempt in prior_attempts[:3]:
                parts.append(f"- {attempt.get('description', '?')}: {attempt.get('failure', '?')}")

        parts.extend([
            "",
            "## Respond with JSON:",
            "```json",
            '[{"cause_type": "...", "description": "...", "file_path": "...", "line": 0, "confidence": 0.0, "suggested_fix": "..."}]',
            "```",
            "",
            "Valid cause_type values: syntax_error, missing_import, wrong_import_path, type_mismatch, "
            "undefined_variable, missing_dependency, config_error, api_contract_break, stale_cache, "
            "merge_conflict_residue, circular_dependency, version_mismatch, runtime_exception, "
            "null_reference, missing_await, off_by_one, resource_leak, unknown",
        ])

        return "\n".join(parts)

    def _parse_llm_diagnosis(
        self,
        response: str,
        default_file: str,
    ) -> List[CauseCandidate]:
        """Parse LLM diagnosis response into CauseCandidates."""
        import json

        candidates = []

        # Extract JSON from response
        json_match = re.search(r'\[[\s\S]*?\]', response)
        if not json_match:
            return candidates

        try:
            items = json.loads(json_match.group(0))
        except json.JSONDecodeError:
            return candidates

        for item in items:
            if not isinstance(item, dict):
                continue
            try:
                cause_type_str = item.get("cause_type", "unknown")
                try:
                    cause_type = CauseType(cause_type_str)
                except ValueError:
                    cause_type = CauseType.UNKNOWN

                candidates.append(CauseCandidate(
                    cause_type=cause_type,
                    description=str(item.get("description", ""))[:200],
                    file_path=str(item.get("file_path", default_file)),
                    line=int(item.get("line", 0)),
                    confidence=min(float(item.get("confidence", 0.5)) * 0.85, 0.95),
                    suggested_fix=str(item.get("suggested_fix", ""))[:500],
                ))
            except (TypeError, ValueError):
                continue

        return candidates

    def _merge_candidates(
        self,
        regex_candidates: List[CauseCandidate],
        llm_candidates: List[CauseCandidate],
    ) -> List[CauseCandidate]:
        """Merge regex and LLM candidates, preferring LLM for same type."""
        seen_types = set()
        merged = []

        # LLM candidates first (higher quality for same type)
        for c in llm_candidates:
            merged.append(c)
            seen_types.add(c.cause_type)

        # Add regex candidates that don't overlap
        for c in regex_candidates:
            if c.cause_type not in seen_types:
                merged.append(c)
                seen_types.add(c.cause_type)

        return sorted(merged, key=lambda c: c.confidence, reverse=True)


# ── Module-level singleton ────────────────────────────────────────────

_diagnosis_agent: Optional[DiagnosisAgent] = None


def get_diagnosis_agent(**kwargs) -> DiagnosisAgent:
    """Get or create the global diagnosis agent."""
    global _diagnosis_agent
    if _diagnosis_agent is None:
        _diagnosis_agent = DiagnosisAgent(**kwargs)
    return _diagnosis_agent


def reset_diagnosis_agent() -> None:
    """Reset (for testing)."""
    global _diagnosis_agent
    _diagnosis_agent = None

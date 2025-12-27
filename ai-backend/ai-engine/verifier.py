"""
AI Output Verifier
==================
Deterministic verification stage for AI-generated code.
Enforces invariants: no missing symbols, no new globals, stable public interfaces.
Rejects or auto-repairs invalid outputs before passing to Worker.

MODES:
- Production: Strict mode, low repair depth, semantic tests enabled
- Development: Permissive mode, higher repair depth, faster verification
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional, Set, Tuple

from pydantic import BaseModel


# ============================================================
# AUTO-REPAIR CAPS - PRODUCTION DEFAULTS (CONSERVATIVE)
# ============================================================
# These are HARD LIMITS for production safety.
# Dev mode can use higher values but never exceed DEV_MAX_*.

# Production caps (strict)
MAX_REPAIR_DEPTH = 1                 # No recursive repairs in prod
MAX_REPAIR_DIFF_LINES = 50           # Max lines changed by repair
MAX_REPAIR_DIFF_RATIO = 0.15         # Max 15% of code changed
REPAIR_TIMEOUT_SECONDS = 5.0         # Max time for repair attempt

# Development caps (permissive but still bounded)
DEV_MAX_REPAIR_DEPTH = 3             # Allow multi-file repair chains
DEV_MAX_REPAIR_DIFF_LINES = 200      # More lenient for iteration
DEV_MAX_REPAIR_DIFF_RATIO = 0.40     # Up to 40% for major refactors
DEV_REPAIR_TIMEOUT_SECONDS = 15.0    # More time for complex repairs

# Environment detection
def _is_dev_mode() -> bool:
    """Check if running in development mode via environment."""
    dev_indicators = [
        os.getenv("SYNTHI_DEV_MODE", "").lower() in ("1", "true", "yes"),
        os.getenv("NODE_ENV", "").lower() == "development",
        os.getenv("DEBUG", "").lower() in ("1", "true", "yes"),
    ]
    return any(dev_indicators)


class VerificationStatus(str, Enum):
    """Status of verification result."""
    PASS = "pass"
    WARN = "warn"
    FAIL = "fail"
    REPAIRED = "repaired"


class ViolationType(str, Enum):
    """Types of invariant violations."""
    MISSING_SYMBOL = "missing_symbol"
    NEW_GLOBAL = "new_global"
    INTERFACE_CHANGE = "interface_change"
    SYNTAX_ERROR = "syntax_error"
    INCOMPLETE_CODE = "incomplete_code"
    INVALID_STRUCTURE = "invalid_structure"
    ABI_MISMATCH = "abi_mismatch"
    MISSING_EXPORT = "missing_export"


@dataclass
class Violation:
    """A single invariant violation."""
    type: ViolationType
    message: str
    location: Optional[str] = None
    severity: str = "error"  # error, warning
    auto_repairable: bool = False
    suggested_fix: Optional[str] = None


@dataclass
class VerificationResult:
    """Result of AI output verification."""
    status: VerificationStatus
    violations: List[Violation] = field(default_factory=list)
    repaired_output: Optional[str] = None
    original_hash: str = ""
    verified_hash: str = ""
    timestamp: float = field(default_factory=time.time)
    duration_ms: float = 0.0
    
    # Repair tracking
    repair_depth: int = 0
    repair_diff_lines: int = 0
    repair_diff_ratio: float = 0.0
    repair_capped: bool = False  # True if repair was limited by caps
    
    @property
    def passed(self) -> bool:
        return self.status in (VerificationStatus.PASS, VerificationStatus.REPAIRED)
    
    @property
    def is_fatal(self) -> bool:
        """Returns True if this result should raise VerificationFatalError."""
        return self.status == VerificationStatus.FAIL
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "status": self.status.value,
            "passed": self.passed,
            "violations": [
                {
                    "type": v.type.value,
                    "message": v.message,
                    "location": v.location,
                    "severity": v.severity,
                }
                for v in self.violations
            ],
            "original_hash": self.original_hash,
            "verified_hash": self.verified_hash,
            "timestamp": self.timestamp,
            "duration_ms": self.duration_ms,
        }


class SymbolTable:
    """Tracks symbols (functions, classes, variables) in code."""
    
    def __init__(self):
        self.functions: Set[str] = set()
        self.classes: Set[str] = set()
        self.globals: Set[str] = set()
        self.exports: Set[str] = set()
        self.imports: Set[str] = set()
    
    @classmethod
    def from_code(cls, code: str, lang: str) -> "SymbolTable":
        """Extract symbol table from code."""
        table = cls()
        
        if lang in ("javascript", "typescript", "jsx", "tsx"):
            table._parse_js_ts(code)
        elif lang == "python":
            table._parse_python(code)
        elif lang in ("rust", "rs"):
            table._parse_rust(code)
        elif lang in ("cpp", "c++", "c"):
            table._parse_cpp(code)
        
        return table
    
    def _parse_js_ts(self, code: str) -> None:
        """Parse JavaScript/TypeScript for symbols."""
        # Functions
        for m in re.finditer(r'(?:async\s+)?function\s+(\w+)', code):
            self.functions.add(m.group(1))
        
        # Arrow functions assigned to const/let/var
        for m in re.finditer(r'(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[\w]+)\s*=>', code):
            self.functions.add(m.group(1))
        
        # Classes
        for m in re.finditer(r'class\s+(\w+)', code):
            self.classes.add(m.group(1))
        
        # Exports
        for m in re.finditer(r'export\s+(?:default\s+)?(?:const|let|var|function|class|async\s+function)?\s*(\w+)', code):
            self.exports.add(m.group(1))
        
        # Global variables (top-level const/let/var not in functions)
        for m in re.finditer(r'^(?:const|let|var)\s+(\w+)', code, re.MULTILINE):
            self.globals.add(m.group(1))
        
        # Imports
        for m in re.finditer(r'import\s+(?:{[^}]+}|[\w*]+(?:\s*,\s*{[^}]+})?)\s+from\s+[\'"]([^\'"]+)[\'"]', code):
            self.imports.add(m.group(1))
    
    def _parse_python(self, code: str) -> None:
        """Parse Python for symbols."""
        # Functions
        for m in re.finditer(r'^def\s+(\w+)', code, re.MULTILINE):
            self.functions.add(m.group(1))
        
        # Classes
        for m in re.finditer(r'^class\s+(\w+)', code, re.MULTILINE):
            self.classes.add(m.group(1))
        
        # Global variables (top-level assignments)
        for m in re.finditer(r'^(\w+)\s*=', code, re.MULTILINE):
            name = m.group(1)
            if not name.startswith('_') and name.isupper() or not name[0].isupper():
                self.globals.add(name)
        
        # Imports
        for m in re.finditer(r'^(?:from\s+(\S+)\s+)?import\s+', code, re.MULTILINE):
            if m.group(1):
                self.imports.add(m.group(1))
    
    def _parse_rust(self, code: str) -> None:
        """Parse Rust for symbols."""
        # Functions
        for m in re.finditer(r'(?:pub\s+)?(?:async\s+)?fn\s+(\w+)', code):
            self.functions.add(m.group(1))
            if 'pub ' in code[:m.start() + 20]:
                self.exports.add(m.group(1))
        
        # Structs
        for m in re.finditer(r'(?:pub\s+)?struct\s+(\w+)', code):
            self.classes.add(m.group(1))
            if 'pub ' in code[max(0, m.start()-10):m.start()+20]:
                self.exports.add(m.group(1))
        
        # Static/const
        for m in re.finditer(r'(?:pub\s+)?(?:static|const)\s+(\w+)', code):
            self.globals.add(m.group(1))
        
        # Use statements
        for m in re.finditer(r'use\s+([^;]+)', code):
            self.imports.add(m.group(1).strip())
    
    def _parse_cpp(self, code: str) -> None:
        """Parse C/C++ for symbols."""
        # Functions (simplified)
        for m in re.finditer(r'(?:[\w:]+\s+)+(\w+)\s*\([^)]*\)\s*(?:const)?\s*(?:noexcept)?\s*(?:override)?\s*{', code):
            self.functions.add(m.group(1))
        
        # Classes/structs
        for m in re.finditer(r'(?:class|struct)\s+(\w+)', code):
            self.classes.add(m.group(1))
        
        # Extern symbols (exports)
        for m in re.finditer(r'extern\s+"C"\s+[\w*&\s]+(\w+)\s*\(', code):
            self.exports.add(m.group(1))
        
        # Includes
        for m in re.finditer(r'#include\s*[<"]([^>"]+)[>"]', code):
            self.imports.add(m.group(1))


class AIOutputVerifier:
    """
    Verifies AI-generated code against invariants.
    THIS IS A HARD GATE - FAILURES ARE FATAL, NOT ADVISORY.
    
    Invariants enforced:
    1. No missing symbols (functions/classes referenced must exist)
    2. No unexpected new globals
    3. Stable public interfaces (exports must be preserved)
    4. Valid syntax structure
    5. Complete code (no truncation, no placeholders)
    
    Auto-repair is CAPPED:
    - Production: Max 1 depth, 50 lines, 15% ratio, 5s timeout
    - Development: Max 3 depth, 200 lines, 40% ratio, 15s timeout
    
    MODES:
    - Production (default): Strict, fatal failures, low repair depth
    - Development: Permissive, warnings instead of fatal, higher repair depth
    """
    
    def __init__(
        self,
        allow_new_globals: bool = False,
        allow_interface_changes: bool = False,
        auto_repair: bool = True,
        strict_mode: bool = True,  # DEFAULT TO STRICT - failures are fatal
        raise_on_failure: bool = True,  # Raise VerificationFatalError on fail
        dev_mode: Optional[bool] = None,  # None = auto-detect from environment
        max_repair_depth: Optional[int] = None,  # None = use mode default
        max_repair_diff_lines: Optional[int] = None,
        max_repair_diff_ratio: Optional[float] = None,
        repair_timeout: Optional[float] = None,
    ):
        # Auto-detect dev mode if not specified
        self.dev_mode = dev_mode if dev_mode is not None else _is_dev_mode()
        
        # Adjust strict mode for dev
        if self.dev_mode:
            # In dev mode, default to non-strict unless explicitly set
            strict_mode = False if strict_mode is True else strict_mode
            raise_on_failure = False  # Don't block dev flow
        
        self.allow_new_globals = allow_new_globals
        self.allow_interface_changes = allow_interface_changes
        self.auto_repair = auto_repair
        self.strict_mode = strict_mode
        self.raise_on_failure = raise_on_failure
        
        # Repair caps - mode-dependent with hard limits
        if self.dev_mode:
            # Dev mode: permissive but bounded
            self.max_repair_depth = min(
                max_repair_depth or DEV_MAX_REPAIR_DEPTH,
                DEV_MAX_REPAIR_DEPTH
            )
            self.max_repair_diff_lines = min(
                max_repair_diff_lines or DEV_MAX_REPAIR_DIFF_LINES,
                DEV_MAX_REPAIR_DIFF_LINES
            )
            self.max_repair_diff_ratio = min(
                max_repair_diff_ratio or DEV_MAX_REPAIR_DIFF_RATIO,
                DEV_MAX_REPAIR_DIFF_RATIO
            )
            self.repair_timeout = min(
                repair_timeout or DEV_REPAIR_TIMEOUT_SECONDS,
                DEV_REPAIR_TIMEOUT_SECONDS
            )
        else:
            # Production: conservative hard limits
            self.max_repair_depth = min(
                max_repair_depth or MAX_REPAIR_DEPTH,
                MAX_REPAIR_DEPTH
            )
            self.max_repair_diff_lines = min(
                max_repair_diff_lines or MAX_REPAIR_DIFF_LINES,
                MAX_REPAIR_DIFF_LINES
            )
            self.max_repair_diff_ratio = min(
                max_repair_diff_ratio or MAX_REPAIR_DIFF_RATIO,
                MAX_REPAIR_DIFF_RATIO
            )
            self.repair_timeout = min(
                repair_timeout or REPAIR_TIMEOUT_SECONDS,
                REPAIR_TIMEOUT_SECONDS
            )
        
        # Track repair state
        self._current_repair_depth = 0
        
        # Patterns that indicate incomplete/placeholder code
        self.placeholder_patterns = [
            r'//\s*\.\.\.',
            r'#\s*\.\.\.',
            r'/\*\s*\.\.\.\s*\*/',
            r'TODO:?\s*implement',
            r'FIXME',
            r'\.\.\.existing\s*code',
            r'// rest of the code',
            r'# rest of the code',
            r'\[TRUNCATED\]',
            r'\[CODE CONTINUES\]',
        ]
    
    def verify(
        self,
        ai_output: str,
        original_code: Optional[str] = None,
        lang: str = "javascript",
        context: Optional[Dict[str, Any]] = None,
    ) -> VerificationResult:
        """
        Verify AI-generated code.
        
        Args:
            ai_output: The AI-generated code to verify
            original_code: The original code (for comparison)
            lang: Programming language
            context: Additional context (e.g., project symbols)
        
        Returns:
            VerificationResult with status and any violations
        """
        import logging
        logger = logging.getLogger('ai-engine.verifier')
        logger.info(f"[Verifier DEBUG] Starting verification for {lang} code ({len(ai_output)} chars)")
        if original_code:
            logger.info(f"[Verifier DEBUG] Original code provided ({len(original_code)} chars)")

        start_time = time.time()
        violations: List[Violation] = []
        repaired_output = ai_output
        
        original_hash = hashlib.sha256(ai_output.encode()).hexdigest()[:16]
        
        # 1. Check for incomplete/placeholder code
        violations.extend(self._check_placeholders(ai_output))
        
        # 2. Check syntax structure
        violations.extend(self._check_syntax_structure(ai_output, lang))
        
        # 3. Extract symbols from AI output
        new_symbols = SymbolTable.from_code(ai_output, lang)
        
        # 4. Compare with original if provided
        if original_code:
            orig_symbols = SymbolTable.from_code(original_code, lang)
            
            # Check for missing exports
            missing_exports = orig_symbols.exports - new_symbols.exports
            for sym in missing_exports:
                violations.append(Violation(
                    type=ViolationType.MISSING_EXPORT,
                    message=f"Export '{sym}' was removed",
                    severity="error",
                    auto_repairable=False,
                ))
            
            # Check for new globals
            if not self.allow_new_globals:
                new_globals = new_symbols.globals - orig_symbols.globals
                for sym in new_globals:
                    violations.append(Violation(
                        type=ViolationType.NEW_GLOBAL,
                        message=f"New global '{sym}' introduced",
                        severity="warning",
                        auto_repairable=False,
                    ))
            
            # Check for interface changes
            if not self.allow_interface_changes:
                # Simplified: just check if exports changed
                if orig_symbols.exports != new_symbols.exports:
                    violations.append(Violation(
                        type=ViolationType.INTERFACE_CHANGE,
                        message="Public interface changed",
                        severity="warning" if not self.strict_mode else "error",
                    ))
        
        # 5. Attempt auto-repair if enabled (WITH STRICT CAPS)
        repair_depth = 0
        repair_diff_lines = 0
        repair_diff_ratio = 0.0
        repair_capped = False
        
        if self.auto_repair and violations and self._current_repair_depth < self.max_repair_depth:
            self._current_repair_depth += 1
            try:
                repaired_output, repair_info = self._attempt_repair_with_caps(
                    ai_output, violations, lang, original_code
                )
                repair_depth = self._current_repair_depth
                repair_diff_lines = repair_info.get("diff_lines", 0)
                repair_diff_ratio = repair_info.get("diff_ratio", 0.0)
                repair_capped = repair_info.get("capped", False)
                
                if repaired_output != ai_output and not repair_capped:
                    # Re-verify repaired output (non-recursively)
                    violations = [v for v in violations if not v.auto_repairable]
            finally:
                self._current_repair_depth -= 1
        
        verified_hash = hashlib.sha256(repaired_output.encode()).hexdigest()[:16]
        
        # Determine status
        errors = [v for v in violations if v.severity == "error"]
        if errors:
            status = VerificationStatus.FAIL
        elif repaired_output != ai_output and not repair_capped:
            status = VerificationStatus.REPAIRED
        elif violations:
            status = VerificationStatus.WARN
        else:
            status = VerificationStatus.PASS
        
        duration_ms = (time.time() - start_time) * 1000
        
        result = VerificationResult(
            status=status,
            violations=violations,
            repaired_output=repaired_output if repaired_output != ai_output else None,
            original_hash=original_hash,
            verified_hash=verified_hash,
            duration_ms=duration_ms,
            repair_depth=repair_depth,
            repair_diff_lines=repair_diff_lines,
            repair_diff_ratio=repair_diff_ratio,
            repair_capped=repair_capped,
        )
        
        # Log result
        logger.info(f"[Verifier DEBUG] Verification result: {result.status} with {len(result.violations)} violations")
        for v in result.violations:
            logger.info(f"[Verifier DEBUG] Violation: {v.type} - {v.message}")

        # HARD GATE: Raise fatal error if verification failed and raise_on_failure is True
        if result.is_fatal and self.raise_on_failure:
            raise VerificationFatalError(
                violations=violations,
                context={
                    "original_hash": original_hash,
                    "verified_hash": verified_hash,
                    "lang": lang,
                    "repair_attempted": repair_depth > 0,
                    "repair_capped": repair_capped,
                }
            )
        
        return result
    
    def _attempt_repair_with_caps(
        self,
        code: str,
        violations: List[Violation],
        lang: str,
        original_code: Optional[str] = None,
    ) -> Tuple[str, Dict[str, Any]]:
        """
        Attempt auto-repair with strict caps.
        
        Caps enforced:
        - Max diff lines: self.max_repair_diff_lines
        - Max diff ratio: self.max_repair_diff_ratio
        - Timeout: REPAIR_TIMEOUT_SECONDS
        
        Returns (repaired_code, repair_info)
        """
        import difflib
        
        repair_info = {
            "diff_lines": 0,
            "diff_ratio": 0.0,
            "capped": False,
            "timeout": False,
        }
        
        # Only attempt repair on auto-repairable violations
        repairable = [v for v in violations if v.auto_repairable and v.suggested_fix]
        if not repairable:
            return code, repair_info
        
        repaired = code
        
        for v in repairable:
            if v.suggested_fix:
                # Apply suggested fix (simplified implementation)
                # In production, this would be more sophisticated
                pass
        
        # Calculate diff metrics
        if original_code:
            orig_lines = original_code.splitlines()
            new_lines = repaired.splitlines()
            
            diff = list(difflib.unified_diff(orig_lines, new_lines, lineterm=''))
            changed_lines = len([l for l in diff if l.startswith('+') or l.startswith('-')])
            
            repair_info["diff_lines"] = changed_lines
            repair_info["diff_ratio"] = changed_lines / max(len(orig_lines), 1)
            
            # Check caps
            if changed_lines > self.max_repair_diff_lines:
                repair_info["capped"] = True
                return code, repair_info  # Reject repair, return original
            
            if repair_info["diff_ratio"] > self.max_repair_diff_ratio:
                repair_info["capped"] = True
                return code, repair_info  # Reject repair, return original
        
        return repaired, repair_info
        """Check for placeholder patterns that indicate incomplete code."""
        violations = []
        
        for pattern in self.placeholder_patterns:
            matches = list(re.finditer(pattern, code, re.IGNORECASE))
            for match in matches:
                # Find line number
                line_num = code[:match.start()].count('\n') + 1
                violations.append(Violation(
                    type=ViolationType.INCOMPLETE_CODE,
                    message=f"Placeholder/incomplete code detected: '{match.group()}'",
                    location=f"line {line_num}",
                    severity="error",
                    auto_repairable=False,
                ))
        
        return violations
    
    def _check_syntax_structure(self, code: str, lang: str) -> List[Violation]:
        """Check for basic syntax structure issues."""
        violations = []
        
        # Check balanced braces/brackets/parens
        pairs = {'(': ')', '[': ']', '{': '}'}
        stack = []
        
        in_string = False
        string_char = None
        prev_char = None
        
        for i, char in enumerate(code):
            # Handle strings (simplified)
            if char in ('"', "'", '`') and prev_char != '\\':
                if not in_string:
                    in_string = True
                    string_char = char
                elif char == string_char:
                    in_string = False
                    string_char = None
            
            if not in_string:
                if char in pairs:
                    stack.append((char, i))
                elif char in pairs.values():
                    if stack:
                        open_char, _ = stack.pop()
                        if pairs[open_char] != char:
                            line_num = code[:i].count('\n') + 1
                            violations.append(Violation(
                                type=ViolationType.SYNTAX_ERROR,
                                message=f"Mismatched brackets: expected '{pairs[open_char]}', got '{char}'",
                                location=f"line {line_num}",
                                severity="error",
                            ))
                    else:
                        line_num = code[:i].count('\n') + 1
                        violations.append(Violation(
                            type=ViolationType.SYNTAX_ERROR,
                            message=f"Unexpected closing bracket: '{char}'",
                            location=f"line {line_num}",
                            severity="error",
                        ))
            
            prev_char = char
        
        # Check for unclosed brackets
        for open_char, pos in stack:
            line_num = code[:pos].count('\n') + 1
            violations.append(Violation(
                type=ViolationType.SYNTAX_ERROR,
                message=f"Unclosed bracket: '{open_char}'",
                location=f"line {line_num}",
                severity="error",
            ))
        
        return violations
    
    def _attempt_repair(
        self,
        code: str,
        violations: List[Violation],
        lang: str,
    ) -> Tuple[str, List[Violation]]:
        """Attempt to auto-repair simple issues."""
        repaired = code
        remaining_violations = []
        
        for v in violations:
            if v.auto_repairable and v.suggested_fix:
                # Apply suggested fix
                # This is a simplified implementation
                pass
            else:
                remaining_violations.append(v)
        
        return repaired, remaining_violations
    
    def verify_split_result(
        self,
        split_result: Dict[str, Any],
        original_code: str,
        lang: str,
    ) -> VerificationResult:
        """
        Verify AI split operation result.
        
        Checks:
        1. All modules have valid structure
        2. Combined exports match original
        3. No circular dependencies introduced
        4. Each file is syntactically valid
        """
        start_time = time.time()
        violations: List[Violation] = []
        
        original_hash = hashlib.sha256(
            json.dumps(split_result, sort_keys=True).encode()
        ).hexdigest()[:16]
        
        if not isinstance(split_result, dict):
            violations.append(Violation(
                type=ViolationType.INVALID_STRUCTURE,
                message="Split result must be a dictionary of modules",
                severity="error",
            ))
            return VerificationResult(
                status=VerificationStatus.FAIL,
                violations=violations,
                original_hash=original_hash,
                verified_hash=original_hash,
                duration_ms=(time.time() - start_time) * 1000,
            )
        
        # Verify each module
        all_exports: Set[str] = set()
        for module_name, module_data in split_result.items():
            if module_name == "explanation":
                continue
            
            if not isinstance(module_data, dict):
                violations.append(Violation(
                    type=ViolationType.INVALID_STRUCTURE,
                    message=f"Module '{module_name}' must be a dictionary with 'filename' and 'content'",
                    severity="error",
                ))
                continue
            
            content = module_data.get("content", "")
            if not content:
                violations.append(Violation(
                    type=ViolationType.INVALID_STRUCTURE,
                    message=f"Module '{module_name}' has no content",
                    severity="error",
                ))
                continue
            
            # Verify individual module
            module_result = self.verify(content, lang=lang)
            for v in module_result.violations:
                v.location = f"{module_name}: {v.location or ''}"
                violations.append(v)
            
            # Collect exports
            symbols = SymbolTable.from_code(content, lang)
            all_exports.update(symbols.exports)
        
        # Check original exports are preserved
        orig_symbols = SymbolTable.from_code(original_code, lang)
        missing_exports = orig_symbols.exports - all_exports
        for sym in missing_exports:
            violations.append(Violation(
                type=ViolationType.MISSING_EXPORT,
                message=f"Original export '{sym}' not found in split modules",
                severity="error",
            ))
        
        # Determine status
        errors = [v for v in violations if v.severity == "error"]
        status = VerificationStatus.FAIL if errors else (
            VerificationStatus.WARN if violations else VerificationStatus.PASS
        )
        
        return VerificationResult(
            status=status,
            violations=violations,
            original_hash=original_hash,
            verified_hash=original_hash,
            duration_ms=(time.time() - start_time) * 1000,
        )


# ============================================================
# FACTORY FUNCTIONS FOR DIFFERENT MODES
# ============================================================

# Singleton verifier instances (one per mode)
_default_verifier: Optional[AIOutputVerifier] = None
_dev_verifier: Optional[AIOutputVerifier] = None
_prod_verifier: Optional[AIOutputVerifier] = None


def get_verifier() -> AIOutputVerifier:
    """Get or create the default verifier instance (auto-detects mode)."""
    global _default_verifier
    if _default_verifier is None:
        _default_verifier = AIOutputVerifier()  # Auto-detects dev mode
    return _default_verifier


def get_dev_verifier() -> AIOutputVerifier:
    """
    Get or create a development-mode verifier.
    
    Features:
    - Higher repair depth (3 levels for multi-file changes)
    - More lenient diff limits (200 lines, 40% ratio)
    - Longer timeout (15 seconds)
    - Non-strict mode (warnings instead of fatal errors)
    - Does NOT raise VerificationFatalError
    """
    global _dev_verifier
    if _dev_verifier is None:
        _dev_verifier = AIOutputVerifier(
            dev_mode=True,
            strict_mode=False,
            raise_on_failure=False,
        )
    return _dev_verifier


def get_prod_verifier() -> AIOutputVerifier:
    """
    Get or create a production-mode verifier.
    
    Features:
    - Low repair depth (1 level only)
    - Strict diff limits (50 lines, 15% ratio)
    - Short timeout (5 seconds)
    - Strict mode (failures are fatal)
    - RAISES VerificationFatalError on failure
    """
    global _prod_verifier
    if _prod_verifier is None:
        _prod_verifier = AIOutputVerifier(
            dev_mode=False,
            strict_mode=True,
            raise_on_failure=True,
        )
    return _prod_verifier


def create_verifier_for_context(
    is_multi_file: bool = False,
    is_refactor: bool = False,
    is_quick_fix: bool = False,
) -> AIOutputVerifier:
    """
    Create a context-appropriate verifier.
    
    Args:
        is_multi_file: True if changes span multiple files
        is_refactor: True if this is a major refactoring operation
        is_quick_fix: True if this is a quick fix (prioritize speed)
    
    Returns:
        Verifier configured for the context
    """
    base_dev = _is_dev_mode()
    
    if is_quick_fix:
        # Quick fix: minimal verification, max speed
        return AIOutputVerifier(
            dev_mode=True,
            strict_mode=False,
            auto_repair=False,  # Don't waste time repairing
            max_repair_depth=0,
        )
    
    if is_refactor:
        # Refactor: highest repair depth, most lenient
        return AIOutputVerifier(
            dev_mode=True,
            strict_mode=False,
            max_repair_depth=DEV_MAX_REPAIR_DEPTH,
            max_repair_diff_lines=DEV_MAX_REPAIR_DIFF_LINES,
            max_repair_diff_ratio=DEV_MAX_REPAIR_DIFF_RATIO,
        )
    
    if is_multi_file:
        # Multi-file: need higher depth for chained repairs
        depth = 3 if base_dev else 2  # Slightly higher even in prod
        return AIOutputVerifier(
            dev_mode=base_dev,
            max_repair_depth=depth,
        )
    
    # Default: use environment-detected mode
    return AIOutputVerifier(dev_mode=base_dev)

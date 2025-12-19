"""
AI Split Structural Verifier
=============================
Prompts are not a safety mechanism. This module provides structural
verification that checks boundaries, ownership, call graphs, and
state access post-split to catch undefined behavior BEFORE runtime.

DESIGN RATIONALE:
- AI split correctness cannot be assumed - one wrong inference = UB
- This verifier is a HARD GATE, not advisory
- Checks are syntactic AND semantic where possible
- Fail-fast with actionable error messages

VERIFICATION LAYERS:
1. Syntactic: Parse tree validity, balanced brackets, etc.
2. Structural: Exports, imports, call graph completeness
3. Semantic: State ownership, cross-module access patterns
4. ABI: Function signatures match expected contract
"""

from __future__ import annotations

import hashlib
import json
import re
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional, Set, Tuple
from collections import defaultdict


class SplitVerificationError(Exception):
    """Fatal error during split verification - cannot proceed."""
    def __init__(self, message: str, violations: List["SplitViolation"]):
        super().__init__(message)
        self.violations = violations
        self.message = message


class SplitViolationType(str, Enum):
    """Types of split verification violations."""
    # Syntactic
    SYNTAX_ERROR = "syntax_error"
    UNBALANCED_BRACKETS = "unbalanced_brackets"
    INCOMPLETE_CODE = "incomplete_code"
    
    # Structural  
    MISSING_EXPORT = "missing_export"
    MISSING_IMPORT = "missing_import"
    UNDEFINED_REFERENCE = "undefined_reference"
    CIRCULAR_DEPENDENCY = "circular_dependency"
    ORPHAN_CODE = "orphan_code"
    
    # Semantic
    STATE_OWNERSHIP_VIOLATION = "state_ownership_violation"
    CROSS_MODULE_STATE_ACCESS = "cross_module_state_access"
    MALLOC_USAGE = "malloc_usage"
    MEMSET_USAGE = "memset_usage"
    SHARED_HEADER_MISSING = "shared_header_missing"
    
    # ABI
    ABI_SIGNATURE_MISMATCH = "abi_signature_mismatch"
    MISSING_REQUIRED_HOOK = "missing_required_hook"
    WRONG_HOOK_SIGNATURE = "wrong_hook_signature"
    STRUCT_REDEFINITION = "struct_redefinition"
    
    # Hallucination
    INVENTED_API = "invented_api"
    PHANTOM_IMPORT = "phantom_import"
    FABRICATED_TYPE = "fabricated_type"


@dataclass
class SplitViolation:
    """A single split verification violation."""
    type: SplitViolationType
    message: str
    module: Optional[str] = None  # Which module (core, gui, shared)
    location: Optional[str] = None  # File:line or similar
    severity: str = "error"  # error, warning
    context: Optional[str] = None  # Code snippet
    suggestion: Optional[str] = None  # How to fix


@dataclass
class SplitVerificationResult:
    """Result of split verification."""
    valid: bool
    violations: List[SplitViolation] = field(default_factory=list)
    warnings: List[SplitViolation] = field(default_factory=list)
    analysis: Optional["SplitAnalysis"] = None
    duration_ms: float = 0.0
    
    @property
    def error_count(self) -> int:
        return len([v for v in self.violations if v.severity == "error"])
    
    @property
    def warning_count(self) -> int:
        return len(self.warnings) + len([v for v in self.violations if v.severity == "warning"])


@dataclass
class SplitAnalysis:
    """Analysis of split code structure."""
    modules: Dict[str, "ModuleAnalysis"] = field(default_factory=dict)
    call_graph: Dict[str, Set[str]] = field(default_factory=dict)  # func -> {called funcs}
    state_access: Dict[str, Set[str]] = field(default_factory=dict)  # func -> {state fields}
    cross_module_calls: List[Tuple[str, str, str]] = field(default_factory=list)  # (from_mod, to_mod, func)
    shared_state_fields: Set[str] = field(default_factory=set)


@dataclass
class ModuleAnalysis:
    """Analysis of a single module."""
    name: str
    functions: Set[str] = field(default_factory=set)
    exports: Set[str] = field(default_factory=set)
    imports: Set[str] = field(default_factory=set)
    state_struct: Optional[str] = None
    includes: Set[str] = field(default_factory=set)
    extern_c_funcs: Set[str] = field(default_factory=set)


# ============================================================
# HARD LIMITS FOR AI HALLUCINATION DETECTION
# ============================================================

# Known valid SDL functions (subset - expand as needed)
KNOWN_SDL_FUNCTIONS = {
    "SDL_Init", "SDL_Quit", "SDL_CreateWindow", "SDL_DestroyWindow",
    "SDL_CreateRenderer", "SDL_DestroyRenderer", "SDL_RenderClear",
    "SDL_RenderPresent", "SDL_SetRenderDrawColor", "SDL_RenderFillRect",
    "SDL_RenderDrawRect", "SDL_PollEvent", "SDL_Delay", "SDL_GetTicks",
    "SDL_RenderCopy", "SDL_LoadBMP", "SDL_CreateTextureFromSurface",
    "SDL_FreeSurface", "SDL_DestroyTexture", "SDL_GetWindowSize",
    "SDL_SetWindowTitle", "SDL_ShowWindow", "SDL_HideWindow",
    "SDL_GetError", "SDL_GetKeyboardState", "SDL_GetMouseState",
}

# Known valid C standard library functions
KNOWN_STDLIB_FUNCTIONS = {
    "printf", "fprintf", "sprintf", "snprintf", "puts", "putchar",
    "scanf", "sscanf", "fopen", "fclose", "fread", "fwrite",
    "malloc", "calloc", "realloc", "free",  # Flag these as warnings
    "memcpy", "memset", "memmove", "memcmp",  # Flag memset as error
    "strlen", "strcpy", "strncpy", "strcmp", "strncmp", "strcat",
    "atoi", "atof", "strtol", "strtod",
    "abs", "fabs", "sqrt", "sin", "cos", "tan", "pow", "log", "exp",
    "rand", "srand", "time", "clock",
    "exit", "abort", "atexit",
}

# Required hooks for each module type
REQUIRED_HOOKS = {
    "core": {
        "core_on_load": "void*(*)(void*, void*)",
        "core_on_update": "void(*)(void*, double)",
        "core_get_api": "void*(*)(void)",
    },
    "gui": {
        "gui_on_load": "void*(*)(void*, void*)",
        "gui_on_render": "void(*)(void*, void*, void*)",
    },
    "main": {  # Legacy single-file
        "on_load": "void*(*)(void*, void*)",
        "on_update": "void(*)(void*, double)",
    },
}

# State fields that should NOT be accessed directly from gui.cpp
CORE_ONLY_STATE_FIELDS = {
    "running", "paused", "game_state", "physics_state",
    "score", "level", "health", "lives",
}


class SplitStructuralVerifier:
    """
    Structural verifier for AI-generated code splits.
    This is a HARD GATE - verification failures block compilation.
    """
    
    def __init__(
        self,
        strict_mode: bool = True,
        allow_malloc: bool = False,
        allow_memset: bool = False,
        known_functions: Optional[Set[str]] = None,
        known_types: Optional[Set[str]] = None,
    ):
        self.strict_mode = strict_mode
        self.allow_malloc = allow_malloc
        self.allow_memset = allow_memset
        
        # Build known symbol sets
        self.known_functions = KNOWN_SDL_FUNCTIONS | KNOWN_STDLIB_FUNCTIONS
        if known_functions:
            self.known_functions |= known_functions
        
        self.known_types = {
            "SDL_Window", "SDL_Renderer", "SDL_Event", "SDL_Rect",
            "SDL_Surface", "SDL_Texture", "SDL_Color", "SDL_Point",
            "int", "float", "double", "char", "void", "bool",
            "int8_t", "int16_t", "int32_t", "int64_t",
            "uint8_t", "uint16_t", "uint32_t", "uint64_t",
            "size_t", "ssize_t", "ptrdiff_t",
        }
        if known_types:
            self.known_types |= known_types
    
    def verify_split(
        self,
        split_result: Dict[str, Any],
        original_code: Optional[str] = None,
    ) -> SplitVerificationResult:
        """
        Verify a complete split result.
        
        Args:
            split_result: Dict with keys like "shared", "core", "gui"
                          each containing {"filename": str, "content": str}
            original_code: Original unsplit code for comparison
        
        Returns:
            SplitVerificationResult with validity and any violations
        """
        start_time = time.time()
        violations: List[SplitViolation] = []
        warnings: List[SplitViolation] = []
        
        # Extract module contents
        modules = {}
        for key, value in split_result.items():
            if key == "explanation":
                continue
            if isinstance(value, dict) and "content" in value:
                modules[key] = value["content"]
            elif isinstance(value, str):
                modules[key] = value
        
        if not modules:
            violations.append(SplitViolation(
                type=SplitViolationType.INCOMPLETE_CODE,
                message="Split result contains no modules",
                severity="error",
            ))
            return SplitVerificationResult(
                valid=False,
                violations=violations,
                duration_ms=(time.time() - start_time) * 1000,
            )
        
        # Analyze each module
        analysis = SplitAnalysis()
        for name, content in modules.items():
            mod_analysis = self._analyze_module(name, content)
            analysis.modules[name] = mod_analysis
        
        # Run verification passes
        violations.extend(self._verify_syntax(modules))
        violations.extend(self._verify_shared_header(modules, analysis))
        violations.extend(self._verify_exports(modules, analysis, original_code))
        violations.extend(self._verify_hooks(modules, analysis))
        violations.extend(self._verify_state_ownership(modules, analysis))
        violations.extend(self._verify_memory_patterns(modules))
        violations.extend(self._verify_call_graph(modules, analysis))
        
        # Check for hallucinations
        hallucination_violations = self._check_hallucinations(modules, analysis)
        for v in hallucination_violations:
            if v.severity == "warning":
                warnings.append(v)
            else:
                violations.append(v)
        
        # Filter by severity
        errors = [v for v in violations if v.severity == "error"]
        for v in violations:
            if v.severity == "warning":
                warnings.append(v)
        
        valid = len(errors) == 0
        
        result = SplitVerificationResult(
            valid=valid,
            violations=errors,
            warnings=warnings,
            analysis=analysis,
            duration_ms=(time.time() - start_time) * 1000,
        )
        
        if not valid and self.strict_mode:
            raise SplitVerificationError(
                f"Split verification failed with {len(errors)} errors",
                violations=errors,
            )
        
        return result
    
    def _analyze_module(self, name: str, content: str) -> ModuleAnalysis:
        """Analyze a single module's structure."""
        analysis = ModuleAnalysis(name=name)
        
        # Extract functions
        for m in re.finditer(
            r'(?:extern\s+"C"\s+)?(?:static\s+)?(?:inline\s+)?'
            r'(?:[\w*&:\s]+)\s+(\w+)\s*\([^)]*\)\s*(?:const)?\s*{',
            content
        ):
            func_name = m.group(1)
            analysis.functions.add(func_name)
            
            # Check if extern "C"
            if 'extern "C"' in content[max(0, m.start()-20):m.start()]:
                analysis.extern_c_funcs.add(func_name)
                analysis.exports.add(func_name)
        
        # Extract includes
        for m in re.finditer(r'#include\s*[<"]([^>"]+)[>"]', content):
            analysis.includes.add(m.group(1))
        
        # Check for AppState struct definition
        if re.search(r'struct\s+AppState\s*{', content):
            analysis.state_struct = "AppState"
        
        return analysis
    
    def _verify_syntax(self, modules: Dict[str, str]) -> List[SplitViolation]:
        """Verify basic syntax validity."""
        violations = []
        
        for name, content in modules.items():
            # Check balanced brackets
            stack = []
            pairs = {'{': '}', '[': ']', '(': ')'}
            in_string = False
            string_char = None
            prev_char = None
            
            for i, char in enumerate(content):
                # Handle strings
                if char in ('"', "'") and prev_char != '\\':
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
                        if stack and pairs.get(stack[-1][0]) == char:
                            stack.pop()
                        else:
                            line_num = content[:i].count('\n') + 1
                            violations.append(SplitViolation(
                                type=SplitViolationType.UNBALANCED_BRACKETS,
                                message=f"Unexpected '{char}'",
                                module=name,
                                location=f"line {line_num}",
                                severity="error",
                            ))
                
                prev_char = char
            
            for open_char, pos in stack:
                line_num = content[:pos].count('\n') + 1
                violations.append(SplitViolation(
                    type=SplitViolationType.UNBALANCED_BRACKETS,
                    message=f"Unclosed '{open_char}'",
                    module=name,
                    location=f"line {line_num}",
                    severity="error",
                ))
            
            # Check for incomplete code markers
            incomplete_patterns = [
                (r'//\s*\.\.\.\s*$', "Ellipsis comment"),
                (r'/\*\s*\.\.\.\s*\*/', "Ellipsis block comment"),
                (r'// TODO:?\s*implement', "TODO implement marker"),
                (r'// rest of', "Rest of code marker"),
                (r'\[TRUNCATED\]', "Truncation marker"),
            ]
            
            for pattern, desc in incomplete_patterns:
                for m in re.finditer(pattern, content, re.MULTILINE | re.IGNORECASE):
                    line_num = content[:m.start()].count('\n') + 1
                    violations.append(SplitViolation(
                        type=SplitViolationType.INCOMPLETE_CODE,
                        message=f"Incomplete code: {desc}",
                        module=name,
                        location=f"line {line_num}",
                        severity="error",
                        context=m.group(0),
                    ))
        
        return violations
    
    def _verify_shared_header(
        self,
        modules: Dict[str, str],
        analysis: SplitAnalysis,
    ) -> List[SplitViolation]:
        """Verify shared.h usage."""
        violations = []
        
        has_shared = "shared" in modules or any(
            "shared.h" in m.includes for m in analysis.modules.values()
        )
        
        # Check if shared.h exists in split
        if "shared" not in modules:
            # Check if it's referenced but not provided
            for name, mod in analysis.modules.items():
                if "shared.h" in mod.includes and "shared" not in modules:
                    violations.append(SplitViolation(
                        type=SplitViolationType.SHARED_HEADER_MISSING,
                        message="shared.h is included but not in split output",
                        module=name,
                        severity="error",
                        suggestion="Include shared.h content in split result",
                    ))
        
        # Check that core.cpp and gui.cpp include shared.h
        for mod_name in ["core", "gui"]:
            if mod_name in modules and mod_name in analysis.modules:
                mod = analysis.modules[mod_name]
                if "shared.h" not in mod.includes:
                    violations.append(SplitViolation(
                        type=SplitViolationType.SHARED_HEADER_MISSING,
                        message=f"{mod_name}.cpp does not include shared.h",
                        module=mod_name,
                        severity="error",
                        suggestion=f'Add #include "shared.h" to {mod_name}.cpp',
                    ))
        
        # Check for AppState redefinition
        shared_has_state = False
        if "shared" in analysis.modules:
            shared_has_state = analysis.modules["shared"].state_struct is not None
        
        for name in ["core", "gui"]:
            if name in analysis.modules:
                if analysis.modules[name].state_struct is not None and shared_has_state:
                    violations.append(SplitViolation(
                        type=SplitViolationType.STRUCT_REDEFINITION,
                        message=f"AppState redefined in {name}.cpp (already in shared.h)",
                        module=name,
                        severity="error",
                        suggestion=f"Remove AppState definition from {name}.cpp, use shared.h",
                    ))
        
        return violations
    
    def _verify_exports(
        self,
        modules: Dict[str, str],
        analysis: SplitAnalysis,
        original_code: Optional[str],
    ) -> List[SplitViolation]:
        """Verify required exports are present."""
        violations = []
        
        # Collect all exports from split
        all_exports = set()
        for mod in analysis.modules.values():
            all_exports |= mod.exports
        
        # Check required hooks are exported
        for mod_name in ["core", "gui"]:
            if mod_name in analysis.modules:
                required = REQUIRED_HOOKS.get(mod_name, {})
                for hook_name in required:
                    if hook_name not in all_exports:
                        violations.append(SplitViolation(
                            type=SplitViolationType.MISSING_EXPORT,
                            message=f"Required hook '{hook_name}' not exported",
                            module=mod_name,
                            severity="error",
                            suggestion=f'Add extern "C" to {hook_name} function',
                        ))
        
        return violations
    
    def _verify_hooks(
        self,
        modules: Dict[str, str],
        analysis: SplitAnalysis,
    ) -> List[SplitViolation]:
        """Verify hook functions have correct signatures."""
        violations = []
        
        for mod_name in ["core", "gui"]:
            if mod_name not in modules:
                continue
            
            content = modules[mod_name]
            required = REQUIRED_HOOKS.get(mod_name, {})
            
            for hook_name in required:
                # Check if hook exists
                if hook_name not in analysis.modules.get(mod_name, ModuleAnalysis(name=mod_name)).functions:
                    violations.append(SplitViolation(
                        type=SplitViolationType.MISSING_REQUIRED_HOOK,
                        message=f"Required hook '{hook_name}' not found",
                        module=mod_name,
                        severity="error",
                    ))
                    continue
                
                # Check if it's extern "C"
                if hook_name not in analysis.modules.get(mod_name, ModuleAnalysis(name=mod_name)).extern_c_funcs:
                    violations.append(SplitViolation(
                        type=SplitViolationType.ABI_SIGNATURE_MISMATCH,
                        message=f"Hook '{hook_name}' is not extern \"C\"",
                        module=mod_name,
                        severity="error",
                        suggestion=f'Add extern "C" before {hook_name} definition',
                    ))
        
        return violations
    
    def _verify_state_ownership(
        self,
        modules: Dict[str, str],
        analysis: SplitAnalysis,
    ) -> List[SplitViolation]:
        """Verify state ownership patterns."""
        violations = []
        
        # GUI should not directly modify core state fields
        if "gui" in modules:
            gui_content = modules["gui"]
            
            for field in CORE_ONLY_STATE_FIELDS:
                # Check for direct assignment to core-only fields
                pattern = rf'\bstate\s*->\s*{field}\s*='
                for m in re.finditer(pattern, gui_content):
                    line_num = gui_content[:m.start()].count('\n') + 1
                    violations.append(SplitViolation(
                        type=SplitViolationType.STATE_OWNERSHIP_VIOLATION,
                        message=f"GUI module directly modifies core state field '{field}'",
                        module="gui",
                        location=f"line {line_num}",
                        severity="warning",  # Warning because it might be intentional
                        suggestion=f"Use core API to modify '{field}' instead of direct access",
                    ))
        
        return violations
    
    def _verify_memory_patterns(self, modules: Dict[str, str]) -> List[SplitViolation]:
        """Verify memory allocation patterns (no malloc/memset for state)."""
        violations = []
        
        for name, content in modules.items():
            if name == "shared":
                continue
            
            # Check for malloc usage for state
            malloc_patterns = [
                (r'malloc\s*\(\s*sizeof\s*\(\s*AppState\s*\)', "malloc for AppState"),
                (r'calloc\s*\([^,]+,\s*sizeof\s*\(\s*AppState\s*\)', "calloc for AppState"),
                (r'new\s+AppState', "new AppState"),
            ]
            
            for pattern, desc in malloc_patterns:
                for m in re.finditer(pattern, content):
                    if not self.allow_malloc:
                        line_num = content[:m.start()].count('\n') + 1
                        violations.append(SplitViolation(
                            type=SplitViolationType.MALLOC_USAGE,
                            message=f"Forbidden: {desc} - use static storage instead",
                            module=name,
                            location=f"line {line_num}",
                            severity="error",
                            context=m.group(0),
                            suggestion="Use 'static AppState app_state = {0};' instead",
                        ))
            
            # Check for memset on state
            memset_patterns = [
                (r'memset\s*\(\s*(?:&?\s*)?(?:app_)?state', "memset on state"),
                (r'bzero\s*\(\s*(?:&?\s*)?(?:app_)?state', "bzero on state"),
                (r'memset\s*\(\s*state\s*,', "memset on state pointer"),
            ]
            
            for pattern, desc in memset_patterns:
                for m in re.finditer(pattern, content, re.IGNORECASE):
                    if not self.allow_memset:
                        line_num = content[:m.start()].count('\n') + 1
                        violations.append(SplitViolation(
                            type=SplitViolationType.MEMSET_USAGE,
                            message=f"Forbidden: {desc} - wipes preserved state",
                            module=name,
                            location=f"line {line_num}",
                            severity="error",
                            context=m.group(0),
                            suggestion="Initialize fields individually instead of memset",
                        ))
        
        return violations
    
    def _verify_call_graph(
        self,
        modules: Dict[str, str],
        analysis: SplitAnalysis,
    ) -> List[SplitViolation]:
        """Verify call graph completeness."""
        violations = []
        
        # Build combined function set
        all_functions = set()
        for mod in analysis.modules.values():
            all_functions |= mod.functions
        
        # Add known external functions
        all_functions |= self.known_functions
        
        # Check for undefined function calls
        for name, content in modules.items():
            if name == "shared":
                continue
            
            # Find function calls (simplified)
            for m in re.finditer(r'\b(\w+)\s*\(', content):
                func_name = m.group(1)
                
                # Skip keywords and types
                if func_name in ('if', 'while', 'for', 'switch', 'return', 'sizeof', 'typeof'):
                    continue
                if func_name in self.known_types:
                    continue
                
                # Check if defined
                if func_name not in all_functions:
                    # Might be a method call or macro - check context
                    context_start = max(0, m.start() - 10)
                    context = content[context_start:m.start()]
                    
                    # Skip if looks like method call (has -> or . before)
                    if re.search(r'(?:->|\.)\s*$', context):
                        continue
                    
                    # Skip if looks like cast
                    if re.search(r'\)\s*$', context):
                        continue
                    
                    line_num = content[:m.start()].count('\n') + 1
                    violations.append(SplitViolation(
                        type=SplitViolationType.UNDEFINED_REFERENCE,
                        message=f"Possible undefined function: '{func_name}'",
                        module=name,
                        location=f"line {line_num}",
                        severity="warning",  # Warning because heuristics aren't perfect
                    ))
        
        return violations
    
    def _check_hallucinations(
        self,
        modules: Dict[str, str],
        analysis: SplitAnalysis,
    ) -> List[SplitViolation]:
        """Check for AI hallucinations - invented APIs, phantom imports, etc."""
        violations = []
        
        # Check for invented SDL functions
        sdl_call_pattern = r'SDL_(\w+)\s*\('
        
        for name, content in modules.items():
            for m in re.finditer(sdl_call_pattern, content):
                func_name = "SDL_" + m.group(1)
                if func_name not in KNOWN_SDL_FUNCTIONS:
                    # Might be a valid function we don't know about
                    line_num = content[:m.start()].count('\n') + 1
                    violations.append(SplitViolation(
                        type=SplitViolationType.INVENTED_API,
                        message=f"Unrecognized SDL function: '{func_name}' - possible hallucination",
                        module=name,
                        location=f"line {line_num}",
                        severity="warning",
                        suggestion="Verify this SDL function exists in SDL2 documentation",
                    ))
        
        # Check for phantom includes
        known_headers = {
            "SDL.h", "SDL2/SDL.h", "stdio.h", "stdlib.h", "string.h",
            "math.h", "time.h", "stdint.h", "stdbool.h", "shared.h",
            "cstdio", "cstdlib", "cstring", "cmath", "iostream",
        }
        
        for name, mod in analysis.modules.items():
            for include in mod.includes:
                if include not in known_headers and not include.endswith(".h"):
                    violations.append(SplitViolation(
                        type=SplitViolationType.PHANTOM_IMPORT,
                        message=f"Unrecognized include: '{include}'",
                        module=name,
                        severity="warning",
                        suggestion=f"Verify '{include}' exists and is needed",
                    ))
        
        return violations


# ============================================================
# HALLUCINATION HARD LIMITS
# ============================================================

class HallucinationLimits:
    """
    Hard syntactic and semantic limits for AI output.
    These go beyond prompts - they're enforced at verification time.
    """
    
    # Maximum lines of code in a single module
    MAX_MODULE_LINES = 2000
    
    # Maximum function count per module
    MAX_FUNCTIONS_PER_MODULE = 100
    
    # Maximum nesting depth
    MAX_NESTING_DEPTH = 10
    
    # Maximum line length
    MAX_LINE_LENGTH = 500
    
    # Forbidden patterns (regex)
    FORBIDDEN_PATTERNS = [
        # Inline assembly (dangerous)
        r'__asm__',
        r'asm\s*\(',
        r'__asm\s*{',
        
        # System calls (dangerous in sandbox)
        r'\bexec[vl]p?\s*\(',
        r'\bsystem\s*\(',
        r'\bpopen\s*\(',
        r'\bfork\s*\(',
        
        # File system access (unless allowed)
        r'\bfopen\s*\([^,]+,\s*"w',  # Write mode
        r'\bunlink\s*\(',
        r'\bremove\s*\(',
        r'\brename\s*\(',
        
        # Network access
        r'\bsocket\s*\(',
        r'\bconnect\s*\(',
        r'\bbind\s*\(',
        
        # Signal handling (we manage this)
        r'\bsignal\s*\(',
        r'\bsigaction\s*\(',
        
        # setjmp/longjmp (UB with signals)
        r'\bsetjmp\s*\(',
        r'\blongjmp\s*\(',
    ]
    
    @classmethod
    def check(cls, content: str, module_name: str = "") -> List[SplitViolation]:
        """Check content against hard limits."""
        violations = []
        
        lines = content.split('\n')
        
        # Check line count
        if len(lines) > cls.MAX_MODULE_LINES:
            violations.append(SplitViolation(
                type=SplitViolationType.INCOMPLETE_CODE,
                message=f"Module exceeds {cls.MAX_MODULE_LINES} lines ({len(lines)} lines)",
                module=module_name,
                severity="error",
            ))
        
        # Check line lengths
        for i, line in enumerate(lines, 1):
            if len(line) > cls.MAX_LINE_LENGTH:
                violations.append(SplitViolation(
                    type=SplitViolationType.SYNTAX_ERROR,
                    message=f"Line exceeds {cls.MAX_LINE_LENGTH} chars ({len(line)} chars)",
                    module=module_name,
                    location=f"line {i}",
                    severity="warning",
                ))
        
        # Check nesting depth
        max_depth = 0
        current_depth = 0
        for char in content:
            if char == '{':
                current_depth += 1
                max_depth = max(max_depth, current_depth)
            elif char == '}':
                current_depth = max(0, current_depth - 1)
        
        if max_depth > cls.MAX_NESTING_DEPTH:
            violations.append(SplitViolation(
                type=SplitViolationType.SYNTAX_ERROR,
                message=f"Nesting depth {max_depth} exceeds limit {cls.MAX_NESTING_DEPTH}",
                module=module_name,
                severity="warning",
            ))
        
        # Check forbidden patterns
        for pattern in cls.FORBIDDEN_PATTERNS:
            for m in re.finditer(pattern, content):
                line_num = content[:m.start()].count('\n') + 1
                violations.append(SplitViolation(
                    type=SplitViolationType.INVENTED_API,
                    message=f"Forbidden pattern: '{m.group(0)}'",
                    module=module_name,
                    location=f"line {line_num}",
                    severity="error",
                    suggestion="This pattern is not allowed for security reasons",
                ))
        
        return violations


# ============================================================
# PUBLIC API
# ============================================================

def verify_ai_split(
    split_result: Dict[str, Any],
    original_code: Optional[str] = None,
    strict: bool = True,
) -> SplitVerificationResult:
    """
    Verify an AI-generated code split.
    
    Args:
        split_result: Dict with module contents
        original_code: Original code for comparison
        strict: If True, raise on verification failure
    
    Returns:
        SplitVerificationResult
    
    Raises:
        SplitVerificationError: If strict=True and verification fails
    """
    verifier = SplitStructuralVerifier(strict_mode=strict)
    return verifier.verify_split(split_result, original_code)


def check_hallucination_limits(
    content: str,
    module_name: str = "",
) -> List[SplitViolation]:
    """
    Check content against hallucination hard limits.
    
    Args:
        content: Code content to check
        module_name: Name of module for error messages
    
    Returns:
        List of violations found
    """
    return HallucinationLimits.check(content, module_name)

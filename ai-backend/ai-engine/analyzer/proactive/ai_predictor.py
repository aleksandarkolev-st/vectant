"""
AI-Powered Error Predictor

This module uses LLM to detect subtle bugs and potential issues
that static and semantic analysis might miss, including:
- Logic errors
- Race conditions
- Security vulnerabilities
- API misuse
- Algorithm bugs
- Edge cases
- Cross-file issues (imports, type mismatches, etc.)

The AI analyzer runs after static and semantic analysis complete,
providing deeper insights with explanations.

NEW: Multi-file analysis mode that:
- Analyzes relationships between files
- Detects cross-file issues (missing exports, type mismatches)
- Generates multi-file suggestions
"""

from __future__ import annotations

import json
import re
import time
import traceback
from typing import Any, Dict, List, Optional

from .types import (
    AnalysisTier,
    CodeFix,
    CrossFileReference,
    Diagnostic,
    DiagnosticCategory,
    DiagnosticLocation,
    FileContext,
    FileEdit,
    MultiFileDiagnostic,
    MultiFileFix,
    Severity,
    TierResult,
    WorkspaceSuggestion,
)


# Prompt template for AI error prediction - ARCHITECTURAL + BUG-FOCUSED
AI_ERROR_PREDICTION_PROMPT = """You are a senior software architect reviewing code for REAL bugs and design issues.

## YOUR MINDSET
Think like an architect AND a debugger:
- Be EAGLE-EYED for small typos that break logic (e.g. `;` after `if`)
- Find the ROOT CAUSE of issues, not just symptoms
- Suggest fixes that improve DESIGN, not just patch behavior
- Consider how this code fits into a larger system

## YOUR TASK
Find bugs and design issues. Only report:
1. Bugs that cause WRONG OUTPUT or RUNTIME ERROR (with proof)
2. Design flaws that will cause problems as code grows

{include_context}

## WHAT TO LOOK FOR

### Bugs (HIGH CONFIDENCE - prove with examples):
- **Subtle Logic Traps**:
  - Accidental semicolons after control structures: `if (...);`, `while (...);`, `for (...);`
  - Assignment `=` used instead of comparison `==` in conditions: `if (x = 1)` (VERIFY it is not `==` before reporting)
  - Wrong operators: `<` vs `<=`, `==` vs `!=`, `&&` vs `||`
- **Loop & Index Errors**:
  - Off-by-one errors: `for (i=0; i<=size; i++)` (accesses out of bounds)
  - Infinite loops: `while(x > 0)` where x never changes
- **Memory Management (C/C++)**:
  - Use after free (accessing pointer after delete)
  - Double free (deleting same pointer twice)
  - Memory leaks (new without delete)
  - Returning pointers to local stack variables (Dangling pointers)
  - Array out of bounds access
- **Data Flow**:
  - Uninitialized variables used in logic
  - Missing edge cases: null, 0, negative, empty, boundary values
  - Incorrect return values or missing returns

### Design Issues (MEDIUM CONFIDENCE):
- Functions doing too many things (suggest splitting)
- Missing abstractions that would simplify code
- Error handling that swallows problems
- Tight coupling that will cause issues later

## WHAT TO IGNORE
- Style, formatting, naming (unless they hide bugs)
- Performance (unless causes timeout/OOM)
- Best practices that don't affect correctness
- Edge cases that ARE already handled
- **IMPORTANT: Do NOT report missing includes/imports if the symbol is listed as AVAILABLE in the include context above**

## CRITICAL RULES
1. READ THE ACTUAL CODE CHARACTER-BY-CHARACTER - don't assume what it does based on indentation
2. Scrutinize every `if`, `while`, `for` for accidental semicolons or assignment operators
3. Do NOT report 'Assignment in condition' if the operator is `==` (double equals)
4. If a check exists (like `if (x < 0)`), don't report it as missing
5. Only report bugs you can PROVE with input → expected → actual
6. For design issues, explain WHY the current design is problematic
7. **Do NOT suggest adding #include when the symbol is already available via transitive includes**

## RESPONSE FORMAT
Return ONLY a JSON array:
```json
[
  {{
    "line_start": 5,
    "line_end": 5,
    "snippet": "exact code from source to highlight",
    "message": "Brief description",
    "explanation": "PROOF: input X → expected Y → actual Z  OR  DESIGN: Why this pattern causes problems",
    "severity": "error",
    "confidence": 0.9,
    "fix_snippet": "improved code (design fix, not just patch)",
    "category": "logic_error|design_issue"
  }}
]
```

## FIELD RULES
- `snippet`: Copy EXACT code from source
- `fix_snippet`: Improved code. Prefer DESIGN fixes over quick patches.
- `confidence`: 0.9+ for provable bugs, 0.7-0.85 for design issues
- `category`: logic_error | off_by_one | wrong_operator | design_issue | missing_check
- `severity`: "error" for bugs, "warning" for design issues

If no issues found or uncertain, return: `[]`

## CODE TO REVIEW
```{language}
{code}
```

JSON:"""


# ============================================================================
# Multi-File Analysis Prompt - Workspace-Wide, Architecture-Focused
# ============================================================================

AI_MULTI_FILE_ANALYSIS_PROMPT = """You are a senior software architect and code reviewer analyzing an entire workspace.

## YOUR MINDSET
Think like an architect, not a quick-fixer. When you find issues:
1. Consider the ROOT CAUSE, not just symptoms
2. Suggest fixes that improve DESIGN, not just patch behavior
3. Look at how files interact and depend on each other
4. Identify patterns that could cause bugs across the codebase

## YOUR TASK
Analyze ALL provided files for:
1. **Cross-file integration bugs**: Wrong function signatures, incorrect imports, type mismatches
2. **Architecture issues**: Circular dependencies, tight coupling, missing abstractions
3. **Logic errors**: Bugs that will cause incorrect behavior
4. **Design improvements**: Better ways to structure the code

{include_context}

## FILES IN WORKSPACE
{files_section}

## FOCUS FILE: {focus_file}
(Primary file user is editing - prioritize issues here, but analyze all files)

## WHAT TO ANALYZE

### Cross-File Issues (HIGH PRIORITY):
- Function called with wrong arguments (check definitions in other files)
- Import statements for things that don't exist
- Type mismatches between expected and actual values across files
- Missing exports that other files try to import
- Header file changes that break source files (C/C++)
- **BUT: Do NOT report missing includes if the symbol is available via transitive includes (check AVAILABLE SYMBOLS above)**

### Architecture Issues:
- Circular dependencies between modules
- Functions doing too much (suggest splitting)
- Duplicated logic that should be shared
- Missing error handling patterns
- Inconsistent API designs

### Single-File Bugs:
- Logic errors provable with concrete examples
- Off-by-one errors, wrong operators
- Missing edge cases, null checks
- Unreachable code

## RESPONSE FORMAT
Return a JSON object with diagnostics for ANY file in the workspace:
```json
{{
  "diagnostics": [
    {{
      "file": "path/to/file.ext",
      "line_start": 5,
      "line_end": 5,
      "snippet": "exact code from source",
      "message": "Brief description (include file name if cross-file issue)",
      "explanation": "ARCHITECTURE: Why this design is problematic OR PROOF: input X → expected Y → actual Z",
      "severity": "error|warning",
      "confidence": 0.9,
      "fix_snippet": "improved code that fixes the ROOT CAUSE",
      "category": "logic_error|design_issue|cross_file|type_error",
      "related_files": [
        {{"file": "other/file.ext", "line": 10, "message": "Related definition/usage here"}}
      ]
    }}
  ],
  "suggestions": [
    {{
      "title": "Architectural improvement",
      "description": "Detailed explanation of how to improve the design, not just fix a symptom",
      "category": "refactor|architecture|cleanup",
      "affected_files": ["file1.ext", "file2.ext"],
      "confidence": 0.85
    }}
  ]
}}
```

## CATEGORIES
- `logic_error`: Provable bug with wrong output
- `cross_file`: Issue spanning multiple files
- `type_error`: Type mismatch (especially across files)
- `design_issue`: Architectural problem
- `missing_import`: Symbol used but not imported (ONLY if symbol is NOT in available symbols list)
- `wrong_signature`: Function called incorrectly

## CRITICAL RULES
1. **Analyze ALL files**, not just the focus file - bugs often hide in interactions
2. For cross-file issues, ALWAYS check the actual definitions in other files
3. **IMPORTANT: Do NOT suggest adding includes/imports for symbols that are already AVAILABLE via transitive includes**
4. Don't suggest adding code that already exists
5. When suggesting fixes, prefer DESIGN improvements over quick patches
6. Include `related_files` for any cross-file issue to help navigation

If no issues found, return: {{"diagnostics": [], "suggestions": []}}

JSON:"""


# ============================================================================
# Category and Severity Mappings
# ============================================================================

CATEGORY_MAP = {
    "logic_error": DiagnosticCategory.LOGIC_ERROR,
    "security": DiagnosticCategory.SECURITY,
    "concurrency": DiagnosticCategory.CONCURRENCY,
    "resource_leak": DiagnosticCategory.RESOURCE_LEAK,
    "type_error": DiagnosticCategory.TYPE_ERROR,
    "performance": DiagnosticCategory.PERFORMANCE,
    "best_practice": DiagnosticCategory.BEST_PRACTICE,
    "null_reference": DiagnosticCategory.NULL_REFERENCE,
    "undefined_variable": DiagnosticCategory.UNDEFINED_VARIABLE,
    "unused_code": DiagnosticCategory.UNUSED_CODE,
    "style": DiagnosticCategory.STYLE,
    "syntax": DiagnosticCategory.SYNTAX,
    "cross_file": DiagnosticCategory.TYPE_ERROR,  # Cross-file issues often manifest as type errors
    "design_issue": DiagnosticCategory.BEST_PRACTICE,
    "architecture": DiagnosticCategory.BEST_PRACTICE,
    # Additional categories for precise diagnostics
    "off_by_one": DiagnosticCategory.LOGIC_ERROR,
    "wrong_operator": DiagnosticCategory.LOGIC_ERROR,
    "wrong_condition": DiagnosticCategory.LOGIC_ERROR,
    "boundary_error": DiagnosticCategory.LOGIC_ERROR,
    "missing_check": DiagnosticCategory.LOGIC_ERROR,
    # Cross-file categories
    "missing_import": DiagnosticCategory.UNDEFINED_VARIABLE,
    "wrong_signature": DiagnosticCategory.TYPE_ERROR,
    "unused_export": DiagnosticCategory.UNUSED_CODE,
}

SEVERITY_MAP = {
    "error": Severity.ERROR,
    "warning": Severity.WARNING,
    "info": Severity.INFO,
    "hint": Severity.HINT,
}


class AIErrorPredictor:
    """
    Uses LLM to predict potential errors in code.
    
    This analyzer provides deeper insights than static analysis,
    including logic errors, security issues, and best practice violations.
    """
    
    def __init__(
        self,
        provider=None,
        min_confidence: float = 0.6,
        max_diagnostics: int = 20,
        timeout: float = 30.0,
    ):
        self._provider = provider
        self._min_confidence = min_confidence
        self._max_diagnostics = max_diagnostics
        self._timeout = timeout
    
    async def analyze(
        self,
        file: FileContext,
        related_files: Optional[List[FileContext]] = None,
        existing_diagnostics: Optional[List[Diagnostic]] = None,
    ) -> TierResult:
        """
        Perform AI-powered analysis on a file.
        
        Args:
            file: The file to analyze
            related_files: Related files for context (imports, etc.)
            existing_diagnostics: Diagnostics from previous tiers to avoid duplicates
        
        Returns:
            TierResult containing AI-generated diagnostics
        """
        start_time = time.perf_counter()
        
        if self._provider is None:
            # No provider configured, skip AI analysis
            return TierResult(
                tier=AnalysisTier.AI,
                diagnostics=[],
                elapsed_ms=0.0,
            )
        
        try:
            diagnostics = await self._run_analysis(file, related_files, existing_diagnostics)
        except Exception as e:
            # Don't crash on AI errors, just return empty
            diagnostics = []
            # import traceback
            # print(f"[AIErrorPredictor] Analysis failed: {e}")
            # print(f"[AIErrorPredictor] Traceback: {traceback.format_exc()}")
        
        elapsed_ms = (time.perf_counter() - start_time) * 1000
        
        return TierResult(
            tier=AnalysisTier.AI,
            diagnostics=diagnostics[:self._max_diagnostics],
            elapsed_ms=elapsed_ms,
        )
    
    # Standard library headers and their symbols (for C/C++)
    STD_LIBRARY_SYMBOLS = {
        'iostream': {'cout', 'cin', 'cerr', 'clog', 'endl', 'flush', 'ostream', 'istream', 'ios'},
        'string': {'string', 'wstring', 'basic_string', 'to_string', 'stoi', 'stol', 'stof', 'stod'},
        'vector': {'vector'},
        'map': {'map', 'multimap'},
        'set': {'set', 'multiset'},
        'unordered_map': {'unordered_map', 'unordered_multimap'},
        'unordered_set': {'unordered_set', 'unordered_multiset'},
        'algorithm': {'sort', 'find', 'copy', 'transform', 'for_each', 'count', 'fill'},
        'memory': {'unique_ptr', 'shared_ptr', 'weak_ptr', 'make_unique', 'make_shared'},
        'cstdio': {'printf', 'scanf', 'sprintf', 'sscanf', 'fprintf', 'fscanf', 'FILE', 'stdin', 'stdout', 'stderr'},
        'cstring': {'strlen', 'strcpy', 'strcat', 'strcmp', 'memcpy', 'memset', 'memmove'},
        'cmath': {'sin', 'cos', 'tan', 'sqrt', 'pow', 'abs', 'floor', 'ceil', 'log', 'exp'},
        'cstdlib': {'malloc', 'free', 'calloc', 'realloc', 'exit', 'atoi', 'atof', 'rand', 'srand'},
        'fstream': {'ifstream', 'ofstream', 'fstream'},
        'sstream': {'stringstream', 'istringstream', 'ostringstream'},
        'functional': {'function', 'bind', 'placeholders'},
        'utility': {'pair', 'make_pair', 'move', 'swap', 'forward'},
    }
    
    def _build_include_context(
        self,
        file: FileContext,
        related_files: Optional[List[FileContext]],
    ) -> str:
        """
        Build context about available symbols from includes.
        
        This helps the AI understand what symbols are already available
        via direct or transitive includes.
        """
        if file.language.lower() not in ('cpp', 'c++', 'c', 'h', 'hpp'):
            return ""
        
        lines = file.content.splitlines()
        available_symbols = set()
        include_chain = []  # Track include chain for context
        
        # Find direct includes
        direct_includes = set()
        for line in lines:
            stripped = line.strip()
            match = re.match(r'#include\s*[<"]([^>"]+)[>"]', stripped)
            if match:
                header = match.group(1)
                direct_includes.add(header)
                header_base = header.replace('.h', '').replace('.hpp', '')
                if header_base in self.STD_LIBRARY_SYMBOLS:
                    symbols = self.STD_LIBRARY_SYMBOLS[header_base]
                    available_symbols.update(symbols)
                    include_chain.append(f"  - <{header}> provides: {', '.join(sorted(symbols))}")
        
        # Process related files (transitive includes)
        if related_files:
            processed = set()
            files_to_check = []
            
            # Match direct includes to related files
            for header in direct_includes:
                header_lower = header.lower()
                for rf in related_files:
                    rf_name = rf.path.lower().split('/')[-1].split('\\')[-1]
                    if rf_name == header_lower:
                        files_to_check.append((rf, header))
            
            # Process matched files
            while files_to_check:
                rf, via_header = files_to_check.pop(0)
                if rf.path in processed:
                    continue
                processed.add(rf.path)
                
                # Check includes in this file
                for line in rf.content.splitlines():
                    stripped = line.strip()
                    match = re.match(r'#include\s*[<"]([^>"]+)[>"]', stripped)
                    if match:
                        nested_header = match.group(1)
                        header_base = nested_header.replace('.h', '').replace('.hpp', '')
                        if header_base in self.STD_LIBRARY_SYMBOLS:
                            symbols = self.STD_LIBRARY_SYMBOLS[header_base]
                            available_symbols.update(symbols)
                            include_chain.append(f"  - <{nested_header}> (via {via_header}) provides: {', '.join(sorted(symbols))}")
        
        if not available_symbols:
            return ""
        
        context = """## AVAILABLE SYMBOLS (from includes)
The following symbols are ALREADY AVAILABLE in this code via direct or transitive includes.
Do NOT report missing includes for these symbols:

"""
        context += "\n".join(include_chain) if include_chain else ""
        context += f"\n\n**All available symbols**: {', '.join(sorted(available_symbols))}\n"
        
        return context
    
    async def _run_analysis(
        self,
        file: FileContext,
        related_files: Optional[List[FileContext]],
        existing_diagnostics: Optional[List[Diagnostic]],
    ) -> List[Diagnostic]:
        """Run the actual AI analysis."""
        
        # Build include context for the prompt
        include_context = self._build_include_context(file, related_files)
        
        # If we have related files, include them in the prompt for cross-file analysis
        related_files_section = ""
        if related_files:
            related_files_section = "\n\n## RELATED FILES (from includes):\n"
            for rf in related_files:
                related_files_section += f"\n### {rf.path}\n```{rf.language}\n{rf.content}\n```\n"
        
        # Build the prompt - simple string replacement
        prompt = AI_ERROR_PREDICTION_PROMPT.replace("{language}", file.language) \
                                           .replace("{code}", file.content) \
                                           .replace("{include_context}", include_context + related_files_section)
        
        # Call the LLM
        response = await self._provider.ask_llm(
            code=file.content,
            lang=file.language,
            prompt=prompt,
            mode="analyze",
        )
        
        # Parse the response
        diagnostics = self._parse_response(response, file)
        
        # Filter out duplicates with existing diagnostics
        if existing_diagnostics:
            diagnostics = self._filter_duplicates(diagnostics, existing_diagnostics)
        
        # Filter by confidence
        diagnostics = [d for d in diagnostics if d.confidence >= self._min_confidence]
        
        return diagnostics
    
    def _parse_response(self, response: str, file: FileContext) -> List[Diagnostic]:
        """Parse the LLM response into diagnostics."""
        diagnostics = []
        
        # Try to extract JSON from the response
        json_str = self._extract_json(response)
        if not json_str:
            return diagnostics
        
        try:
            items = json.loads(json_str)
            if not isinstance(items, list):
                return diagnostics
        except json.JSONDecodeError:
            return diagnostics
        
        lines = file.content.splitlines()
        max_line = len(lines) - 1
        full_code = file.content
        
        for item in items:
            try:
                diagnostic = self._parse_diagnostic_item(item, lines, max_line, full_code)
                if diagnostic:
                    diagnostics.append(diagnostic)
            except Exception:
                continue
        
        return diagnostics
    
    def _parse_diagnostic_item(
        self,
        item: Dict[str, Any],
        lines: List[str],
        max_line: int,
        full_code: str,
    ) -> Optional[Diagnostic]:
        """Parse a single diagnostic item from the LLM response."""
        if not isinstance(item, dict):
            return None
        
        # Extract required fields
        message = item.get("message", "").strip()
        if not message:
            return None
        
        # Parse line numbers (1-indexed in response, convert to 0-indexed)
        # Support both old format (line) and new format (line_start, line_end)
        line_start = item.get("line_start") or item.get("line", 1)
        line_end = item.get("line_end") or line_start
        
        line_num = max(0, min(int(line_start) - 1, max_line))
        end_line_num = max(line_num, min(int(line_end) - 1, max_line))
        
        # Parse severity
        severity_str = str(item.get("severity", "warning")).lower()
        severity = SEVERITY_MAP.get(severity_str, Severity.WARNING)
        
        # Parse confidence
        try:
            confidence = float(item.get("confidence", 0.7))
            confidence = max(0.0, min(1.0, confidence))
        except (ValueError, TypeError):
            confidence = 0.7
        
        # Parse category
        category_str = item.get("category", "logic_error").lower().replace("-", "_").replace(" ", "_")
        category = CATEGORY_MAP.get(category_str, DiagnosticCategory.LOGIC_ERROR)
        
        # Get snippet - the exact code to highlight
        snippet = item.get("snippet", "") or item.get("wrong", "")
        fix_snippet = item.get("fix_snippet", "") or item.get("correct", "")
        
        # Normalize snippet (handle escaped newlines from JSON)
        snippet = snippet.replace("\\n", "\n").replace("\\t", "\t")
        fix_snippet = fix_snippet.replace("\\n", "\n").replace("\\t", "\t")
        
        # Try to find the exact position of the snippet in the code
        column = 0
        end_column = 0
        snippet_found = False
        
        if snippet:
            # First, try to find in the full code
            snippet_idx = full_code.find(snippet)
            if snippet_idx != -1:
                # Found exact match - calculate line and column
                lines_before = full_code[:snippet_idx].splitlines()
                if lines_before:
                    line_num = len(lines_before) - 1
                    column = len(lines_before[-1]) if lines_before else 0
                else:
                    line_num = 0
                    column = snippet_idx
                
                # Calculate end position
                snippet_lines = snippet.splitlines()
                if len(snippet_lines) > 1:
                    end_line_num = line_num + len(snippet_lines) - 1
                    end_column = len(snippet_lines[-1])
                else:
                    end_line_num = line_num
                    end_column = column + len(snippet)
                
                snippet_found = True
            else:
                # Try case-insensitive or normalized whitespace search
                normalized_code = " ".join(full_code.split())
                normalized_snippet = " ".join(snippet.split())
                
                if normalized_snippet in normalized_code:
                    # Found with normalized whitespace - fall back to line-based
                    snippet_found = False  # Will use line-based highlighting
        
        # If snippet not found exactly, highlight the full line range
        if not snippet_found:
            start_line_content = lines[line_num] if line_num < len(lines) else ""
            end_line_content = lines[end_line_num] if end_line_num < len(lines) else ""
            
            # Start at first non-whitespace character
            column = len(start_line_content) - len(start_line_content.lstrip())
            # End at line length
            end_column = len(end_line_content)
        
        # Ensure valid range
        if end_line_num == line_num and end_column <= column:
            end_column = column + 1  # At least 1 character
        
        # Extract the original text at the diagnostic location for staleness checking
        original_text = None
        if snippet_found and snippet:
            original_text = snippet
        else:
            # Try to get the text from the location
            try:
                if line_num == end_line_num:
                    original_text = lines[line_num][column:end_column] if line_num < len(lines) else ""
                else:
                    # Multi-line: get the text spanning the range
                    text_parts = []
                    for i in range(line_num, min(end_line_num + 1, len(lines))):
                        if i == line_num:
                            text_parts.append(lines[i][column:])
                        elif i == end_line_num:
                            text_parts.append(lines[i][:end_column])
                        else:
                            text_parts.append(lines[i])
                    original_text = '\n'.join(text_parts)
            except Exception:
                original_text = None
        
        # Build diagnostic
        diagnostic = Diagnostic(
            message=message,
            severity=severity,
            tier=AnalysisTier.AI,
            location=DiagnosticLocation(
                line=line_num,
                column=column,
                end_line=end_line_num,
                end_column=end_column,
            ),
            code=f"AI{category_str[:3].upper()}",
            category=category,
            source="synthi-ai",
            explanation=item.get("explanation", ""),
            confidence=confidence,
            originalText=original_text,
        )
        
        # Add fix - support both replacement and deletion (empty fix_snippet)
        # Check if fix_snippet was explicitly provided (even if empty for deletion)
        has_fix = "fix_snippet" in item or "correct" in item
        
        if has_fix:
            # Empty fix_snippet means DELETE the code
            if not fix_snippet:
                desc = f"Remove: {snippet[:60]}..." if len(snippet) > 60 else f"Remove: {snippet}"
            else:
                # Show the full replacement for better context in the UI
                # Format multi-line for readability
                preview = fix_snippet.replace('\n', ' ↵ ')
                if len(preview) > 100:
                    desc = f"Replace with: {preview[:100]}..."
                else:
                    desc = f"Replace with: {preview}"
            
            diagnostic.fixes.append(CodeFix(
                description=desc,
                replacement_text=fix_snippet,  # Empty string = deletion
                location=DiagnosticLocation(
                    line=line_num,
                    column=column,
                    end_line=end_line_num,
                    end_column=end_column,
                ),
                is_preferred=True,
            ))
        elif snippet_found and snippet:
            # No fix provided - create a placeholder
            diagnostic.fixes.append(CodeFix(
                description=f"Review: {message[:50]}..." if len(message) > 50 else f"Review: {message}",
                replacement_text=f"/* TODO: {message} */\n{snippet}",
                location=DiagnosticLocation(
                    line=line_num,
                    column=column,
                    end_line=end_line_num,
                    end_column=end_column,
                ),
                is_preferred=False,
            ))
        
        return diagnostic
    
    def _extract_json(self, text: str) -> Optional[str]:
        """Extract JSON array from LLM response."""
        text = text.strip()
        
        # If it's already valid JSON, return it
        if text.startswith('[') and text.endswith(']'):
            return text
        
        # Try to find JSON array in the text
        match = re.search(r'\[[\s\S]*\]', text)
        if match:
            return match.group(0)
        
        # Try to find JSON in code blocks
        match = re.search(r'```(?:json)?\s*(\[[\s\S]*?\])\s*```', text)
        if match:
            return match.group(1)
        
        return None
    
    # Keywords that indicate the same type of issue
    DUPLICATE_KEYWORDS = {
        'iostream': {'iostream', 'cout', 'cin', 'cerr', 'clog', 'endl'},
        'include': {'include', 'import', 'missing'},
        'undefined': {'undefined', 'undeclared', 'not defined', 'unknown'},
        'unused': {'unused', 'never used', 'not used'},
        'uninitialized': {'uninitialized', 'not initialized', 'garbage'},
        'memory': {'memory', 'leak', 'malloc', 'free', 'delete'},
        'null': {'null', 'nullptr', 'nil', 'none', 'nullpointer'},
        'type': {'type', 'mismatch', 'incompatible'},
    }
    
    def _filter_duplicates(
        self,
        new_diagnostics: List[Diagnostic],
        existing: List[Diagnostic],
    ) -> List[Diagnostic]:
        """Filter out diagnostics that overlap with existing ones from static/semantic analysis."""
        filtered = []
        
        for new_diag in new_diagnostics:
            is_duplicate = False
            
            for existing_diag in existing:
                # Check if they're on same/nearby line
                line_match = abs(new_diag.location.line - existing_diag.location.line) <= 2
                
                # Check for similar message content
                msg_similar = self._similar_message(new_diag.message, existing_diag.message)
                
                # Check for same category of issue (e.g., both about includes)
                category_match = self._same_issue_category(new_diag.message, existing_diag.message)
                
                if line_match and (msg_similar or category_match):
                    is_duplicate = True
                    break
            
            if not is_duplicate:
                filtered.append(new_diag)
        
        return filtered
    
    def _same_issue_category(self, msg1: str, msg2: str) -> bool:
        """Check if two messages are about the same category of issue."""
        msg1_lower = msg1.lower()
        msg2_lower = msg2.lower()
        
        for category, keywords in self.DUPLICATE_KEYWORDS.items():
            msg1_has = any(kw in msg1_lower for kw in keywords)
            msg2_has = any(kw in msg2_lower for kw in keywords)
            if msg1_has and msg2_has:
                return True
        
        return False
    
    def _similar_message(self, msg1: str, msg2: str) -> bool:
        """Check if two messages are similar enough to be duplicates."""
        # Normalize messages
        msg1 = msg1.lower().strip()
        msg2 = msg2.lower().strip()
        
        # Exact match
        if msg1 == msg2:
            return True
        
        # One contains the other
        if msg1 in msg2 or msg2 in msg1:
            return True
        
        # Check for significant word overlap
        words1 = set(msg1.split())
        words2 = set(msg2.split())
        
        if len(words1) == 0 or len(words2) == 0:
            return False
        
        intersection = words1 & words2
        smaller = min(len(words1), len(words2))
        
        # Lower threshold from 0.7 to 0.5 for more aggressive filtering
        return len(intersection) / smaller > 0.5

    # ========================================================================
    # Multi-File Analysis Methods
    # ========================================================================
    
    async def analyze_multi_file(
        self,
        focus_file: FileContext,
        related_files: List[FileContext],
        existing_diagnostics: Optional[List[Diagnostic]] = None,
    ) -> tuple[List[MultiFileDiagnostic], List[WorkspaceSuggestion]]:
        """
        Analyze multiple files together for cross-file issues.
        
        Args:
            focus_file: The main file being edited (highest priority)
            related_files: Related files for context (imports, dependents)
            existing_diagnostics: Previous diagnostics to avoid duplicates
        
        Returns:
            Tuple of (diagnostics, suggestions)
        """
        if self._provider is None:
            return [], []
        
        try:
            return await self._run_multi_file_analysis(
                focus_file,
                related_files,
                existing_diagnostics,
            )
        except Exception as e:
            # print(f"[AIErrorPredictor] Multi-file analysis failed: {e}")
            # print(f"[AIErrorPredictor] Traceback: {traceback.format_exc()}")
            return [], []
    
    async def _run_multi_file_analysis(
        self,
        focus_file: FileContext,
        related_files: List[FileContext],
        existing_diagnostics: Optional[List[Diagnostic]],
    ) -> tuple[List[MultiFileDiagnostic], List[WorkspaceSuggestion]]:
        """Run the actual multi-file AI analysis."""
        
        # Build the files section for the prompt
        all_files = [focus_file] + related_files
        files_section = self._build_files_section(all_files)
        
        # Build include context for the focus file
        include_context = self._build_include_context(focus_file, related_files)
        
        # Build the prompt
        prompt = AI_MULTI_FILE_ANALYSIS_PROMPT.replace(
            "{files_section}", files_section
        ).replace(
            "{focus_file}", focus_file.path
        ).replace(
            "{include_context}", include_context
        )
        
        # Call the LLM
        response = await self._provider.ask_llm(
            code=focus_file.content,  # Primary code for context
            lang=focus_file.language,
            prompt=prompt,
            mode="analyze",
        )
        
        # Parse the response
        diagnostics, suggestions = self._parse_multi_file_response(
            response,
            all_files,
        )
        
        # Filter by confidence
        diagnostics = [d for d in diagnostics if d.confidence >= self._min_confidence]
        
        return diagnostics, suggestions
    
    def _build_files_section(self, files: List[FileContext]) -> str:
        """Build the files section for the multi-file prompt."""
        sections = []
        
        for i, file in enumerate(files):
            # Mark which file is the focus
            marker = " [FOCUS]" if i == 0 else ""
            
            # Truncate large files
            content = file.content
            if len(content) > 10000:
                # Keep first 4000 and last 2000 chars
                content = (
                    content[:4000] +
                    "\n\n// ... middle truncated ...\n\n" +
                    content[-2000:]
                )
            
            section = f"""
==== FILE{marker}: {file.path} ({file.language}) ====
```{file.language}
{content}
```
==== END FILE: {file.path} ====
"""
            sections.append(section)
        
        return "\n".join(sections)
    
    def _parse_multi_file_response(
        self,
        response: str,
        files: List[FileContext],
    ) -> tuple[List[MultiFileDiagnostic], List[WorkspaceSuggestion]]:
        """Parse the multi-file LLM response."""
        diagnostics = []
        suggestions = []
        
        # Try to extract JSON object from the response
        json_str = self._extract_json_object(response)
        if not json_str:
            return diagnostics, suggestions
        
        try:
            data = json.loads(json_str)
            if not isinstance(data, dict):
                return diagnostics, suggestions
        except json.JSONDecodeError:
            return diagnostics, suggestions
        
        # Build file lookup
        file_map = {f.path: f for f in files}
        
        # Parse diagnostics
        raw_diags = data.get("diagnostics", [])
        if isinstance(raw_diags, list):
            for item in raw_diags:
                try:
                    diag = self._parse_multi_file_diagnostic(item, file_map)
                    if diag:
                        diagnostics.append(diag)
                except Exception:
                    continue
        
        # Parse suggestions
        raw_suggestions = data.get("suggestions", [])
        if isinstance(raw_suggestions, list):
            for item in raw_suggestions:
                try:
                    sugg = self._parse_suggestion(item)
                    if sugg:
                        suggestions.append(sugg)
                except Exception:
                    continue
        
        return diagnostics, suggestions
    
    def _parse_multi_file_diagnostic(
        self,
        item: Dict[str, Any],
        file_map: Dict[str, FileContext],
    ) -> Optional[MultiFileDiagnostic]:
        """Parse a single multi-file diagnostic item."""
        if not isinstance(item, dict):
            return None
        
        # Get the file path
        file_path = item.get("file", "")
        if not file_path:
            # Default to first file if not specified
            file_path = list(file_map.keys())[0] if file_map else ""
        
        # Get file context
        file = file_map.get(file_path)
        lines = file.content.splitlines() if file else []
        max_line = len(lines) - 1 if lines else 0
        
        # Extract basic fields
        message = item.get("message", "").strip()
        if not message:
            return None
        
        # Parse line numbers
        line_start = item.get("line_start") or item.get("line", 1)
        line_end = item.get("line_end") or line_start
        line_num = max(0, min(int(line_start) - 1, max_line))
        end_line_num = max(line_num, min(int(line_end) - 1, max_line))
        
        # Parse severity and category
        severity_str = str(item.get("severity", "warning")).lower()
        severity = SEVERITY_MAP.get(severity_str, Severity.WARNING)
        
        category_str = item.get("category", "logic_error").lower().replace("-", "_")
        category = CATEGORY_MAP.get(category_str, DiagnosticCategory.LOGIC_ERROR)
        
        # Parse confidence
        try:
            confidence = float(item.get("confidence", 0.7))
            confidence = max(0.0, min(1.0, confidence))
        except (ValueError, TypeError):
            confidence = 0.7
        
        # Get snippet and fix
        snippet = item.get("snippet", "")
        fix_snippet = item.get("fix_snippet", "")
        
        # Calculate column positions
        column = 0
        end_column = len(lines[end_line_num]) if end_line_num < len(lines) else 0
        
        if snippet and file:
            # Try to find exact position
            full_code = file.content
            snippet_idx = full_code.find(snippet)
            if snippet_idx != -1:
                lines_before = full_code[:snippet_idx].splitlines()
                if lines_before:
                    line_num = len(lines_before) - 1
                    column = len(lines_before[-1]) if lines_before else 0
                snippet_lines = snippet.splitlines()
                if len(snippet_lines) > 1:
                    end_line_num = line_num + len(snippet_lines) - 1
                    end_column = len(snippet_lines[-1])
                else:
                    end_line_num = line_num
                    end_column = column + len(snippet)
        
        # Build location
        location = DiagnosticLocation(
            line=line_num,
            column=column,
            end_line=end_line_num,
            end_column=end_column,
        )
        
        # Parse cross-file references
        cross_file_refs = []
        related = item.get("related_files", [])
        if isinstance(related, list):
            for ref in related:
                if isinstance(ref, dict):
                    ref_path = ref.get("file", "")
                    ref_line = ref.get("line", 0)
                    ref_msg = ref.get("message", "Related code")
                    
                    cross_file_refs.append(CrossFileReference(
                        file_path=ref_path,
                        location=DiagnosticLocation(
                            line=max(0, int(ref_line) - 1),
                            column=0,
                            end_line=max(0, int(ref_line) - 1),
                            end_column=0,
                        ),
                        message=ref_msg,
                    ))
        
        # Build fixes
        fixes = []
        if fix_snippet or "fix_snippet" in item:
            fixes.append(MultiFileFix(
                description=f"Fix: {message[:50]}..." if len(message) > 50 else f"Fix: {message}",
                edits=[FileEdit(
                    file_path=file_path,
                    location=location,
                    new_text=fix_snippet,
                )],
                is_preferred=True,
            ))
        
        return MultiFileDiagnostic(
            primary_file=file_path,
            message=message,
            severity=severity,
            tier=AnalysisTier.AI,
            location=location,
            code=f"AI{category_str[:3].upper()}",
            category=category,
            source="synthi-ai",
            cross_file_refs=cross_file_refs,
            fixes=fixes,
            explanation=item.get("explanation", ""),
            confidence=confidence,
            originalText=snippet or None,
        )
    
    def _parse_suggestion(self, item: Dict[str, Any]) -> Optional[WorkspaceSuggestion]:
        """Parse a workspace suggestion from the LLM response."""
        if not isinstance(item, dict):
            return None
        
        title = item.get("title", "").strip()
        description = item.get("description", "").strip()
        
        if not title or not description:
            return None
        
        category = item.get("category", "improvement")
        affected_files = item.get("affected_files", [])
        
        try:
            confidence = float(item.get("confidence", 0.7))
            confidence = max(0.0, min(1.0, confidence))
        except (ValueError, TypeError):
            confidence = 0.7
        
        # Generate a simple ID
        import hashlib
        id_str = f"{title}:{':'.join(affected_files)}"
        suggestion_id = f"ai-{hashlib.md5(id_str.encode()).hexdigest()[:8]}"
        
        return WorkspaceSuggestion(
            id=suggestion_id,
            title=title,
            description=description,
            category=category,
            severity=Severity.HINT,
            affected_files=affected_files if isinstance(affected_files, list) else [],
            confidence=confidence,
        )
    
    def _extract_json_object(self, text: str) -> Optional[str]:
        """Extract JSON object from LLM response."""
        text = text.strip()
        
        # If it's already valid JSON object, return it
        if text.startswith('{') and text.endswith('}'):
            return text
        
        # Try to find JSON object in the text
        match = re.search(r'\{[\s\S]*\}', text)
        if match:
            return match.group(0)
        
        # Try to find JSON in code blocks
        match = re.search(r'```(?:json)?\s*(\{[\s\S]*?\})\s*```', text)
        if match:
            return match.group(1)
        
        return None

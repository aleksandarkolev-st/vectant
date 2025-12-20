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


# Prompt template for AI error prediction - PRECISE SENIOR DEV LEVEL
AI_ERROR_PREDICTION_PROMPT = """You are an expert code reviewer finding REAL bugs that cause incorrect behavior.

## YOUR TASK
Find bugs in the code below. Only report issues that:
1. Will cause WRONG OUTPUT or RUNTIME ERROR with specific inputs
2. You can PROVE with a concrete example (e.g., "input X gives Y, but should give Z")

## WHAT TO LOOK FOR
- Wrong operators: `<` vs `<=`, `==` vs `!=`, `&&` vs `||`
- Off-by-one errors in loops or array access
- Missing edge cases: null, 0, negative, empty, boundary values
- Incorrect return values or missing returns
- Infinite loops or recursion without termination
- Logic that contradicts the function's purpose

## WHAT TO IGNORE (NOT BUGS)
- Style, formatting, naming conventions
- Missing comments or documentation  
- Performance suggestions (unless causes timeout)
- Best practices that don't affect correctness
- Code that handles edge cases correctly (don't suggest adding checks that exist)

## CRITICAL RULES
1. READ THE ACTUAL CODE - don't assume what it does
2. If a check exists (like `if (x < 0)`), don't report it as missing
3. `if (x < 0)` and `if (x == 0)` are DIFFERENT checks - one tests negative, one tests zero
4. Only report bugs you can PROVE with input → expected → actual

## RESPONSE FORMAT
Return ONLY a JSON array (no markdown, no explanation outside JSON):
```json
[
  {{
    "line_start": 5,
    "line_end": 5,
    "snippet": "exact code from source to highlight",
    "message": "Brief bug description",
    "explanation": "PROOF: When input=X, this returns Y but should return Z because...",
    "severity": "error",
    "confidence": 0.9,
    "fix_snippet": "corrected code to replace snippet",
    "category": "logic_error"
  }}
]
```

## FIELD RULES
- `snippet`: Copy EXACT code from source (what to replace)
- `fix_snippet`: The CORRECTED code (replacement). Use "" only to DELETE code.
- `confidence`: 0.0-1.0. Use 0.9+ only if you can prove the bug.
- `category`: logic_error | off_by_one | wrong_operator | boundary_error | missing_check
- `severity`: "error" for bugs causing wrong results, "warning" for potential issues

## EXAMPLES

### Example 1: Wrong operator
Code: `if (n % 2 == 0) print("odd")`
Bug: Prints "odd" when n is even (wrong operator)
```json
[{{"line_start":1,"line_end":1,"snippet":"n % 2 == 0","message":"Condition is true for even numbers but prints 'odd'","explanation":"PROOF: n=4 → 4%2=0 → true → prints 'odd'. Should use n%2!=0","severity":"error","confidence":0.95,"fix_snippet":"n % 2 != 0","category":"wrong_operator"}}]
```

### Example 2: Missing base case
Code: `int f(int n) {{ return n * f(n-1); }}`
Bug: No base case causes infinite recursion
```json
[{{"line_start":1,"line_end":1,"snippet":"return n * f(n-1);","message":"Missing base case causes infinite recursion","explanation":"PROOF: f(1) calls f(0) calls f(-1)... never stops. Need base case for n<=1","severity":"error","confidence":0.95,"fix_snippet":"if (n <= 1) return 1; return n * f(n-1);","category":"missing_check"}}]
```

### Example 3: NOT a bug (edge case handled)
Code: `int abs(int x) {{ if (x < 0) return -x; return x; }}`
Response: `[]`  ← Empty because the negative case IS handled

If no bugs found or uncertain, return: `[]`

## CODE TO REVIEW
```{language}
{code}
```

JSON:"""


# ============================================================================
# Multi-File Analysis Prompt
# ============================================================================

AI_MULTI_FILE_ANALYSIS_PROMPT = """You are an expert code reviewer analyzing a workspace with multiple related files.

## YOUR TASK
Find bugs and cross-file issues in the code. Focus on:
1. Bugs in the FOCUS FILE that will cause WRONG OUTPUT or RUNTIME ERROR
2. Cross-file issues: missing imports, type mismatches, unused exports
3. Integration bugs between files (wrong function signatures, incorrect usage)

## FILES PROVIDED
{files_section}

## FOCUS FILE: {focus_file}

## WHAT TO LOOK FOR
### Single-file bugs (in focus file):
- Wrong operators, off-by-one errors, missing edge cases
- Incorrect return values or missing returns
- Logic errors and infinite loops

### Cross-file issues:
- Importing something that doesn't exist in the target file
- Using wrong function signature (wrong params/return type)
- Calling a function with incorrect arguments based on its definition
- Missing imports for used symbols
- Type mismatches between files

## RESPONSE FORMAT
Return a JSON object with two arrays:
```json
{{
  "diagnostics": [
    {{
      "file": "path/to/file.js",
      "line_start": 5,
      "line_end": 5,
      "snippet": "exact code from source",
      "message": "Brief bug description",
      "explanation": "Why this is a bug",
      "severity": "error",
      "confidence": 0.9,
      "fix_snippet": "corrected code",
      "category": "logic_error",
      "related_files": [
        {{"file": "other/file.js", "line": 10, "message": "Related definition here"}}
      ]
    }}
  ],
  "suggestions": [
    {{
      "title": "Short title for suggestion",
      "description": "Detailed description of improvement",
      "category": "refactor",
      "affected_files": ["file1.js", "file2.js"],
      "confidence": 0.85
    }}
  ]
}}
```

## CATEGORY OPTIONS
- `logic_error`, `type_error`, `undefined_variable`, `missing_import`
- `wrong_signature`, `unused_export`, `security`, `performance`

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
            import traceback
            print(f"[AIErrorPredictor] Analysis failed: {e}")
            print(f"[AIErrorPredictor] Traceback: {traceback.format_exc()}")
        
        elapsed_ms = (time.perf_counter() - start_time) * 1000
        
        return TierResult(
            tier=AnalysisTier.AI,
            diagnostics=diagnostics[:self._max_diagnostics],
            elapsed_ms=elapsed_ms,
        )
    
    async def _run_analysis(
        self,
        file: FileContext,
        related_files: Optional[List[FileContext]],
        existing_diagnostics: Optional[List[Diagnostic]],
    ) -> List[Diagnostic]:
        """Run the actual AI analysis."""
        
        # Build the prompt - simple string replacement
        prompt = AI_ERROR_PREDICTION_PROMPT.replace("{language}", file.language) \
                                           .replace("{code}", file.content)
        
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
    
    def _filter_duplicates(
        self,
        new_diagnostics: List[Diagnostic],
        existing: List[Diagnostic],
    ) -> List[Diagnostic]:
        """Filter out diagnostics that overlap with existing ones."""
        filtered = []
        
        for new_diag in new_diagnostics:
            is_duplicate = False
            
            for existing_diag in existing:
                # Check if they're on the same line and similar message
                if (abs(new_diag.location.line - existing_diag.location.line) <= 1 and
                    self._similar_message(new_diag.message, existing_diag.message)):
                    is_duplicate = True
                    break
            
            if not is_duplicate:
                filtered.append(new_diag)
        
        return filtered
    
    def _similar_message(self, msg1: str, msg2: str) -> bool:
        """Check if two messages are similar enough to be duplicates."""
        # Normalize messages
        msg1 = msg1.lower().strip()
        msg2 = msg2.lower().strip()
        
        # Exact match
        if msg1 == msg2:
            return True
        
        # Check for significant word overlap
        words1 = set(msg1.split())
        words2 = set(msg2.split())
        
        if len(words1) == 0 or len(words2) == 0:
            return False
        
        intersection = words1 & words2
        smaller = min(len(words1), len(words2))
        
        return len(intersection) / smaller > 0.7

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
            print(f"[AIErrorPredictor] Multi-file analysis failed: {e}")
            print(f"[AIErrorPredictor] Traceback: {traceback.format_exc()}")
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
        
        # Build the prompt
        prompt = AI_MULTI_FILE_ANALYSIS_PROMPT.replace(
            "{files_section}", files_section
        ).replace(
            "{focus_file}", focus_file.path
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

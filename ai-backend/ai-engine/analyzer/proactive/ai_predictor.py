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

The AI analyzer runs after static and semantic analysis complete,
providing deeper insights with explanations.
"""

from __future__ import annotations

import json
import re
import time
from typing import Any, Dict, List, Optional

from .types import (
    AnalysisTier,
    CodeFix,
    Diagnostic,
    DiagnosticCategory,
    DiagnosticLocation,
    FileContext,
    Severity,
    TierResult,
)


# Prompt template for AI error prediction - PRECISE SENIOR DEV LEVEL
AI_ERROR_PREDICTION_PROMPT = """You are a senior software engineer conducting a thorough code review. Analyze this {language} code for bugs that would cause incorrect runtime behavior.

ANALYSIS APPROACH:
1. Trace through the code mentally - what happens for different inputs?
2. Check boundary conditions and edge cases
3. Verify logic operators (&&, ||, !, ==, !=, <, >, <=, >=)
4. Check off-by-one errors in loops and array access
5. Verify function return values and early returns
6. Check for swapped conditions or inverted logic

RESPOND WITH A JSON ARRAY. Each issue must have these EXACT fields:

{{
  "line_start": <number>,        // First line of the problematic code (1-indexed)
  "line_end": <number>,          // Last line of the problematic code (1-indexed)  
  "snippet": "<string>",         // EXACT code to highlight - copy CHARACTER BY CHARACTER from source
  "message": "<string>",         // Clear, actionable description (like a PR comment)
  "explanation": "<string>",     // WHY this is wrong - trace through with example values
  "severity": "error"|"warning", // error = will definitely fail, warning = likely bug
  "confidence": <0.0-1.0>,       // Your confidence this is a real bug
  "fix_snippet": "<string>",     // REQUIRED: The corrected code (drop-in replacement for snippet)
  "category": "<string>"         // One of: logic_error, off_by_one, wrong_operator, wrong_condition, boundary_error, missing_check
}}

CRITICAL - EVERY ISSUE MUST HAVE A FIX:
- "snippet" MUST be copied exactly from the code (preserve spaces, operators, etc.)
- "fix_snippet" MUST be provided - show how to fix the issue
- For missing validation: snippet = the function/if line, fix_snippet = add the check
- For wrong logic: snippet = the wrong expression, fix_snippet = corrected expression

EXAMPLE 1 - Missing negative check:
Code: `int power(int base, int exp) {{ if (exp == 0) return 1; return base * power(base, exp - 1); }}`
Response: [{{"line_start": 1, "line_end": 1, "snippet": "if (exp == 0) return 1;", "message": "Missing check for negative exponents causes infinite recursion", "explanation": "When exp is negative, exp-1 goes to -2, -3, etc. forever. power(2, -1) will stack overflow.", "severity": "error", "confidence": 0.95, "fix_snippet": "if (exp < 0) return 0; if (exp == 0) return 1;", "category": "missing_check"}}]

EXAMPLE 2 - Wrong operator:
Code line 5: `if (n % 2 == 0) {{ cout << "Odd"; }}`
Response: [{{"line_start": 5, "line_end": 5, "snippet": "n % 2 == 0", "message": "Condition checks for even but prints 'Odd'", "explanation": "n % 2 == 0 is true when n is EVEN, but the code prints 'Odd'. For n=4: 4%2=0, prints 'Odd' incorrectly.", "severity": "error", "confidence": 0.95, "fix_snippet": "n % 2 != 0", "category": "wrong_operator"}}]

EXAMPLE 3 - Integer overflow risk:
Code: `int factorial(int n) {{ int result = 1; for(int i=1; i<=n; i++) result *= i; return result; }}`
Response: [{{"line_start": 1, "line_end": 1, "snippet": "int result = 1;", "message": "Integer overflow for n > 12", "explanation": "13! = 6,227,020,800 exceeds INT_MAX (2,147,483,647). factorial(13) overflows.", "severity": "warning", "confidence": 0.9, "fix_snippet": "long long result = 1;", "category": "boundary_error"}}]

RULES:
- ALWAYS provide fix_snippet - this is required for the quick fix feature
- snippet must match the code EXACTLY (copy-paste precision)
- Only report bugs that cause INCORRECT BEHAVIOR
- If no bugs found, return: []
- JSON only, no markdown

CODE TO ANALYZE:
```{language}
{code}
```

JSON:"""


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
        )
        
        # Add fix if we have fix_snippet - be lenient about adding fixes
        if fix_snippet:
            # Create a meaningful description
            if len(fix_snippet) < 60:
                desc = f"Apply fix: {fix_snippet}"
            else:
                desc = f"Apply suggested fix ({len(fix_snippet)} chars)"
            
            diagnostic.fixes.append(CodeFix(
                description=desc,
                replacement_text=fix_snippet,
                location=DiagnosticLocation(
                    line=line_num,
                    column=column,
                    end_line=end_line_num,
                    end_column=end_column,
                ),
                is_preferred=True,
            ))
        elif snippet_found and snippet:
            # Even without fix_snippet, create a placeholder fix that shows the issue
            # This helps users at least see what code needs to change
            diagnostic.fixes.append(CodeFix(
                description=f"Review and fix: {message[:50]}..." if len(message) > 50 else f"Review and fix: {message}",
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

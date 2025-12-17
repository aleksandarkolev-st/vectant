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
AI_ERROR_PREDICTION_PROMPT = """You are a senior software engineer doing a code review. Your job is to find REAL bugs in the code below.

CRITICAL INSTRUCTIONS:
1. READ THE CODE CAREFULLY - every character matters
2. Only report issues that will cause INCORRECT RUNTIME BEHAVIOR
3. Do NOT report style issues, naming, or missing comments
4. Do NOT report issues that are already handled in the code
5. If a check exists (like `if (x < 0)`), don't say it's missing

ANALYSIS PROCESS:
1. Read each line and understand what it does
2. For each function: What inputs could break it?
3. Check: loops, conditions, operators, return values
4. Only report if you can prove the bug with a specific input

RESPONSE FORMAT - JSON array only:
[
  {{
    "line_start": <1-indexed line number>,
    "line_end": <1-indexed line number>,
    "snippet": "<exact code to highlight - COPY FROM SOURCE>",
    "message": "<brief description of the bug>",
    "explanation": "<prove the bug with example: 'When x=5, this returns 10 but should return 15'>",
    "severity": "error" | "warning",
    "confidence": <0.0 to 1.0>,
    "fix_snippet": "<the corrected code, or EMPTY STRING to delete the snippet>",
    "category": "logic_error" | "off_by_one" | "wrong_operator" | "boundary_error" | "missing_check"
  }}
]

CRITICAL RULES FOR FIXES:
- "snippet" = EXACT copy of buggy code from the source
- "fix_snippet" = the CORRECTED version that should replace snippet
- To ADD missing code: snippet = line missing something, fix_snippet = line WITH the addition
  Example: Missing endl → snippet = "cout << x;", fix_snippet = "cout << x << endl;"
- To CHANGE code: snippet = buggy code, fix_snippet = corrected code
- To REMOVE code (RARE - only for truly dead code): snippet = code to remove, fix_snippet = ""
- NEVER use empty fix_snippet unless the code should literally be deleted

EXAMPLES:

1. WRONG OPERATOR - "even" printed for odd numbers:
   Code: `if (n % 2 == 0) cout << "odd";`
   Response: [{{"line_start":1, "line_end":1, "snippet":"n % 2 == 0", "message":"Prints 'odd' when number is even", "explanation":"n=4: 4%2=0 is true, prints 'odd'. Should use n%2!=0", "severity":"error", "confidence":0.95, "fix_snippet":"n % 2 != 0", "category":"wrong_operator"}}]

2. ADDING A MISSING CHECK:
   Code: `int pow(int b, int e) {{ if(e==0)return 1; return b*pow(b,e-1); }}`
   Response: [{{"line_start":1, "line_end":1, "snippet":"if(e==0)return 1;", "message":"Infinite recursion for negative exponents", "explanation":"pow(2,-1) calls pow(2,-2), pow(2,-3)... forever", "severity":"error", "confidence":0.95, "fix_snippet":"if(e<0)return 0; if(e==0)return 1;", "category":"missing_check"}}]

3. ADDING MISSING OUTPUT:
   Code line 5: `cout << result;`  // missing endl
   Response: [{{"line_start":5, "line_end":5, "snippet":"cout << result;", "message":"Missing newline at end of output", "explanation":"Output won't have newline, next output appears on same line", "severity":"warning", "confidence":0.9, "fix_snippet":"cout << result << endl;", "category":"logic_error"}}]

4. DUPLICATE CHECK (THIS IS WRONG - the checks are different):
   Code: `if (x < 0) return -1; if (x == 0) return 0;`
   Response: []  // These are DIFFERENT checks (< vs ==), NOT duplicates!

IMPORTANT:
- If unsure, return []
- Don't invent bugs that aren't there
- Read the ACTUAL code, not what you assume it says
- "if (x < 0)" and "if (x == 0)" are DIFFERENT - one checks negative, one checks zero

CODE TO REVIEW:
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

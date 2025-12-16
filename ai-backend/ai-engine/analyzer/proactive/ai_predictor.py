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


# Prompt template for AI error prediction
AI_ERROR_PREDICTION_PROMPT = """You are an expert code reviewer with deep knowledge of software engineering best practices, security vulnerabilities, and common bugs. Analyze the following code for potential issues that might not be caught by a compiler or linter.

Focus on:
1. **Logic Errors**: Off-by-one errors, incorrect conditions, wrong operators
2. **Security Issues**: SQL injection, XSS, insecure defaults, hardcoded secrets
3. **Race Conditions**: Data races, deadlocks, TOCTOU vulnerabilities
4. **Resource Leaks**: Unclosed files, database connections, memory leaks
5. **API Misuse**: Incorrect function usage, wrong parameter types, deprecated APIs
6. **Edge Cases**: Null/undefined handling, empty collections, boundary conditions
7. **Performance Issues**: N+1 queries, unnecessary allocations, blocking operations

For each issue found, respond with a JSON array of objects with these fields:
- "line": 1-indexed line number where the issue starts
- "endLine": 1-indexed line number where the issue ends (same as line if single line)
- "column": 0-indexed column where the issue starts
- "endColumn": 0-indexed column where the issue ends
- "severity": "error" | "warning" | "info" | "hint"
- "category": one of "logic_error", "security", "concurrency", "resource_leak", "type_error", "performance", "best_practice"
- "message": Brief description of the issue (1 sentence)
- "explanation": Detailed explanation of why this is a problem and how to fix it (2-3 sentences)
- "confidence": 0.0 to 1.0 confidence score
- "fix": (optional) suggested code replacement

If no issues are found, respond with an empty array: []

IMPORTANT: 
- Only report issues you're reasonably confident about (confidence >= 0.6)
- Don't report obvious syntax errors (the compiler will catch those)
- Don't repeat issues already caught by static analysis
- Be specific about line numbers and locations
- Keep explanations concise but actionable

Language: {language}
File: {file_path}

```{language}
{code}
```

Respond ONLY with a valid JSON array, no markdown, no explanation outside the JSON:"""


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
            print(f"[AIErrorPredictor] Analysis failed: {e}")
        
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
        
        # Build the prompt
        prompt = AI_ERROR_PREDICTION_PROMPT.format(
            language=file.language,
            file_path=file.path,
            code=file.content,
        )
        
        # Add context about related files if available
        if related_files:
            context_parts = []
            for rf in related_files[:5]:  # Limit context
                context_parts.append(f"--- {rf.path} ---\n{rf.content[:2000]}")
            
            if context_parts:
                prompt += f"\n\nRelated files for context:\n" + "\n".join(context_parts)
        
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
        
        for item in items:
            try:
                diagnostic = self._parse_diagnostic_item(item, lines, max_line)
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
    ) -> Optional[Diagnostic]:
        """Parse a single diagnostic item from the LLM response."""
        if not isinstance(item, dict):
            return None
        
        # Extract required fields
        message = item.get("message", "").strip()
        if not message:
            return None
        
        # Parse line numbers (1-indexed in response, convert to 0-indexed)
        line = max(0, min(item.get("line", 1) - 1, max_line))
        end_line = max(line, min(item.get("endLine", line + 1) - 1, max_line))
        
        # Parse columns
        line_length = len(lines[line]) if line < len(lines) else 0
        column = max(0, min(item.get("column", 0), line_length))
        end_column = max(column, min(item.get("endColumn", line_length), line_length))
        
        # Parse severity
        severity_str = item.get("severity", "warning").lower()
        severity = SEVERITY_MAP.get(severity_str, Severity.WARNING)
        
        # Parse category
        category_str = item.get("category", "logic_error").lower().replace(" ", "_")
        category = CATEGORY_MAP.get(category_str, DiagnosticCategory.LOGIC_ERROR)
        
        # Parse confidence
        confidence = float(item.get("confidence", 0.7))
        confidence = max(0.0, min(1.0, confidence))
        
        # Build diagnostic
        diagnostic = Diagnostic(
            message=message,
            severity=severity,
            tier=AnalysisTier.AI,
            location=DiagnosticLocation(
                line=line,
                column=column,
                end_line=end_line,
                end_column=end_column,
            ),
            code=f"AI{category_str[:3].upper()}{hash(message) % 100:02d}",
            category=category,
            source="synthi-ai",
            explanation=item.get("explanation", ""),
            confidence=confidence,
        )
        
        # Add fix if provided
        if "fix" in item and item["fix"]:
            diagnostic.fixes.append(CodeFix(
                description="AI-suggested fix",
                replacement_text=str(item["fix"]),
                location=diagnostic.location,
                is_preferred=True,
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

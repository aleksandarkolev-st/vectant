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


# Prompt template for AI error prediction - WITH SIMPLE FIXES
AI_ERROR_PREDICTION_PROMPT = """Analyze this code for logic errors. Return JSON array.

Each issue needs:
- "line": line number (1-indexed)
- "message": brief description  
- "explanation": why it's wrong
- "severity": "error" or "warning"
- "confidence": 0.0-1.0
- "wrong": the exact wrong string in the code (copy exactly from code)
- "correct": what it should be replaced with

Example for code with "Odd" that should be "Even":
[{"line": 3, "message": "Wrong label", "explanation": "Prints Odd for even numbers", "severity": "warning", "confidence": 0.9, "wrong": "Odd!", "correct": "Even!"}]

Rules:
- Find LOGIC errors only (wrong conditions, swapped values)
- "wrong" must be an EXACT substring from the code on that line
- "correct" is the replacement
- Return [] if no issues
- JSON only, no markdown

Language: {language}

{code}

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
        
        # Parse line number (1-indexed in response, convert to 0-indexed)
        line_num = max(0, min(int(item.get("line", 1)) - 1, max_line))
        
        # Get the actual line content
        line_content = lines[line_num] if line_num < len(lines) else ""
        line_length = len(line_content)
        
        # Parse severity
        severity_str = str(item.get("severity", "warning")).lower()
        severity = SEVERITY_MAP.get(severity_str, Severity.WARNING)
        
        # Parse confidence
        try:
            confidence = float(item.get("confidence", 0.7))
            confidence = max(0.0, min(1.0, confidence))
        except (ValueError, TypeError):
            confidence = 0.7
        
        # Find the exact position of "wrong" string in the line
        wrong_str = item.get("wrong", "")
        correct_str = item.get("correct", "")
        
        # Default to highlighting the trimmed content of the line (skip leading whitespace)
        leading_whitespace = len(line_content) - len(line_content.lstrip())
        column = leading_whitespace
        end_column = max(line_length, column + 1)  # At least 1 character
        
        if wrong_str and wrong_str in line_content:
            # Found the exact wrong string - get its position
            column = line_content.find(wrong_str)
            end_column = column + len(wrong_str)
        elif wrong_str:
            # Try case-insensitive search
            lower_line = line_content.lower()
            lower_wrong = wrong_str.lower()
            if lower_wrong in lower_line:
                column = lower_line.find(lower_wrong)
                end_column = column + len(wrong_str)
            else:
                # Try to find partial match (first word of wrong_str)
                first_word = wrong_str.split()[0] if wrong_str.split() else wrong_str
                if first_word in line_content:
                    column = line_content.find(first_word)
                    end_column = column + len(first_word)
        
        # Build diagnostic
        diagnostic = Diagnostic(
            message=message,
            severity=severity,
            tier=AnalysisTier.AI,
            location=DiagnosticLocation(
                line=line_num,
                column=column,
                end_line=line_num,
                end_column=end_column,
            ),
            code="AILOG",
            category=DiagnosticCategory.LOGIC_ERROR,
            source="synthi-ai",
            explanation=item.get("explanation", ""),
            confidence=confidence,
        )
        
        # Add fix if we have both wrong and correct strings
        if wrong_str and correct_str and wrong_str in line_content:
            diagnostic.fixes.append(CodeFix(
                description=f"Replace '{wrong_str}' with '{correct_str}'",
                replacement_text=correct_str,
                location=DiagnosticLocation(
                    line=line_num,
                    column=column,
                    end_line=line_num,
                    end_column=end_column,
                ),
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

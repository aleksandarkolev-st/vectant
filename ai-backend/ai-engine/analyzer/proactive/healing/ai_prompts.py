"""
AI-powered error detection prompts.

Prompt templates for the agentic healing system.  Unlike the regex
rules these ask an LLM to understand code semantics and identify
real errors — wrong logic, misused APIs, missing edge-case handling,
subtle type mismatches, etc.

The prompts are designed for structured JSON output so the response
can be parsed deterministically.
"""

from __future__ import annotations

from typing import List, Optional, Dict, Any


# ── System persona ────────────────────────────────────────────────────

AGENT_SYSTEM_PROMPT = """\
You are a senior code reviewer embedded inside a cloud IDE.
Your job is to find **small, concrete bugs and mistakes** in the code
the user is currently editing.

Rules:
- Focus on REAL errors: wrong logic, off-by-one, null dereference,
  resource leaks, incorrect API usage, missing error handling,
  wrong variable used, missing awaits, type mismatches, etc.
- Do NOT flag style preferences (naming, spacing, line length).
- Do NOT flag missing documentation or comments.
- Do NOT suggest refactoring or restructuring.
- Each issue must be fixable in 1-5 lines of changed code.
- You must provide the EXACT fixed code for each issue.
- If the code is correct, return an empty array.
- Be precise: give exact line numbers (1-indexed), exact original
  text, and exact replacement text.
"""

# ── Single-file detection prompt ──────────────────────────────────────

DETECT_ERRORS_PROMPT = """\
{system}

Analyse the following {language} code and find small bugs/errors.

```{language}
{code}
```

{context_section}

Respond with a JSON array. Each element must have exactly these fields:
```json
[
  {{
    "line": <1-indexed line number where the error is>,
    "end_line": <1-indexed end line (same as line for single-line fixes)>,
    "original": "<exact text from the source that is wrong>",
    "replacement": "<exact corrected text>",
    "description": "<one-sentence explanation of the bug>",
    "category": "<one of: logic_error, null_safety, type_mismatch, missing_await, resource_leak, api_misuse, off_by_one, error_handling, variable_misuse, security, concurrency, other>",
    "severity": "<one of: critical, moderate, low>",
    "confidence": <0.0 to 1.0 — your confidence this is a real bug>
  }}
]
```

Return ONLY the JSON array, no markdown fences, no explanation.
If no errors found, return: []
"""

# ── Multi-file context-aware prompt ───────────────────────────────────

DETECT_ERRORS_WITH_CONTEXT_PROMPT = """\
{system}

You are reviewing `{file_path}` in a project. Other relevant files
are provided for context — use them to check imports, API contracts,
type definitions, and cross-file consistency.

**File under review** (`{file_path}`):
```{language}
{code}
```

{related_files_section}

{context_section}

Find small bugs/errors in `{file_path}` only. Use the related files
to verify correctness (e.g. does an imported function actually exist?
Are the argument types correct?).

Respond with a JSON array. Each element must have exactly these fields:
```json
[
  {{
    "line": <1-indexed line number>,
    "end_line": <1-indexed end line>,
    "original": "<exact wrong text>",
    "replacement": "<exact fix>",
    "description": "<one sentence>",
    "category": "<logic_error|null_safety|type_mismatch|missing_await|resource_leak|api_misuse|off_by_one|error_handling|variable_misuse|security|concurrency|other>",
    "severity": "<critical|moderate|low>",
    "confidence": <0.0–1.0>
  }}
]
```

Return ONLY the JSON array. If no errors found, return: []
"""

# ── Validation / second-opinion prompt ────────────────────────────────

VALIDATE_FIX_PROMPT = """\
{system}

A code analysis tool proposed the following fix. Your job is to
verify whether this fix is correct and safe to apply.

**File**: `{file_path}` ({language})

**Original code around the fix (lines {start_line}-{end_line})**:
```{language}
{surrounding_code}
```

**Proposed change**:
- Original: `{original}`
- Replacement: `{replacement}`
- Reason: {description}

Answer with a JSON object:
```json
{{
  "is_valid": true/false,
  "confidence": <0.0–1.0>,
  "reason": "<one sentence explaining your verdict>",
  "improved_replacement": "<if you have a better fix, put it here, else null>"
}}
```

Return ONLY the JSON object.
"""

# ── Batch detection for multiple files ────────────────────────────────

BATCH_DETECT_PROMPT = """\
{system}

Review the following files and find small bugs in each.

{files_section}

For each file where you find issues, include them in the response.
Respond with a JSON object keyed by file path:
```json
{{
  "path/to/file1.py": [
    {{
      "line": 10,
      "end_line": 10,
      "original": "...",
      "replacement": "...",
      "description": "...",
      "category": "...",
      "severity": "...",
      "confidence": 0.9
    }}
  ],
  "path/to/file2.js": []
}}
```

Return ONLY the JSON object.
"""


# ── Focused-range detection (selection / function scope) ──────────────

FOCUSED_DETECT_PROMPT = """\
{system}

The user selected lines {start_line}–{end_line} of `{file_path}` and
asked the AI to review that specific section.

**Full file** ({language}):
```{language}
{code}
```

**Focus area** (lines {start_line}–{end_line}):
```{language}
{focus_code}
```

{context_section}

Find bugs ONLY in the focus area (lines {start_line}–{end_line}).
You may use the rest of the file for context but only report issues
within the selected range.

Respond with a JSON array:
```json
[
  {{
    "line": <1-indexed, must be between {start_line} and {end_line}>,
    "end_line": <1-indexed>,
    "original": "<exact wrong text>",
    "replacement": "<exact fix>",
    "description": "<one sentence>",
    "category": "<logic_error|null_safety|type_mismatch|missing_await|resource_leak|api_misuse|off_by_one|error_handling|variable_misuse|security|concurrency|other>",
    "severity": "<critical|moderate|low>",
    "confidence": <0.0–1.0>
  }}
]
```

Return ONLY the JSON array. If no errors found, return: []
"""


# ── Runtime error / HMR compile-error fix prompt ──────────────────────

RUNTIME_ERROR_FIX_PROMPT = """\
{system}

The compiler/runtime reported errors in `{file_path}` ({language}).
Your job is to fix ALL of the reported errors. The diagnostics below
come directly from the compiler — they are real, not guesses.

**Source code** (`{file_path}`):
```{language}
{code}
```

**Compiler/runtime diagnostics:**
{diagnostics_section}

{error_output_section}

{context_section}

For each error, provide an exact fix. If one replacement fixes multiple
diagnostics, combine them into a single entry. Always match original
text EXACTLY (whitespace, indentation, etc.).

Respond with a JSON array:
```json
[
  {{
    "line": <1-indexed line from the diagnostic>,
    "end_line": <1-indexed end line>,
    "original": "<exact text from the source that causes the error>",
    "replacement": "<exact corrected text>",
    "description": "<what was wrong and how you fixed it>",
    "category": "<one of: syntax_error, type_mismatch, missing_import, undefined_reference, logic_error, api_misuse, missing_await, null_safety, other>",
    "severity": "critical",
    "confidence": <0.85 to 1.0 — these are real compiler errors, so be confident>
  }}
]
```

Return ONLY the JSON array. If you cannot determine a fix, return: []
"""


def _format_diagnostics(diagnostics: List[Dict[str, Any]]) -> str:
    """Format compiler diagnostics for prompt injection."""
    if not diagnostics:
        return "(no diagnostics provided)"
    parts = []
    for i, diag in enumerate(diagnostics, 1):
        severity = diag.get("severity", "error")
        message = diag.get("message", "unknown error")
        code = diag.get("code", "")
        loc = diag.get("location", {})
        line = loc.get("line", "?")
        col = loc.get("column", "?")
        file_ = loc.get("file", "")
        snippet = diag.get("codeSnippet", "")
        suggestions = diag.get("suggestions", [])

        header = f"{i}. [{severity.upper()}] {message}"
        if code:
            header += f" (code: {code})"
        if file_:
            header += f"\n   Location: {file_}:{line}:{col}"
        elif line != "?":
            header += f"\n   Line: {line}, Column: {col}"
        if snippet:
            header += f"\n   ```\n   {snippet}\n   ```"
        if suggestions:
            for s in suggestions:
                smsg = s.get("message", "")
                srep = s.get("replacement", "")
                header += f"\n   Suggestion: {smsg}"
                if srep:
                    header += f"  →  `{srep}`"
        parts.append(header)
    return "\n\n".join(parts)


def build_runtime_error_prompt(
    code: str,
    language: str,
    file_path: str = "untitled",
    diagnostics: Optional[List[Dict[str, Any]]] = None,
    error_output: Optional[str] = None,
    context_notes: Optional[List[str]] = None,
) -> str:
    """Build a prompt specifically for fixing compiler/runtime errors.

    Unlike build_detect_prompt() which asks "find bugs", this says
    "the compiler reported THESE errors — fix them."
    """
    diagnostics_section = _format_diagnostics(diagnostics or [])

    error_output_section = ""
    if error_output:
        error_output_section = (
            f"**Raw compiler/runtime output:**\n```\n{error_output[:6000]}\n```"
        )

    context_section = format_context_notes(context_notes or [])

    return RUNTIME_ERROR_FIX_PROMPT.format(
        system=AGENT_SYSTEM_PROMPT,
        code=code,
        language=language,
        file_path=file_path,
        diagnostics_section=diagnostics_section,
        error_output_section=error_output_section,
        context_section=context_section,
    )


# ── Helpers to format prompts ─────────────────────────────────────────

def format_related_files(files: List[Dict[str, str]]) -> str:
    """Format related files for context injection."""
    if not files:
        return ""
    sections = []
    for f in files:
        path = f.get("path", "unknown")
        content = f.get("content", "")
        lang = f.get("language", "")
        # Truncate large files to keep prompt manageable
        if len(content) > 8000:
            content = content[:4000] + "\n\n... (truncated) ...\n\n" + content[-2000:]
        sections.append(f"**`{path}`**:\n```{lang}\n{content}\n```")
    return "**Related files for context:**\n\n" + "\n\n".join(sections)


def format_context_notes(notes: List[str]) -> str:
    """Format additional context notes."""
    if not notes:
        return ""
    return "**Additional context:**\n" + "\n".join(f"- {n}" for n in notes)


def build_detect_prompt(
    code: str,
    language: str,
    file_path: str = "untitled",
    related_files: Optional[List[Dict[str, str]]] = None,
    context_notes: Optional[List[str]] = None,
) -> str:
    """Build the appropriate detection prompt."""
    context_section = format_context_notes(context_notes or [])

    if related_files:
        return DETECT_ERRORS_WITH_CONTEXT_PROMPT.format(
            system=AGENT_SYSTEM_PROMPT,
            code=code,
            language=language,
            file_path=file_path,
            related_files_section=format_related_files(related_files),
            context_section=context_section,
        )
    else:
        return DETECT_ERRORS_PROMPT.format(
            system=AGENT_SYSTEM_PROMPT,
            code=code,
            language=language,
            context_section=context_section,
        )


def build_validate_prompt(
    code: str,
    language: str,
    file_path: str,
    original: str,
    replacement: str,
    description: str,
    line: int,
    end_line: int,
    context_lines: int = 5,
) -> str:
    """Build a validation prompt for a proposed fix."""
    lines = code.split("\n")
    start = max(0, line - 1 - context_lines)
    end = min(len(lines), end_line + context_lines)
    surrounding = "\n".join(lines[start:end])

    return VALIDATE_FIX_PROMPT.format(
        system=AGENT_SYSTEM_PROMPT,
        file_path=file_path,
        language=language,
        start_line=start + 1,
        end_line=end,
        surrounding_code=surrounding,
        original=original,
        replacement=replacement,
        description=description,
    )


def build_batch_prompt(
    files: List[Dict[str, str]],
) -> str:
    """Build a batch detection prompt for multiple files."""
    sections = []
    for f in files:
        path = f.get("path", "unknown")
        content = f.get("content", "")
        lang = f.get("language", "")
        if len(content) > 10000:
            content = content[:5000] + "\n... (truncated) ...\n" + content[-3000:]
        sections.append(f"**`{path}`** ({lang}):\n```{lang}\n{content}\n```")

    return BATCH_DETECT_PROMPT.format(
        system=AGENT_SYSTEM_PROMPT,
        files_section="\n\n".join(sections),
    )


def build_focused_prompt(
    code: str,
    language: str,
    file_path: str,
    start_line: int,
    end_line: int,
    context_notes: Optional[List[str]] = None,
) -> str:
    """Build a focused detection prompt for a selected range."""
    lines = code.split("\n")
    # Extract the focused lines (1-indexed to 0-indexed)
    focus_lines = lines[max(0, start_line - 1):end_line]
    focus_code = "\n".join(focus_lines)
    context_section = format_context_notes(context_notes or [])

    return FOCUSED_DETECT_PROMPT.format(
        system=AGENT_SYSTEM_PROMPT,
        code=code,
        language=language,
        file_path=file_path,
        start_line=start_line,
        end_line=end_line,
        focus_code=focus_code,
        context_section=context_section,
    )

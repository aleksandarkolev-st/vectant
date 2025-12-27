from __future__ import annotations

from typing import Optional


_C_LIKE_LANGS = {
    "c",
    "cpp",
    "c++",
    "cc",
    "cxx",
    "h",
    "hpp",
    "hxx",
    "java",
    "javascript",
    "js",
    "typescript",
    "ts",
    "tsx",
    "jsx",
    "go",
    "rust",
    "rs",
    "swift",
    "kotlin",
    "kt",
    "c#",
    "cs",
    "php",
}

_PY_LIKE_LANGS = {
    "py",
    "python",
    "python3",
}


def _mask_range(buf: list[str], start: int, end: int) -> None:
    """Replace non-newline characters with spaces in buf[start:end]."""
    for j in range(start, end):
        if buf[j] != "\n":
            buf[j] = " "


def mask_comments(text: str, lang: Optional[str]) -> str:
    """
    Mask (not delete) comments in code, preserving string literals and
    preserving all original indices/newlines.

    This is designed for analysis pipelines where:
    - comments must not influence heuristics/LLM
    - but diagnostic locations must stay stable

    Supported comment syntaxes:
    - C-like: // line comments, /* block comments */
    - Python: # line comments

    Notes:
    - This intentionally does not try to be a full lexer.
    - It avoids treating comment markers inside string literals as comments.
    """

    if not text:
        return text

    language = (lang or "").strip().lower()
    is_c_like = language in _C_LIKE_LANGS
    is_py_like = language in _PY_LIKE_LANGS

    if not (is_c_like or is_py_like):
        # Unknown language: keep as-is to avoid breaking analysis.
        return text

    # Normalize newlines to \n for stable scanning while preserving content length.
    # We preserve original \r by treating it as part of the stream.
    s = text
    out = list(s)
    n = len(s)

    i = 0
    state = "code"  # code | sq | dq | bt | py_tsq | py_tdq

    def starts_with_at(prefix: str, idx: int) -> bool:
        return s.startswith(prefix, idx)

    while i < n:
        ch = s[i]

        if state == "code":
            if is_c_like:
                # line comment //...
                if ch == "/" and i + 1 < n and s[i + 1] == "/":
                    start = i
                    i += 2
                    while i < n and s[i] != "\n":
                        i += 1
                    _mask_range(out, start, i)
                    continue

                # block comment /* ... */
                if ch == "/" and i + 1 < n and s[i + 1] == "*":
                    start = i
                    i += 2
                    while i + 1 < n and not (s[i] == "*" and s[i + 1] == "/"):
                        i += 1
                    # include closing */ if present
                    if i + 1 < n:
                        i += 2
                    _mask_range(out, start, i)
                    continue

            if is_py_like:
                if ch == "#":
                    start = i
                    i += 1
                    while i < n and s[i] != "\n":
                        i += 1
                    _mask_range(out, start, i)
                    continue

            # strings
            if is_py_like and starts_with_at("'''", i):
                state = "py_tsq"
                i += 3
                continue
            if is_py_like and starts_with_at('"""', i):
                state = "py_tdq"
                i += 3
                continue

            if ch == "'":
                state = "sq"
                i += 1
                continue
            if ch == '"':
                state = "dq"
                i += 1
                continue
            if is_c_like and ch == "`":
                # JS/TS template string - treat as string (no comment parsing inside)
                state = "bt"
                i += 1
                continue

            i += 1
            continue

        if state in {"sq", "dq", "bt"}:
            quote = "'" if state == "sq" else ('"' if state == "dq" else "`")

            if ch == "\\":
                # skip escaped char
                i += 2
                continue

            if ch == quote:
                state = "code"
                i += 1
                continue

            i += 1
            continue

        if state in {"py_tsq", "py_tdq"}:
            end_delim = "'''" if state == "py_tsq" else '"""'
            if starts_with_at(end_delim, i):
                state = "code"
                i += 3
                continue

            if ch == "\\":
                i += 2
                continue

            i += 1
            continue

        # fallback
        i += 1

    return "".join(out)


def mask_comments_for_analysis(text: str, lang: Optional[str]) -> str:
    """Convenience wrapper for analysis callers."""
    return mask_comments(text, lang)

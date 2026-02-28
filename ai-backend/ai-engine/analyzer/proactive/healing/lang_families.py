"""
Centralised language family definitions.

Every rule that needs language dispatch should import from here
instead of defining its own set literals. This eliminates the
coupling risk of duplicated language identifiers across 38+ rule
modules.

If a new language identifier is added (e.g. "python3"), update it
here once and all rules pick it up automatically.
"""

from __future__ import annotations

from typing import FrozenSet

# ── Language families ──────────────────────────────────────────────

PYTHON: FrozenSet[str] = frozenset({
    "python", "py", "python3", "pyw",
})

JAVASCRIPT: FrozenSet[str] = frozenset({
    "javascript", "js", "jsx", "mjs", "cjs",
})

TYPESCRIPT: FrozenSet[str] = frozenset({
    "typescript", "ts", "tsx", "mts", "cts",
})

JS_FAMILY: FrozenSet[str] = JAVASCRIPT | TYPESCRIPT

C_FAMILY: FrozenSet[str] = frozenset({
    "c", "cpp", "c++", "cxx", "cc", "h", "hpp", "hxx",
})

JAVA: FrozenSet[str] = frozenset({
    "java",
})

GO: FrozenSet[str] = frozenset({
    "go", "golang",
})

RUST: FrozenSet[str] = frozenset({
    "rust", "rs",
})

CSHARP: FrozenSet[str] = frozenset({
    "csharp", "cs", "c#",
})

RUBY: FrozenSet[str] = frozenset({
    "ruby", "rb",
})

PHP: FrozenSet[str] = frozenset({
    "php",
})

SWIFT: FrozenSet[str] = frozenset({
    "swift",
})

KOTLIN: FrozenSet[str] = frozenset({
    "kotlin", "kt", "kts",
})

SHELL: FrozenSet[str] = frozenset({
    "shell", "sh", "bash", "zsh", "fish", "powershell", "ps1",
})

HTML: FrozenSet[str] = frozenset({
    "html", "htm", "xhtml",
})

CSS: FrozenSet[str] = frozenset({
    "css", "scss", "sass", "less",
})

MARKUP: FrozenSet[str] = frozenset({
    "markdown", "md", "yaml", "yml", "toml", "json", "xml",
})

# ── Composite sets for common checks ──────────────────────────────

# Languages that use semicolons as statement terminators
SEMICOLON_LANGS: FrozenSet[str] = (
    JS_FAMILY | C_FAMILY | JAVA | CSHARP | PHP | RUST | KOTLIN | SWIFT
)

# Languages that use colons for block starters
COLON_LANGS: FrozenSet[str] = PYTHON

# Languages that use // for line comments
SLASH_COMMENT_LANGS: FrozenSet[str] = (
    JS_FAMILY | C_FAMILY | JAVA | GO | RUST | CSHARP | SWIFT | KOTLIN | PHP
)

# Languages that use # for line comments
HASH_COMMENT_LANGS: FrozenSet[str] = PYTHON | RUBY | SHELL


def normalise(language: str) -> str:
    """Lowercase and strip a language identifier for matching."""
    return language.strip().lower()


def is_in(language: str, family: FrozenSet[str]) -> bool:
    """Check if a language identifier belongs to a family."""
    return normalise(language) in family

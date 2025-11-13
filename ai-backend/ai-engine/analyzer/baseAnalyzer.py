from __future__ import annotations

from typing import Tuple


class BaseAnalyzer:
    """Base class all language specific analyzers must extend."""

    language: str = "generic"
    aliases: Tuple[str, ...] = ()

    def analyze(self, code: str):
        raise NotImplementedError("Analyzer must implement analyze()")

    @classmethod
    def identifier(cls) -> str:
        """Returns the canonical identifier for the analyzer's language."""
        return cls.language.lower()

    @classmethod
    def all_names(cls) -> Tuple[str, ...]:
        return (cls.language.lower(),) + tuple(alias.lower() for alias in cls.aliases)

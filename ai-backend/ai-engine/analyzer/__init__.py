from __future__ import annotations

from functools import lru_cache
from typing import Dict, Iterable, Tuple, Type

from analyzer.baseAnalyzer import BaseAnalyzer
from analyzer.cppAnalyzer import CppAnalyzer
from analyzer.pythonAnalyzer import PythonAnalyzer
from analyzer.tsAnalyzer import TypeScriptAnalyzer

AnalyzerType = Type[BaseAnalyzer]

_ANALYZER_TYPES: Tuple[AnalyzerType, ...] = (
    PythonAnalyzer,
    TypeScriptAnalyzer,
    CppAnalyzer,
)

_LANGUAGE_TO_ANALYZER: Dict[str, AnalyzerType] = {}
for analyzer_cls in _ANALYZER_TYPES:
    for name in analyzer_cls.all_names():
        _LANGUAGE_TO_ANALYZER[name] = analyzer_cls


def resolve_language(lang: str) -> str:
    normalized = (lang or "").strip().lower()
    analyzer_cls = _LANGUAGE_TO_ANALYZER.get(normalized)
    return analyzer_cls.identifier() if analyzer_cls else normalized


def supported_languages() -> Iterable[str]:
    return sorted({cls.identifier() for cls in _ANALYZER_TYPES})


@lru_cache(maxsize=len(_ANALYZER_TYPES))
def get_analyzer(lang: str) -> BaseAnalyzer:
    normalized = (lang or "").strip().lower()
    analyzer_cls = _LANGUAGE_TO_ANALYZER.get(normalized)
    if analyzer_cls is None:
        raise ValueError(
            f"Unsupported language '{lang}'. "
            f"Supported languages: {', '.join(supported_languages())}"
        )
    return analyzer_cls()


__all__ = ["get_analyzer", "resolve_language", "supported_languages"]

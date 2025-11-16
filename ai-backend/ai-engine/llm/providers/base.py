from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Optional


class AiProvider(ABC):
    name: str = "base_provider"
    _client: Optional[object] = None

    def __init__(self, name: str):
        self.name = name

    @abstractmethod
    def _get_client(self) -> object:
        pass

    @abstractmethod
    def ask_llm(self, code: str, lang: str, prompt: str = None) -> str:
        pass
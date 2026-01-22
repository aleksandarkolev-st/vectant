from __future__ import annotations

import logging
import re
from typing import Optional

from .types import QueryIntent
from ..core.config import get_config


logger = logging.getLogger("code_intel.routing.intent")


_INTENT_KEYWORDS = {
    QueryIntent.DEBUG: ["error", "bug", "fix", "exception", "stacktrace", "null", "undefined", "crash"],
    QueryIntent.REFACTOR: ["refactor", "rename", "move", "cleanup", "simplify", "extract"],
    QueryIntent.GENERATE: ["add", "implement", "create", "generate", "build", "scaffold"],
    QueryIntent.EXPLAIN: ["explain", "what does", "how does", "why", "describe"],
    QueryIntent.NAVIGATE: ["where", "find", "locate", "entry point", "file"],
    QueryIntent.TEST: ["test", "spec", "failing", "unit", "integration"],
    QueryIntent.PERFORMANCE: ["slow", "performance", "latency", "optimize", "hot path"],
}


class IntentClassifier:
    def __init__(self):
        self.config = get_config()

    def classify(self, query: str, context: Optional[str] = None) -> QueryIntent:
        intent = self._heuristic_intent(query)
        if self.config.routing.use_gemini_intent:
            try:
                gemini_intent = self._gemini_intent(query, context)
                if gemini_intent:
                    return gemini_intent
            except Exception as e:
                logger.debug(f"Gemini intent classification failed: {e}")
        return intent

    def _heuristic_intent(self, query: str) -> QueryIntent:
        q = (query or "").lower()
        for intent, keywords in _INTENT_KEYWORDS.items():
            if any(k in q for k in keywords):
                return intent
        return QueryIntent.UNKNOWN

    def _gemini_intent(self, query: str, context: Optional[str] = None) -> Optional[QueryIntent]:
        try:
            import google.generativeai as genai
        except Exception as e:
            logger.debug(f"Gemini client unavailable: {e}")
            return None

        api_key = self.config.gemini_api_key
        if not api_key:
            return None

        genai.configure(api_key=api_key)
        model_name = self.config.routing.gemini_intent_model
        model = genai.GenerativeModel(model_name)

        prompt = (
            "Classify the user query intent into one of: debug, refactor, generate, explain, navigate, test, performance, unknown. "
            "Return ONLY the label.\n\n"
            f"Query: {query}\n"
        )
        if context:
            prompt += f"Context: {context[:2000]}\n"

        response = model.generate_content(prompt)
        text = (response.text or "").strip().lower()
        text = re.sub(r"[^a-z]", "", text)
        for intent in QueryIntent:
            if text == intent.value:
                return intent
        return None

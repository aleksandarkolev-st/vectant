from __future__ import annotations

import logging
from typing import Dict, List, Optional

from ..core.config import get_config
from ..core.types import ModuleSummary, SemanticChunk, FileSummary


logger = logging.getLogger("code_intel.summaries.module")


class ModuleSummarizer:
    def __init__(self):
        self.config = get_config()

    def summarize(
        self,
        module_path: str,
        file_summaries: Dict[str, FileSummary],
        chunks: List[SemanticChunk],
        content_hash: str,
    ) -> Optional[ModuleSummary]:
        if not self.config.summary.enable_llm_summaries:
            return None

        try:
            import google.generativeai as genai
        except Exception as e:
            logger.warning(f"Gemini unavailable for module summaries: {e}")
            return None

        if not self.config.gemini_api_key:
            return None

        genai.configure(api_key=self.config.gemini_api_key)
        model = genai.GenerativeModel(self.config.summary.gemini_summary_model)

        # Build prompt
        file_lines = []
        for path, fs in list(file_summaries.items())[:12]:
            file_lines.append(f"- {path}: {fs.responsibility}")
            if fs.public_api:
                file_lines.append(f"  APIs: {', '.join(fs.public_api[:5])}")

        key_symbols = []
        for ch in chunks[:50]:
            if ch.metadata.qualified_name:
                key_symbols.append(ch.metadata.qualified_name)
            elif ch.symbol_name:
                key_symbols.append(ch.symbol_name)
        key_symbols = list(dict.fromkeys(key_symbols))[:20]

        dependencies = []
        for ch in chunks[:50]:
            for imp in ch.metadata.imports_used:
                dependencies.append(imp)
        dependencies = list(dict.fromkeys(dependencies))[:15]

        prompt = (
            "Summarize this module/subsystem for an AI coding assistant. "
            "Focus on purpose, key responsibilities, entry points, and important relationships. "
            "Use bullet points and keep under 12 lines.\n\n"
            f"Module: {module_path}\n\n"
            "Files:\n" + "\n".join(file_lines) + "\n\n"
            "Key symbols:\n" + "\n".join(f"- {s}" for s in key_symbols) + "\n\n"
            "Dependencies:\n" + "\n".join(f"- {d}" for d in dependencies) + "\n"
        )

        response = model.generate_content(prompt)
        text = (response.text or "").strip()
        if not text:
            return None

        return ModuleSummary(
            module_path=module_path,
            summary=text,
            key_symbols=key_symbols,
            dependencies=dependencies,
            content_hash=content_hash,
            chunking_version=self.config.indexer.chunking_version,
        )

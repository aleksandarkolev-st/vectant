# PROTOTYPING AI ENGINE WITH PYTHON, LATER SWITCH TO RUST
from __future__ import annotations

from typing import List, Optional
import requests
import json
import sys
import os
import asyncio

from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from analyzer import get_analyzer
from analyzer import supported_languages

from llm.providers import get_provider
from llm.prompts import SPLIT_GUI_PROMPT

# Proactive Analysis imports
from analyzer.proactive import (
    ProactiveAnalyzer,
    AnalysisResult,
    AnalysisTier,
)
from analyzer.proactive.types import AnalysisRequest, FileContext
from analyzer.proactive.cache import AnalysisCache

app = FastAPI()

# Initialize proactive analyzer with shared cache
_analysis_cache = AnalysisCache(max_entries=2000, max_age_seconds=3600)
_proactive_analyzer_no_ai: Optional[ProactiveAnalyzer] = None


def get_proactive_analyzer(llm_provider=None) -> ProactiveAnalyzer:
    """
    Get or create the proactive analyzer.
    
    If llm_provider is supplied, always creates a fresh analyzer with AI enabled.
    If llm_provider is None, returns a cached analyzer with AI disabled (fast path).
    """
    global _proactive_analyzer_no_ai
    
    if llm_provider is not None:
        # AI tier requested - create fresh analyzer with provider
        return ProactiveAnalyzer(
            cache=_analysis_cache,
            llm_provider=llm_provider,
            enable_ai=True,
            ai_min_confidence=0.6,
        )
    
    # No AI - use cached analyzer for speed
    if _proactive_analyzer_no_ai is None:
        _proactive_analyzer_no_ai = ProactiveAnalyzer(
            cache=_analysis_cache,
            llm_provider=None,
            enable_ai=False,
            ai_min_confidence=0.6,
        )
    return _proactive_analyzer_no_ai


class FileModel(BaseModel):
    path: Optional[str] = None
    name: Optional[str] = None
    content: str


class AnalyzeRequest(BaseModel):
    code: str
    lang: str
    files: Optional[List[FileModel]] = None
    focus: Optional[str] = None


class AnalyzeAiRequest(BaseModel):
    code: str
    lang: str
    prompt: str = None
    mode: str = None
    files: Optional[List[FileModel]] = None
    focus: Optional[str] = None
    model: Optional[str] = None
    api_key: Optional[str] = None


class ProactiveAnalysisRequest(BaseModel):
    """Request for proactive code analysis."""
    code: str
    lang: str
    file_path: Optional[str] = "untitled"
    related_files: Optional[List[FileModel]] = None
    tiers: Optional[List[str]] = None  # "static", "semantic", "ai"
    include_ai: Optional[bool] = True
    max_diagnostics: Optional[int] = 50
    model: Optional[str] = None
    api_key: Optional[str] = None


@app.post("/analyze/static")
def analyze_code(req: AnalyzeRequest):
    try:
        analyzer = get_analyzer(req.lang)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    canonical_lang = analyzer.identifier()
    static_results = analyzer.analyze(req.code)

    return {
        "static_analysis": static_results,
        "lang": canonical_lang,
    }


@app.post("/analyze/proactive")
async def analyze_proactive(req: ProactiveAnalysisRequest):
    """
    Proactive code analysis endpoint.
    
    Runs multi-tier analysis (static, semantic, AI) to detect
    potential errors before compilation.
    
    Returns diagnostics from all tiers with severity, location,
    and suggested fixes.
    """
    def select_provider():
        if req.api_key:
            model_name = (req.model or '').lower()
            if 'gemini' in model_name:
                return get_provider(provider_name='gemini', use_custom=True)
            return get_provider(provider_name='chatgpt', use_custom=True)
        return get_provider()
    
    # Determine which tiers to run
    tiers = []
    if req.tiers:
        tier_map = {
            'static': AnalysisTier.STATIC,
            'semantic': AnalysisTier.SEMANTIC,
            'ai': AnalysisTier.AI,
        }
        tiers = [tier_map[t.lower()] for t in req.tiers if t.lower() in tier_map]
    else:
        # Default: run all tiers
        tiers = [AnalysisTier.STATIC, AnalysisTier.SEMANTIC]
        if req.include_ai:
            tiers.append(AnalysisTier.AI)
    
    # Build file context
    file_context = FileContext(
        path=req.file_path or "untitled",
        content=req.code,
        language=req.lang,
    )
    
    # Build related files context
    related_files = []
    if req.related_files:
        for rf in req.related_files:
            related_files.append(FileContext(
                path=rf.path or rf.name or f"file-{len(related_files)}",
                content=rf.content,
                language=req.lang,
            ))
    
    # Create analysis request
    analysis_request = AnalysisRequest(
        file=file_context,
        related_files=related_files,
        tiers=tiers,
        max_diagnostics=req.max_diagnostics or 50,
        include_fixes=True,
    )
    
    # Get analyzer with provider for AI tier
    provider = select_provider() if AnalysisTier.AI in tiers else None
    analyzer = get_proactive_analyzer(llm_provider=provider)
    
    try:
        result = await analyzer.analyze(analysis_request)
        return result.to_dict()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Analysis failed: {str(e)}")


@app.post("/analyze/proactive/quick")
async def analyze_proactive_quick(req: ProactiveAnalysisRequest):
    """
    Quick proactive analysis (static + semantic only).
    
    Optimized for real-time feedback during typing.
    Typically completes in < 200ms.
    """
    file_context = FileContext(
        path=req.file_path or "untitled",
        content=req.code,
        language=req.lang,
    )
    
    analyzer = get_proactive_analyzer()
    
    try:
        result = await analyzer.analyze_quick(file_context)
        return result.to_dict()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Quick analysis failed: {str(e)}")


@app.get("/analyze/proactive/cache/stats")
async def get_cache_stats():
    """Get proactive analysis cache statistics."""
    analyzer = get_proactive_analyzer()
    return await analyzer.get_cache_stats()


@app.post("/analyze/proactive/cache/clear")
async def clear_cache():
    """Clear the proactive analysis cache."""
    analyzer = get_proactive_analyzer()
    await analyzer.clear_cache()
    return {"status": "ok", "message": "Cache cleared"}


@app.post("/analyze/ai")
async def analyze_code_ai(req: AnalyzeAiRequest):
    def select_provider_name() -> str | None:
        if req.api_key:
            model_name = (req.model or '').lower()
            if 'gemini' in model_name:
                return 'gemini'
            # default to OpenAI when a custom key is present but model is not explicitly Gemini
            return 'chatgpt'
        return None

    provider = get_provider(provider_name=select_provider_name(), use_custom=bool(req.api_key))
    try:
        ai_suggestion = await provider.ask_llm(
            req.code,
            req.lang,
            req.prompt,
            mode=req.mode,
            files=req.files,
            focus=req.focus,
            model=req.model,
            api_key=req.api_key,
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

    return {
        "ai_suggestion": ai_suggestion,
        "lang": req.lang,
    }


@app.post("/refactor/split")
async def refactor_split(req: AnalyzeAiRequest):
    def select_provider_name() -> str | None:
        if req.api_key:
            model_name = (req.model or '').lower()
            if 'gemini' in model_name:
                return 'gemini'
            return 'chatgpt'
        return None

    provider = get_provider(provider_name=select_provider_name(), use_custom=bool(req.api_key))
    
    prompt = SPLIT_GUI_PROMPT
    if req.prompt:
        prompt += "\nUser Instructions: " + req.prompt
        
    try:
        ai_suggestion = await provider.ask_llm(
            req.code,
            req.lang,
            prompt,
            mode="split",
            files=req.files,
            focus=req.focus,
            model=req.model,
            api_key=req.api_key,
        )
        print(f"--- AI SPLIT OUTPUT START ---\n{ai_suggestion}\n--- AI SPLIT OUTPUT END ---")
    except Exception as e:
        print(f"AI Split Error: {e}")
        raise HTTPException(status_code=400, detail=str(e))

    return {
        "result": ai_suggestion,
        "lang": req.lang,
    }

@app.post("/refactor/split_file")
def split_file(file_path: str, api_url: str = "http://localhost:8000/refactor/split"):
    if not os.path.exists(file_path):
        print(f"File not found: {file_path}")
        return

    with open(file_path, 'r') as f:
        content = f.read()
    
    ext = os.path.splitext(file_path)[1][1:]
    lang = "cpp"
    if ext == "rs": lang = "rust"
    elif ext == "ts": lang = "typescript"
    elif ext == "js": lang = "javascript"
    elif ext == "py": lang = "python"

    payload = {
        "code": content,
        "lang": lang,
        "mode": "split"
    }
    
    print(f"Sending {file_path} to AI for analysis...")
    try:
        response = requests.post(api_url, json=payload)
        response.raise_for_status()
        result = response.json().get("result")
        
        # Parse the JSON string returned by the LLM
        if isinstance(result, str):
            # The LLM might return markdown code blocks, so we need to clean it
            if "```json" in result:
                result = result.split("```json")[1].split("```")[0].strip()
            elif "```" in result:
                result = result.split("```")[1].split("```")[0].strip()
            
            try:
                data = json.loads(result)
            except json.JSONDecodeError:
                print("Failed to parse JSON response from AI:")
                print(result)
                return
        else:
            data = result
        
        # Save files
        for key, module in data.items():
            if isinstance(module, dict) and "filename" in module and "content" in module:
                fname = module["filename"]
                print(f"Writing {fname}...")
                with open(fname, 'w') as f:
                    f.write(module["content"])
                    
        print("Split complete!")
        if "explanation" in data:
            print("\nExplanation:")
            print(data["explanation"])
            
    except Exception as e:
        print(f"Error: {e}")


@app.get("/")
def root():
    return {
        "status": "ai-engine-online",
        "supported_languages": list(supported_languages()),
    }


if __name__ == "__main__":
    if len(sys.argv) > 1:
        split_file(sys.argv[1])
    else:
        import uvicorn
        # Bind to 0.0.0.0 to allow access from WSL/Containers
        uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)

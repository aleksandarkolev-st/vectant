# PROTOTYPING AI ENGINE WITH PYTHON, LATER SWITCH TO RUST
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from analyzer import get_analyzer
from analyzer import supported_languages

from llm.providers import get_provider

app = FastAPI()


class AnalyzeRequest(BaseModel):
    code: str
    lang: str


class AnalyzeAiRequest(BaseModel):
    code: str
    lang: str
    prompt: str = None


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

@app.post("/analyze/ai")
def analyze_code_ai(req: AnalyzeAiRequest):
    provider = get_provider()
    ai_suggestion = provider.ask_llm(req.code, req.lang, req.prompt)

    return {
        "ai_suggestion": ai_suggestion,
        "lang": req.lang,
    }


@app.get("/")
def root():
    return {
        "status": "ai-engine-online",
        "supported_languages": list(supported_languages()),
    }

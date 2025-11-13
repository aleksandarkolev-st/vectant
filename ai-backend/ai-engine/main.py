# PROTOTYPING AI ENGINE WITH PYTHON, LATER SWITCH TO RUST
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from analyzer import get_analyzer, supported_languages
from llm.provider import ask_llm

app = FastAPI()


class AnalyzeRequest(BaseModel):
    code: str
    lang: str


@app.post("/analyze")
def analyze_code(req: AnalyzeRequest):
    try:
        analyzer = get_analyzer(req.lang)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    canonical_lang = analyzer.identifier()
    static_results = analyzer.analyze(req.code)
    ai_suggestion = ask_llm(req.code, canonical_lang)

    return {
        "static_analysis": static_results,
        "ai_suggestion": ai_suggestion,
        "lang": canonical_lang,
    }


@app.get("/")
def root():
    return {
        "status": "ai-engine-online",
        "supported_languages": list(supported_languages()),
    }

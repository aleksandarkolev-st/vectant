# PROTOTYPING AI ENGINE WITH PYTHON, LATER SWITCH TO RUST
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from llm.provider import ask_llm

app = FastAPI()


class AnalyzeRequest(BaseModel):
    code: str
    lang: str


@app.post("/analyze")
def analyze_code(req: AnalyzeRequest):
    ai_suggestion = ask_llm(req.code, req.lang)

    return {
        "ai_suggestion": ai_suggestion,
        "lang": req.lang,
    }


@app.get("/")
def root():
    return {
        "status": "ai-engine-online",
        #"supported_languages": list(supported_languages()),
    }

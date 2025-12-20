# PROTOTYPING AI ENGINE WITH PYTHON, LATER SWITCH TO RUST
from __future__ import annotations

from typing import List, Optional
import requests
import json
import sys
import os
import asyncio
import time

from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from analyzer import get_analyzer
from analyzer import supported_languages

from llm.providers import get_provider
from llm.prompts import SPLIT_GUI_PROMPT
from llm.structural_prompts import (
    format_delta_addition_prompt,
    format_delta_deletion_prompt,
    inject_delta_into_code,
    apply_deletion_delta,
)

# New imports for enhanced architecture
from job_queue import (
    PriorityJobQueue, JobType, JobPriority, JobBudget, 
    JobWorker, get_queue
)
from verifier import AIOutputVerifier, get_verifier, VerificationStatus
from streaming import (
    StreamingManager, get_streaming_manager, 
    OpenAIStreamer, GeminiStreamer, StreamingStatus
)
from provenance import (
    ProvenanceTracker, get_provenance_tracker,
    ChangeType, VerificationStatus as ProvVerificationStatus, track_ai_call
)

app = FastAPI()


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


# ============================================================
# ENHANCED API ENDPOINTS
# ============================================================

class VerifiedAiRequest(AnalyzeAiRequest):
    """Request with verification options."""
    verify: bool = True
    auto_repair: bool = True
    session_id: Optional[str] = None


@app.post("/analyze/ai/verified")
async def analyze_code_ai_verified(req: VerifiedAiRequest):
    """
    AI analysis with verification and provenance tracking.
    
    This endpoint:
    1. Tracks provenance of the request
    2. Calls AI provider for analysis
    3. Verifies output for invariants
    4. Auto-repairs if possible
    5. Returns verified result with provenance
    """
    start_time = time.time()
    tracker = get_provenance_tracker()
    verifier = get_verifier()
    
    # Create provenance record
    provenance_id = track_ai_call(
        change_type=ChangeType.ANALYSIS if req.mode != "refactor" else ChangeType.REFACTOR,
        original_code=req.code,
        prompt=req.prompt or "",
        target_file=req.focus,
        target_language=req.lang,
        session_id=req.session_id,
    )
    
    def select_provider_name() -> str | None:
        if req.api_key:
            model_name = (req.model or '').lower()
            if 'gemini' in model_name:
                return 'gemini'
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
        
        # Update provenance with model info
        latency_ms = (time.time() - start_time) * 1000
        tracker.update_model_info(
            provenance_id,
            provider=select_provider_name() or "default",
            model_name=req.model or "default",
            temperature=0.2,
            max_tokens=4096,
            latency_ms=latency_ms,
        )
        tracker.update_output(provenance_id, ai_suggestion)
        
    except Exception as e:
        tracker.mark_rejected(provenance_id, f"AI error: {e}")
        raise HTTPException(status_code=400, detail=str(e))

    # Verify output
    verification_result = None
    if req.verify:
        verification_result = verifier.verify(
            ai_suggestion,
            original_code=req.code,
            lang=req.lang,
        )
        
        # Update provenance with verification
        tracker.update_verification(
            provenance_id,
            status=ProvVerificationStatus(verification_result.status.value),
            violations=[v.message for v in verification_result.violations],
            original_hash=verification_result.original_hash,
            verified_hash=verification_result.verified_hash,
            auto_repaired=verification_result.repaired_output is not None,
            duration_ms=verification_result.duration_ms,
        )
        
        # Use repaired output if available
        if verification_result.repaired_output:
            ai_suggestion = verification_result.repaired_output
        
        # Reject if verification failed
        if not verification_result.passed:
            tracker.mark_rejected(provenance_id, "Verification failed")
            return {
                "ai_suggestion": None,
                "lang": req.lang,
                "verification": verification_result.to_dict(),
                "provenance_id": provenance_id,
                "error": "Output failed verification",
            }
    
    tracker.mark_accepted(provenance_id)
    
    return {
        "ai_suggestion": ai_suggestion,
        "lang": req.lang,
        "verification": verification_result.to_dict() if verification_result else None,
        "provenance_id": provenance_id,
    }


@app.post("/refactor/split/verified")
async def refactor_split_verified(req: VerifiedAiRequest):
    """
    Split refactoring with verification.
    
    Verifies that:
    1. All modules have valid structure
    2. Combined exports match original
    3. Each file is syntactically valid
    """
    start_time = time.time()
    tracker = get_provenance_tracker()
    verifier = get_verifier()
    
    provenance_id = track_ai_call(
        change_type=ChangeType.SPLIT,
        original_code=req.code,
        prompt=req.prompt or "",
        target_file=req.focus,
        target_language=req.lang,
        session_id=req.session_id,
    )
    
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
        
        latency_ms = (time.time() - start_time) * 1000
        tracker.update_model_info(
            provenance_id,
            provider=select_provider_name() or "default",
            model_name=req.model or "default",
            temperature=0.2,
            max_tokens=8192,
            latency_ms=latency_ms,
        )
        tracker.update_output(provenance_id, ai_suggestion)
        
    except Exception as e:
        tracker.mark_rejected(provenance_id, f"AI error: {e}")
        raise HTTPException(status_code=400, detail=str(e))

    # Parse and verify split result
    try:
        # Clean up markdown if present
        result_str = ai_suggestion
        if "```json" in result_str:
            result_str = result_str.split("```json")[1].split("```")[0].strip()
        elif "```" in result_str:
            result_str = result_str.split("```")[1].split("```")[0].strip()
        
        split_result = json.loads(result_str)
        
        if req.verify:
            verification_result = verifier.verify_split_result(
                split_result,
                original_code=req.code,
                lang=req.lang,
            )
            
            tracker.update_verification(
                provenance_id,
                status=ProvVerificationStatus(verification_result.status.value),
                violations=[v.message for v in verification_result.violations],
                original_hash=verification_result.original_hash,
                verified_hash=verification_result.verified_hash,
                duration_ms=verification_result.duration_ms,
            )
            
            if not verification_result.passed:
                tracker.mark_rejected(provenance_id, "Split verification failed")
                return {
                    "result": None,
                    "lang": req.lang,
                    "verification": verification_result.to_dict(),
                    "provenance_id": provenance_id,
                    "error": "Split output failed verification",
                }
        
        tracker.mark_accepted(provenance_id)
        
        return {
            "result": split_result,
            "lang": req.lang,
            "verification": verification_result.to_dict() if req.verify else None,
            "provenance_id": provenance_id,
        }
        
    except json.JSONDecodeError as e:
        tracker.mark_rejected(provenance_id, f"Invalid JSON: {e}")
        return {
            "result": None,
            "raw_output": ai_suggestion,
            "lang": req.lang,
            "provenance_id": provenance_id,
            "error": f"Failed to parse split result: {e}",
        }


class JobSubmitRequest(BaseModel):
    """Request to submit a job to the queue."""
    job_type: str  # static, ai_analyze, ai_refactor, ai_generate
    payload: dict
    priority: str = "normal"  # critical, high, normal, low, bulk
    budget_time_seconds: Optional[float] = None
    budget_tokens: Optional[int] = None


@app.post("/queue/submit")
async def submit_job(req: JobSubmitRequest):
    """Submit a job to the priority queue."""
    queue = get_queue()
    
    # Map string to enum
    job_type_map = {
        "static": JobType.STATIC,
        "ai_analyze": JobType.AI_ANALYZE,
        "ai_refactor": JobType.AI_REFACTOR,
        "ai_generate": JobType.AI_GENERATE,
    }
    
    priority_map = {
        "critical": JobPriority.CRITICAL,
        "high": JobPriority.HIGH,
        "normal": JobPriority.NORMAL,
        "low": JobPriority.LOW,
        "bulk": JobPriority.BULK,
    }
    
    job_type = job_type_map.get(req.job_type, JobType.AI_ANALYZE)
    priority = priority_map.get(req.priority, JobPriority.NORMAL)
    
    budget = None
    if req.budget_time_seconds or req.budget_tokens:
        budget = JobBudget(
            max_time_seconds=req.budget_time_seconds or 30.0,
            max_tokens=req.budget_tokens or 4096,
        )
    
    job_id = await queue.submit(job_type, req.payload, priority, budget)
    
    return {"job_id": job_id, "status": "queued"}


@app.get("/queue/status/{job_id}")
async def get_job_status(job_id: str):
    """Get status of a queued job."""
    queue = get_queue()
    job = await queue.get_job(job_id)
    
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    
    return {
        "job_id": job.job_id,
        "status": "running" if job.started_at else "queued",
        "created_at": job.created_at,
        "started_at": job.started_at,
        "completed_at": job.completed_at,
        "result": job.result,
        "error": job.error,
    }


@app.post("/queue/cancel/{job_id}")
async def cancel_job(job_id: str):
    """Cancel a queued job."""
    queue = get_queue()
    cancelled = await queue.cancel(job_id)
    
    return {"cancelled": cancelled}


@app.get("/queue/stats")
async def get_queue_stats():
    """Get queue statistics."""
    queue = get_queue()
    stats = await queue.get_stats()
    return stats.model_dump()


@app.get("/provenance/{record_id}")
async def get_provenance(record_id: str):
    """Get provenance record for an AI change."""
    tracker = get_provenance_tracker()
    record = tracker.get_record(record_id)
    
    if not record:
        raise HTTPException(status_code=404, detail="Provenance record not found")
    
    return record.to_dict()


@app.get("/provenance/file/{file_path:path}")
async def get_file_provenance(file_path: str):
    """Get all provenance records for a file."""
    tracker = get_provenance_tracker()
    records = tracker.get_records_for_file(file_path)
    return [r.to_dict() for r in records]


@app.get("/provenance/stats")
async def get_provenance_stats():
    """Get provenance statistics."""
    tracker = get_provenance_tracker()
    return tracker.get_statistics()


# ============================================================
# FAST STRUCTURAL UPDATE ENDPOINTS (for HMR)
# ============================================================

class StructuralUpdateRequest(BaseModel):
    """Request for fast structural updates (add/remove elements)."""
    update_type: str  # "addition", "deletion"
    changes_description: str = ""  # What changed (for addition/deletion)
    core_content: str
    gui_content: str
    shared_content: str
    # Existing cached split result to inject delta into
    cached_result: Optional[dict] = None
    model: Optional[str] = None
    api_key: Optional[str] = None


@app.post("/refactor/delta")
async def refactor_delta(req: StructuralUpdateRequest):
    """
    Delta-based code translation endpoint for fast HMR.
    
    Instead of regenerating all code:
    1. Keeps existing working code (with guardrails applied)
    2. Takes the X11 delta the user wrote
    3. Asks AI to TRANSLATE that X11 code to SDL2
    4. Injects the translated SDL2 code into the existing modules
    
    Uses Gemini by default for fast ~2-3s response vs ~18s for full split.
    """
    start_time = time.time()
    
    # Always use Gemini for delta operations (fast and efficient)
    provider = get_provider(provider_name='gemini', use_custom=bool(req.api_key))
    
    try:
        if req.update_type == "addition":
            print(f"[Delta] Translating X11 code to SDL2:\n{req.changes_description[:200]}...")
            
            # Generate the translation prompt - AI translates X11 -> SDL2
            prompt = format_delta_addition_prompt(
                req.changes_description,
                req.core_content,
                req.gui_content,
                req.shared_content
            )
            
            # Call AI to translate X11 to SDL2
            ai_response = await provider.ask_llm(
                prompt,
                "cpp",
                None,
                mode="delta",
                model=req.model or "gemini-2.5-flash-lite",
                api_key=req.api_key,
            )
            
            print(f"[Delta] SDL2 translation:\n{ai_response}")
            
            # Parse the delta JSON from AI response
            delta = _parse_delta_json(ai_response)
            
            # If we have a cached result, inject the delta into it
            if req.cached_result:
                updated_result = inject_delta_into_code(req.cached_result, delta)
                elapsed = time.time() - start_time
                print(f"[Delta Addition] completed in {elapsed:.2f}s")
                
                return {
                    "result": updated_result,
                    "delta": delta,
                    "update_type": "addition",
                    "elapsed_seconds": elapsed
                }
            else:
                # Return just the delta if no cached result to inject into
                elapsed = time.time() - start_time
                return {
                    "delta": delta,
                    "update_type": "addition", 
                    "elapsed_seconds": elapsed
                }
                
        elif req.update_type == "deletion":
            # Generate deletion prompt
            prompt = format_delta_deletion_prompt(req.changes_description)
            
            ai_response = await provider.ask_llm(
                prompt,
                "cpp",
                None,
                mode="delta",
                model=req.model or "gemini-2.5-flash-lite",
                api_key=req.api_key,
            )
            
            delta = _parse_delta_json(ai_response)
            
            if req.cached_result:
                updated_result = apply_deletion_delta(req.cached_result, delta)
                elapsed = time.time() - start_time
                print(f"[Delta Deletion] completed in {elapsed:.2f}s")
                
                return {
                    "result": updated_result,
                    "delta": delta,
                    "update_type": "deletion",
                    "elapsed_seconds": elapsed
                }
            else:
                elapsed = time.time() - start_time
                return {
                    "delta": delta,
                    "update_type": "deletion",
                    "elapsed_seconds": elapsed
                }
        else:
            raise HTTPException(status_code=400, detail=f"Unknown update_type: {req.update_type}. Use 'addition' or 'deletion'.")
            
    except json.JSONDecodeError as e:
        print(f"[Delta] JSON parse error: {e}")
        raise HTTPException(status_code=400, detail=f"Failed to parse AI delta response: {e}")
    except Exception as e:
        print(f"[Delta] Error: {e}")
        raise HTTPException(status_code=400, detail=str(e))


def _parse_delta_json(ai_response: str) -> dict:
    """Parse JSON from AI response, handling markdown code blocks."""
    result_str = ai_response.strip()
    
    # Clean up markdown if present
    if "```json" in result_str:
        result_str = result_str.split("```json")[1].split("```")[0].strip()
    elif "```" in result_str:
        result_str = result_str.split("```")[1].split("```")[0].strip()
    
    return json.loads(result_str)


@app.post("/refactor/structural")
async def refactor_structural(req: StructuralUpdateRequest):
    """
    Legacy structural update endpoint - redirects to delta-based approach.
    Kept for backwards compatibility.
    """
    # Redirect to delta endpoint
    return await refactor_delta(req)


@app.get("/")
def root():
    return {
        "status": "ai-engine-online",
        "supported_languages": list(supported_languages()),
        "features": [
            "job_queue",
            "verification",
            "streaming",
            "provenance_tracking",
        ],
    }


if __name__ == "__main__":
    if len(sys.argv) > 1:
        split_file(sys.argv[1])
    else:
        import uvicorn
        # Bind to 0.0.0.0 to allow access from WSL/Containers
        uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)

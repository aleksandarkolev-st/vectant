#!/usr/bin/env python3
"""
Direct Gemini REST API test — bypasses google-generativeai SDK entirely.

Purpose: isolate "is the SDK broken?" vs "is the API slow?" vs "is our code broken?"
by sending the exact same split prompt that's hanging through raw HTTP.

Usage:
    cd ai-backend/ai-engine
    python test_gemini_direct.py
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

MODEL = os.environ.get("SYNTHI_GEMINI_MODEL", "gemini-3.1-flash-lite")
API_KEY = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY", "")

if not API_KEY:
    print("GEMINI_API_KEY or GOOGLE_API_KEY not set in environment")
    print("   Run:  export GEMINI_API_KEY=<your-key>  and try again")
    sys.exit(1)

URL = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent?key={API_KEY}"

# Sample user code — small SDL2 main that matches what the user was compiling
SAMPLE_CODE = """#include <SDL2/SDL.h>
#include <stdio.h>

int main() {
    SDL_Init(SDL_INIT_VIDEO);
    SDL_Window* win = SDL_CreateWindow("HMR Test", 0, 0, 800, 600, 0);
    SDL_Renderer* r = SDL_CreateRenderer(win, -1, SDL_RENDERER_ACCELERATED);

    bool running = true;
    int frame = 0;

    while (running) {
        SDL_Event e;
        while (SDL_PollEvent(&e)) {
            if (e.type == SDL_QUIT) running = false;
        }

        frame++;

        SDL_SetRenderDrawColor(r, 20, 20, 40, 255);
        SDL_RenderClear(r);

        SDL_Rect btn1 = {50, 50, 200, 60};
        SDL_SetRenderDrawColor(r, 60, 120, 220, 255);
        SDL_RenderFillRect(r, &btn1);

        SDL_Rect bar = {50, 500, frame % 700, 20};
        SDL_SetRenderDrawColor(r, 0, 255, 100, 255);
        SDL_RenderFillRect(r, &bar);

        SDL_RenderPresent(r);
        SDL_Delay(16);
    }

    SDL_DestroyRenderer(r);
    SDL_DestroyWindow(win);
    SDL_Quit();
    return 0;
}
"""

def list_gemini_models(api_key: str):
    """Make a GET request to list all available models for this API key."""
    list_url = f"https://generativelanguage.googleapis.com/v1beta/models?key={api_key}"
    req = urllib.request.Request(list_url, method="GET")
    
    try:
        with urllib.request.urlopen(req, timeout=10.0) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            print(f"{'MODEL NAME':<40} | SUPPORTED METHODS")
            print("-" * 75)
            count = 0
            for model in data.get("models", []):
                methods = model.get("supportedGenerationMethods", [])
                if "generateContent" in methods:
                    clean_name = model.get("name", "").replace("models/", "")
                    print(f"{clean_name:<40} | {', '.join(methods)}")
                    count += 1
            print("-" * 75)
            print(f"Total generateContent models found: {count}")
            return True
    except urllib.error.HTTPError as e:
        print(f"✗ HTTP Error fetching models: {e.code} - {e.read().decode('utf-8', errors='replace')}")
        return False
    except Exception as e:
        print(f"✗ Failed to fetch models: {e}")
        return False


def call_gemini(full_prompt: str, timeout_s: float = 300.0) -> tuple[int, dict | str, float]:
    """Make one REST call to Gemini's generateContent endpoint. Returns (status, body_or_error, elapsed_s)."""
    body = {
        "contents": [{"role": "user", "parts": [{"text": full_prompt}]}],
        "generationConfig": {
            "temperature": 0.2,
            "topP": 0.8,
            "topK": 40,
            "maxOutputTokens": 131072,
        },
    }
    payload = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        URL,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            status = resp.status
            raw = resp.read().decode("utf-8", errors="replace")
            elapsed = time.time() - t0
            try:
                return status, json.loads(raw), elapsed
            except json.JSONDecodeError:
                return status, raw, elapsed
    except urllib.error.HTTPError as e:
        elapsed = time.time() - t0
        body = e.read().decode("utf-8", errors="replace")
        return e.code, body, elapsed
    except urllib.error.URLError as e:
        elapsed = time.time() - t0
        return -1, f"URLError: {e.reason}", elapsed
    except Exception as e:
        elapsed = time.time() - t0
        return -2, f"{type(e).__name__}: {e}", elapsed


def extract_text(response_body) -> str:
    """Extract the generated text from a Gemini REST response."""
    if not isinstance(response_body, dict):
        return str(response_body)[:500]
    try:
        candidates = response_body.get("candidates", [])
        if not candidates:
            return f"(no candidates) {json.dumps(response_body)[:500]}"
        parts = candidates[0].get("content", {}).get("parts", [])
        return "".join(p.get("text", "") for p in parts)
    except Exception as e:
        return f"(extract error: {e}) {json.dumps(response_body)[:500]}"


print(f"Target Model: {MODEL}")
print(f"Target Endpoint: {URL.split('?')[0]}")
print(f"API key: {API_KEY[:4]}...{API_KEY[-4:]} (length {len(API_KEY)})")
print()

# ── Test 0: List Available Models ───────────────────────────────────
print("─── Test 0: List Available Models ───────────────────────────────")
print("Fetching allowed models for this API key...")
list_success = list_gemini_models(API_KEY)
print()

if not list_success:
    print("⚠ Skipping to Test 1, but model listing failed.")
    print()

# ── Test 1: tiny sanity prompt ──────────────────────────────────────
print("─── Test 1: tiny sanity prompt ──────────────────────────────────")
print("Prompt: 'Say hello in one word.'")
status, body, elapsed = call_gemini("Say hello in one word.", timeout_s=30.0)
print(f"Status: {status}   Elapsed: {elapsed:.2f}s")
if status == 200:
    text = extract_text(body)
    print(f"Response: {text[:200]}")
    print("✓ Sanity prompt OK")
else:
    print(f"Response body: {str(body)[:500]}")
    print("✗ Sanity prompt FAILED — API key / network / model unavailable")
    sys.exit(1)
print()

# ── Test 2: full split prompt ────────────────────────────────────────
print("─── Test 2: full split prompt (the hanging one) ─────────────────")
try:
    from llm.prompts import SPLIT_GUI_PROMPT
except ImportError as e:
    print(f"✗ Could not import SPLIT_GUI_PROMPT: {e}")
    print("  Make sure you run this from ai-backend/ai-engine/")
    print("  (Or comment out this block if you just wanted to list the models)")
    sys.exit(1)

full_prompt = (
    SPLIT_GUI_PROMPT
    + f"\n\nHere is the code to split (language: cpp):\n```cpp\n{SAMPLE_CODE}\n```"
    + "\n\nRespond with ONLY the JSON object. No explanation."
)
print(f"Prompt length: {len(full_prompt)} chars ({len(full_prompt.split())} words)")
print("Sending request with 300s timeout (5min)...")

status, body, elapsed = call_gemini(full_prompt, timeout_s=300.0)
print(f"Status: {status}   Elapsed: {elapsed:.2f}s")

if status == 200:
    text = extract_text(body)
    print(f"Response length: {len(text)} chars")
    print(f"First 300 chars: {text[:300]}")
    print("✓ Split prompt SUCCEEDED via REST API")
    if elapsed > 60:
        print(f"  ⚠ WARNING: took {elapsed:.1f}s — API is genuinely slow for this prompt")
        print(f"    → H1 (API slow) is confirmed. SDK is not the problem.")
    else:
        print(f"  → H2 (SDK non-streaming bug) likely: REST works fast, SDK hangs.")
elif status == -2 and "timeout" in str(body).lower():
    print(f"✗ TIMED OUT after {elapsed:.1f}s (>300s)")
    print("  → API itself is broken/unreachable for this prompt.")
    print("    Check rate limits in Google AI Studio dashboard.")
    sys.exit(2)
else:
    print(f"✗ Split prompt FAILED with status {status}")
    print(f"  Body: {str(body)[:1000]}")
    if status == 429:
        print("  → H4: rate limited. Check quotas.")
    elif status in (400, 403, 404):
        print("  → H4 or H5: bad request, content filter, or model not found.")
    sys.exit(3)

print()

# ── Test 3: retry for variance ───────────────────────────────────────
print("─── Test 3: retry split prompt (variance check) ─────────────────")
print("Same prompt again to check variance...")
status2, body2, elapsed2 = call_gemini(full_prompt, timeout_s=300.0)
print(f"Status: {status2}   Elapsed: {elapsed2:.2f}s")

if status == 200 and status2 == 200:
    delta_pct = abs(elapsed2 - elapsed) / max(elapsed, 0.1) * 100
    print(f"Variance: {delta_pct:.0f}% (first={elapsed:.1f}s, second={elapsed2:.1f}s)")
    if delta_pct > 50:
        print("  ⚠ High variance — Gemini is inconsistent for this prompt.")

print()
print("═══ Summary ═══")
print(f"  Test 1 (sanity):   {'✓' if status == 200 else '✗'}  ~{elapsed:.1f}s (sanity)")
print(f"  Test 2 (split):    {'✓' if status == 200 else '✗'}  {elapsed:.1f}s")
if status == 200:
    print(f"  Test 3 (retry):    {'✓' if status2 == 200 else '✗'}  {elapsed2:.1f}s")
print()
print("If both splits succeeded and were <60s, upgrading the SDK or going back to")
print("streaming should fix our code. If they took >60s, bumping the timeout is required.")

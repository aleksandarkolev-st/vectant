"""
HEAL prompt for fast HMR compilation-error repair.

History (context for the shrinking surface area of this module):

1. `DELTA_ADDITION_PROMPT` + `inject_delta_into_code` — REMOVED. Literally
   asked the model to "Translate this X11 code snippet to SDL2" and then
   spliced the result into split modules using string-match injection with
   hardcoded markers (`} AppState;`, `app_state.running = 1;`,
   `SDL_RenderPresent`, `SDL_MOUSEBUTTONDOWN`). SDL-hardcoded and silently
   dropped half its injections.

2. `DIFF_PATCH_PROMPT` + `format_diff_patch_prompt` — REMOVED. Contained
   SDL-hardcoded routing rules ("SDL_Render*, SDL_SetRenderDrawColor →
   gui.cpp" etc.) that broke on non-SDL code. Replaced by
   `_build_full_diff_patch_prompt(req)` in main.py, which injects the
   cached architecture markdown as the routing hint so the model does its
   own routing without hardcoded rules.

3. `DELTA_DELETION_PROMPT` + `format_delta_deletion_prompt` +
   `apply_deletion_delta` — REMOVED. The deletion path asked the model to
   "identify patterns to remove" and then string-matched those patterns
   to `// REMOVED: ...` line prefixes. It was SDL-idiomatic (`btn2_x`,
   `button 2`, etc.) and it corrupted the split on Tier 3 fallback by
   applying deletion patterns to stale baselines while the user's actual
   additions went missing. Deletions now flow through
   `/refactor/diff_patch` alongside every other edit kind — the cached
   architecture doc + the full diff tell the model exactly what to
   remove and what to add.

All edit kinds — additions, deletions, expression changes, value changes
— go through Tier 1 regex patcher (values) or Tier 2 arch-aware diff_patch
(everything else). perform_ai_split in the Rust worker is only called for
first-compile splits and Tier 3 fallbacks; its Level 2 / 2.6 / 2.75 cache
shortcuts were all removed with this cleanup.

What remains here:
- HEAL_PROMPT + format_heal_prompt: compilation-error repair prompt,
  still wired to /refactor/heal. This is the only non-split AI prompt
  that has survived.
"""


# ============================================================
# HEAL PROMPT: Fix compilation errors in AI-generated modules
# ============================================================
# The AI split produced code that doesn't compile. Instead of
# regex guardrails, we send the error back to the AI to fix.
# This prompt is tiny (~200 tokens context) so it's fast.
# ============================================================

HEAL_PROMPT = """Fix this C++ compilation error. Return ONLY the complete fixed file content.

MODULE: {module}

COMPILER ERRORS:
{errors}

CURRENT CODE:
```cpp
{code}
```

SHARED HEADER (for type reference):
```cpp
{shared}
```

RULES:
- Fix ONLY the error(s) listed above
- Do NOT change any other code
- Do NOT add new features or refactor
- Do NOT use malloc/new/calloc for AppState — use static storage
- Do NOT call SDL_RenderPresent — the runner handles it
- Do NOT include X11 headers — use SDL2 only
- Return the COMPLETE file content, not a partial diff

Return ONLY the fixed C++ code. No explanation, no markdown fences."""


def format_heal_prompt(module: str, code: str, errors: str, shared: str) -> str:
    """Format the heal prompt for a compilation error fix."""
    return HEAL_PROMPT.format(
        module=module,
        code=code,
        errors=errors,
        shared=shared,
    )

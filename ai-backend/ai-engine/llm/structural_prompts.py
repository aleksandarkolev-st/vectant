"""
Delta prompts for fast HMR.

History (context for the shrinking surface area of this module):

1. `DELTA_ADDITION_PROMPT` + `inject_delta_into_code` — REMOVED. Literally
   asked the model to "Translate this X11 code snippet to SDL2" and then
   spliced the result into split modules using string-match injection with
   hardcoded markers (`} AppState;`, `app_state.running = 1;`,
   `SDL_RenderPresent`, `SDL_MOUSEBUTTONDOWN`). SDL-hardcoded and silently
   dropped half its injections. Additions now flow through
   `/refactor/diff_patch` which is language-agnostic and arch-cache-aware.

2. `DIFF_PATCH_PROMPT` + `format_diff_patch_prompt` — REMOVED. Contained
   SDL-hardcoded routing rules ("SDL_Render*, SDL_SetRenderDrawColor → gui.cpp"
   etc.) that broke on non-SDL code. Replaced by
   `_build_full_diff_patch_prompt(req)` in main.py, which injects the cached
   architecture markdown as the routing hint so the model does its own
   routing without hardcoded rules.

What remains here:
- DELTA_DELETION_PROMPT + format_delta_deletion_prompt: deletion path
  (still wired to /refactor/delta for `update_type == "deletion"`). This
  has similar SDL-hardcoded concerns and is a candidate for removal next.
- apply_deletion_delta: comments out lines matching deletion patterns.
- HEAL_PROMPT + format_heal_prompt: compilation-error repair prompt.
"""


# For deletions, return which patterns to comment out
DELTA_DELETION_PROMPT = """Identify ONLY the variable names/patterns to remove for this element.

WHAT TO REMOVE:
{deletion_description}

Return ONLY JSON:
{{
  "field_patterns": ["btn2_x", "btn2_y", "btn2_w", "btn2_h"],
  "comment_patterns": ["btn2", "button 2", "second button"]
}}"""


def format_delta_deletion_prompt(deletion_description: str) -> str:
    """Format the delta deletion prompt."""
    return DELTA_DELETION_PROMPT.format(deletion_description=deletion_description)


def apply_deletion_delta(cached_result: dict, delta: dict) -> dict:
    """
    Comment out code matching the deletion patterns.

    Args:
        cached_result: The existing split code
        delta: {"field_patterns": [...], "comment_patterns": [...]}
    """
    import copy
    result = copy.deepcopy(cached_result)

    field_patterns = delta.get("field_patterns", [])
    comment_patterns = delta.get("comment_patterns", [])

    for key in ["core", "gui", "shared"]:
        if key not in result:
            continue
        content = result[key].get("content", "")

        # Comment out lines containing any of the patterns
        new_lines = []
        for line in content.split('\n'):
            should_comment = False
            for pattern in field_patterns + comment_patterns:
                if pattern in line and not line.strip().startswith("//"):
                    should_comment = True
                    break

            if should_comment:
                new_lines.append(f"// REMOVED: {line}")
            else:
                new_lines.append(line)

        result[key]["content"] = '\n'.join(new_lines)

    return result


# ============================================================
# DIFF-PATCH PROMPT: Apply source diff to split modules
# ============================================================

# NOTE: DIFF_PATCH_PROMPT + format_diff_patch_prompt were removed.
# They contained SDL-hardcoded routing rules ("SDL_Render*, SDL_SetRenderDrawColor
# → gui.cpp") that broke the moment a user wrote non-SDL code.
# The replacement is `_build_full_diff_patch_prompt(req)` in main.py,
# which injects the cached architecture doc (captured at split time)
# as a language-agnostic routing hint. The architecture doc's
# "Where User Code Goes" section tells the model where each kind of
# code goes for THIS project, whatever its language/framework.


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

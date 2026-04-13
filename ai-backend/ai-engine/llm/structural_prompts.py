"""
Delta prompts for fast HMR.

History: this module used to contain an "addition" path
(`DELTA_ADDITION_PROMPT` + `inject_delta_into_code`) that literally
asked the model to "Translate this X11 code snippet to SDL2" and then
spliced the result into split modules using string-match injection
with hardcoded markers (`} AppState;`, `app_state.running = 1;`,
`SDL_RenderPresent`, `SDL_MOUSEBUTTONDOWN`). It was SDL-hardcoded and
silently dropped half its injections. It has been removed — additions
now flow through `/refactor/diff_patch` (language-agnostic,
architecture-cache-aware).

What remains here:
- DELTA_DELETION_PROMPT + format_delta_deletion_prompt: deletion path
  (still wired to /refactor/delta for `update_type == "deletion"`).
- apply_deletion_delta: comments out lines matching deletion patterns.
- DIFF_PATCH_PROMPT + format_diff_patch_prompt: the full 3-module
  diff-patch prompt used by /refactor/diff_patch's full mode.
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

DIFF_PATCH_PROMPT = """You are a code patcher for the Synthi HMR system.

The user edited their original source file. Below is the DIFF of what changed.
Below that are the current split module files (core.cpp, gui.cpp, shared.h)
that were produced by a previous AI split of the original source.

Your job: apply the user's changes to the correct module file(s).
Return the COMPLETE updated content of ONLY the files that changed.

## RULES
- Do NOT regenerate files from scratch — patch the existing content
- Do NOT add new boilerplate, stubs, or HMR callbacks
- Do NOT change function signatures (on_load, on_update, on_render, on_event)
- If the user changed a value (color, speed, position), find that value in the
  split files and update it
- If the user added new code, determine which module it belongs to:
  - SDL_Render*, SDL_SetRenderDrawColor → gui.cpp (inside gui_on_render)
  - State/logic updates → core.cpp (inside core_on_update)
  - New struct fields → shared.h (inside AppState)
- If the user removed code, remove it from the appropriate module
- Preserve ALL existing code that wasn't affected by the diff

## DIFF (what the user changed in their source)
```diff
{diff}
```

## CURRENT core.cpp
```cpp
{core}
```

## CURRENT gui.cpp
```cpp
{gui}
```

## CURRENT shared.h
```cpp
{shared}
```

## OUTPUT FORMAT
Return ONLY a JSON object with the files that changed. Omit unchanged files.
```json
{{
  "core": "... full updated core.cpp content ...",
  "gui": "... full updated gui.cpp content ...",
  "shared": "... full updated shared.h content ..."
}}
```

If only gui.cpp changed, return: {{"gui": "..."}}
If only a value in core.cpp changed, return: {{"core": "..."}}
Return ONLY the JSON. No explanation."""


def format_diff_patch_prompt(diff: str, core: str, gui: str, shared: str) -> str:
    """Format the diff-patch prompt with actual content."""
    return DIFF_PATCH_PROMPT.format(
        diff=diff,
        core=core,
        gui=gui,
        shared=shared,
    )


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

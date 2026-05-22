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

4. `HEAL_PROMPT` SDL-hardcoded rules — REMOVED. The old heal prompt had
   library-specific rules like "Do NOT call SDL_RenderPresent — the
   runner handles it" and "Do NOT include X11 headers — use SDL2 only"
   that broke for any non-SDL project. The new heal prompt injects the
   cached architecture doc (which has a "Forbidden Patterns" section
   that captures project-specific don'ts per-language) and keeps only
   generic rules ("fix only the error", "don't refactor", "return the
   complete file"). Same pattern as the diff_patch refactor — let the
   arch cache express project-specific rules instead of baking them
   into the Python prompt.

What remains here:
- HEAL_PROMPT + format_heal_prompt: compilation-error repair prompt,
  still wired to /refactor/heal. Now takes an optional architecture
  markdown doc which gets injected into the prompt (same shape as the
  diff_patch priority-rule pattern). No SDL-specific rules.
"""


# ============================================================
# HEAL PROMPT: Fix compilation errors in AI-generated modules
# ============================================================
# The AI split produced code that doesn't compile. Instead of
# regex guardrails, we send the error back to the AI to fix.
# This prompt is tiny (~200 tokens context) so it's fast.
#
# The prompt is language-agnostic. Project-specific "don'ts"
# (e.g. "runner calls SDL_RenderPresent — don't call it yourself",
# "state is static — no malloc") are carried in the cached
# architecture doc's "Forbidden Patterns" section, injected here
# via `format_heal_prompt(architecture=...)`.
# ============================================================

_HEAL_ARCH_HEADER = (
    "ARCHITECTURE (cached from the initial split — describes how this\n"
    "project's split modules are organized and what patterns are forbidden):"
)

_HEAL_GENERIC_RULES = """RULES:
- Fix ONLY the error(s) listed above
- Do NOT change any other code
- Do NOT add new features or refactor
- Do NOT introduce new top-level entrypoints or lifecycle callbacks
- If an ARCHITECTURE section is provided above, follow its
  "Forbidden Patterns" list — those are the project-specific
  don'ts you must respect while healing.
- Return the COMPLETE file content, not a partial diff
- Do NOT wrap the file in JSON; do NOT return {"content": ...} or
  {"file_content": ...}

Return ONLY the fixed code. No explanation, no markdown fences."""


def format_heal_prompt(
    module: str,
    code: str,
    errors: str,
    shared: str,
    architecture: str = "",
    language: str = "cpp",
) -> str:
    """Build the heal prompt.

    `architecture` is the cached split-architecture markdown doc (may
    be an empty string for pre-migration sidecars, in which case the
    ARCHITECTURE block is omitted and the prompt degrades to the
    generic form with only baseline rules).
    """
    parts: list = [
        f"Fix this {language} compilation error. Return ONLY the complete fixed file content.",
        "",
        f"MODULE: {module}",
        "",
        "COMPILER ERRORS:",
        errors,
        "",
        "CURRENT CODE:",
        "```",
        code,
        "```",
        "",
        "SHARED HEADER (for type reference):",
        "```",
        shared,
        "```",
        "",
    ]

    arch = (architecture or "").strip()
    if arch:
        parts += [_HEAL_ARCH_HEADER, "", arch, ""]

    parts.append(_HEAL_GENERIC_RULES)
    return "\n".join(parts)

"""
Diff-patch prompt builder + edit-list validator (extracted from main.py).

These helpers are split out of main.py so they can be unit-tested
without dragging in main.py's import chain (FastAPI app construction,
google.generativeai client init, etc.). main.py re-exports them so
existing call sites are unchanged.

Phase 5 contract: edits target one of FOUR modules — `core`, `gui`,
`shared`, or `host_runner`. The 4th target was added in Phase 5 to let
diff_patch update the per-project main()/dlopen runner. Pre-Phase-5
projects pass `host_runner_content=""` and the prompt skips the
host_runner block accordingly.

CRITICAL RULE 5 (host_runner ownership):
  Edits that touch window init, event loop, library init, frame
  present, or runner-side dlopen wiring belong in `host_runner`.
  Per-frame logic stays in `core`/`gui` per the architecture.
  Empty host_runner → AI must NOT emit host_runner edits.
"""
from __future__ import annotations

from typing import List, Optional

try:
    from pydantic import BaseModel
except ImportError:  # pragma: no cover
    raise

try:
    from fastapi import HTTPException
except ImportError:  # pragma: no cover — tests can run with a stub
    class HTTPException(Exception):  # type: ignore
        def __init__(self, status_code: int, detail: str):
            super().__init__(detail)
            self.status_code = status_code
            self.detail = detail


# ─────────────────────────────────────────────────────────────────────────────
# DiffPatchRequest schema
# ─────────────────────────────────────────────────────────────────────────────


class DiffPatchRequest(BaseModel):
    """Request for AI-powered diff patching of split modules.

    Tier 2 of the HMR pipeline. The user typed something, the worker
    diff'd the new source against the previous baseline, and now wants
    the AI to translate that diff into a list of structured edits to
    apply locally to the existing split files.

    As of the classify-removal refactor, there is only one mode: full
    diff-patch with the cached architecture hint. The model receives all
    four module contents + the user's diff + the architecture doc +
    the priority rule, and returns updated content for whichever modules
    changed. The previous targeted-mode optimization (pick ONE module
    via an AI classifier, then send only that module) was removed —
    classify was costing ~4s per edit for a lite call, which exceeded
    the time saved by the smaller targeted prompt. One AI call per
    edit, no classifier, no silent drops on classifier timeout.
    """
    diff: str              # Unified diff of the user's source changes
    core_content: str = ""
    gui_content: str = ""
    shared_content: str = ""
    # ULTRAPLAN Phase 5: 4th edit target. The AI may produce edits with
    # `module="host_runner"` to update the per-project main()/dlopen
    # bootstrapper. Empty string is the legacy 3-file project sentinel —
    # the prompt builder skips the host_runner block and `_VALID_EDIT_MODULES`
    # forbids host_runner edits in that case (see _build_full_diff_patch_prompt).
    host_runner_content: str = ""
    # Cached split architecture doc (markdown) — captured at initial
    # /refactor/split/verified time and re-injected here so the model
    # does not have to re-derive the module contract on every edit.
    # Empty string → fall back to the generic prompt (no regression).
    architecture: Optional[str] = None
    model: Optional[str] = None
    api_key: Optional[str] = None


# ─────────────────────────────────────────────────────────────────────────────
# Edit-list validator
# ─────────────────────────────────────────────────────────────────────────────

VALID_EDIT_OPS = {"insert_after", "insert_before", "replace", "delete"}
# ULTRAPLAN Phase 5: host_runner is the 4th valid edit target.
VALID_EDIT_MODULES = {"core", "gui", "shared", "host_runner"}


def validate_edit_list(edits: object) -> List[dict]:
    """Validate that the AI returned a well-formed list of edits.

    Raises HTTPException(400) on any shape mismatch. Returns a cleaned
    list with only the expected fields so the Rust worker's serde
    deserializer sees exactly the schema it expects.
    """
    if not isinstance(edits, list):
        raise HTTPException(
            status_code=400,
            detail=f"`edits` must be a JSON array, got {type(edits).__name__}",
        )
    cleaned: List[dict] = []
    for i, e in enumerate(edits):
        if not isinstance(e, dict):
            raise HTTPException(
                status_code=400,
                detail=f"edit #{i} must be a JSON object, got {type(e).__name__}",
            )
        module = e.get("module")
        op = e.get("operation")
        anchor = e.get("anchor")
        content = e.get("content", "")
        if module not in VALID_EDIT_MODULES:
            raise HTTPException(
                status_code=400,
                detail=f"edit #{i}: `module` must be one of {VALID_EDIT_MODULES}, got {module!r}",
            )
        if op not in VALID_EDIT_OPS:
            raise HTTPException(
                status_code=400,
                detail=f"edit #{i}: `operation` must be one of {VALID_EDIT_OPS}, got {op!r}",
            )
        if not isinstance(anchor, str) or not anchor:
            raise HTTPException(
                status_code=400,
                detail=f"edit #{i}: `anchor` must be a non-empty string",
            )
        if not isinstance(content, str):
            raise HTTPException(
                status_code=400,
                detail=f"edit #{i}: `content` must be a string (use empty string for delete)",
            )
        cleaned.append({
            "module": module,
            "operation": op,
            "anchor": anchor,
            "content": content,
        })
    return cleaned


# ─────────────────────────────────────────────────────────────────────────────
# Diff-patch prompt builder
# ─────────────────────────────────────────────────────────────────────────────

DIFF_PATCH_ARCH_HEADER = (
    "ARCHITECTURE (cached from the initial split — describes how this\n"
    "project's split modules are organized):"
)

DIFF_PATCH_PRIORITY_RULE = """PRIORITY RULE (read this carefully):
The ARCHITECTURE section above was captured at initial split time. It
describes how the ORIGINAL source's variables were relocated into the
split modules. It is a HINT, not ground truth.

If the user's DIFF (below) explicitly:
  - renames a variable (e.g. changes `r` to `main_renderer`)
  - redefines a type
  - restructures a function
  - introduces new fields or functions
...then the DIFF is authoritative. Follow the diff. Do NOT apply stale
mappings to references that no longer match the original form. The
cached mapping only applies to references that remain UNCHANGED from
the original source."""


def build_full_diff_patch_prompt(req: DiffPatchRequest) -> str:
    """Assemble the full 4-module diff_patch prompt in edit-list format.

    Instead of asking the model to regenerate full updated module files
    (~2500-4000 output tokens per edit), we ask for a list of structured
    edits — anchor + operation + content — which Rust applies locally
    via `hmr::edit_applier::apply_edit`. Output tokens drop from ~3000
    to ~100, which cuts pro-model generation time from ~30s to ~1s.

    When `req.architecture` is empty, the ARCHITECTURE + PRIORITY_RULE
    blocks are omitted and the prompt degrades to the generic form —
    no regression for pre-migration sidecars that don't have a cached
    architecture yet.

    ULTRAPLAN Phase 5: when `req.host_runner_content` is non-empty, a
    4th "CURRENT host_runner module content" block is included and the
    AI is permitted to emit edits targeting `module="host_runner"`. When
    empty, the host_runner block is skipped and CRITICAL RULE 5 forbids
    host_runner edits — the AI must route changes into core/gui/shared.
    """
    parts: List[str] = [
        "You are generating EDIT INSTRUCTIONS for a SPLIT multi-module project.",
        "Return a JSON object with an `edits` array. The Rust worker will apply",
        "each edit locally by searching the current module content for `anchor`",
        "and performing `operation` at that location. You do NOT return full",
        "file contents — only the edits needed.",
        "",
        "CRITICAL RULES — these apply to any language/framework:",
        "",
        "1. The target files (core, gui, shared) are SPLIT modules, NOT standalone",
        "   programs. They may not have a main entrypoint and they export specific",
        "   lifecycle functions (e.g. *_on_load, *_on_update, *_on_render, etc.).",
        "   STUDY the current module contents below to identify each file's",
        "   existing function signatures — those are your template.",
        "",
        "2. The diff comes from the user's ORIGINAL source file, which may use raw",
        "   idioms (local variables, inline entrypoint, direct API references). You",
        "   must ADAPT those references to fit the split modules' existing structure:",
        "     - Local variables in the original source usually live on a shared state",
        "       object in the split modules. Look at the existing code to see how",
        "       state is accessed (e.g. a cast like `State* s = (State*)state_ptr;`)",
        "       and follow the same pattern.",
        "     - API handles (renderer, window, audio, etc.) are typically stored on",
        "       the state object — use the same field names the existing code uses.",
        "",
        "3. DECIDE which module(s) each diff hunk belongs to. The ARCHITECTURE",
        "   section below tells you the routing rules — use its 'Where User Code",
        "   Goes' section as the authoritative mapping. Each edit in your output",
        "   must set the `module` field to one of `core`, `gui`, `shared`, or",
        "   `host_runner` (the latter only when host_runner.cpp is present and",
        "   the change targets window/event/loop ownership).",
        "",
        "4. Do NOT emit edits that paste the diff verbatim at file scope (would cause",
        "   declaration errors in C/C++ or top-level errors in Python/JS/Rust).",
        "   Do NOT redeclare existing variables, add duplicate entrypoints, or",
        "   create new top-level functions unless the existing file's convention",
        "   demands it. Your edits should merge the change into an existing",
        "   function body, or add to an existing struct definition, etc.",
        "",
        "5. host_runner ownership: edits that change WINDOW INIT (size, title,",
        "   flags), EVENT LOOP STRUCTURE, FRAME PRESENT calls, library init",
        "   (SDL_Init, glfwInit, FMOD_System_Init, ...), or runner-side",
        "   dlopen/dlsym wiring belong in `host_runner`. Edits that change",
        "   per-frame logic (state updates, rendering primitives, audio cues",
        "   triggered by gameplay) belong in `core` / `gui` per the architecture.",
        "   When host_runner.cpp is empty (legacy 3-file project), do NOT emit",
        "   host_runner edits — route those changes into the existing modules.",
        "",
    ]

    arch = (req.architecture or "").strip()
    if arch:
        parts += [DIFF_PATCH_ARCH_HEADER, "", arch, ""]

    parts += [
        "CURRENT core module content:",
        "```",
        req.core_content or "",
        "```",
        "",
        "CURRENT gui module content:",
        "```",
        req.gui_content or "",
        "```",
        "",
        "CURRENT shared module content:",
        "```",
        req.shared_content or "",
        "```",
        "",
    ]

    # ULTRAPLAN Phase 5: include the host_runner block iff non-empty.
    # Legacy 3-file projects (pre-Phase-4) have an empty host_runner_content
    # and we skip the block entirely so the prompt stays small AND so the
    # AI is implicitly forbidden from emitting host_runner edits in that
    # context (the rule in CRITICAL RULE 5 above says "do NOT emit
    # host_runner edits when host_runner.cpp is empty").
    if (req.host_runner_content or "").strip():
        parts += [
            "CURRENT host_runner module content:",
            "```",
            req.host_runner_content,
            "```",
            "",
        ]

    if arch:
        # Priority rule sits AFTER the architecture + module contents and
        # immediately before the diff — last thing the model reads before
        # generating. Mitigates the "lost in the middle" effect.
        parts += [DIFF_PATCH_PRIORITY_RULE, ""]

    parts += [
        "DIFF (from user's source — use as INTENT, apply the priority rule above):",
        "```",
        req.diff,
        "```",
        "",
        "# OUTPUT FORMAT",
        "",
        "Return a single JSON object with an `edits` array. Each edit has:",
        "",
        '  - `module`:    "core" | "gui" | "shared" | "host_runner"',
        "                 (host_runner only valid when host_runner.cpp is present —",
        "                  see CRITICAL RULE 5)",
        '  - `operation`: "insert_after" | "insert_before" | "replace" | "delete"',
        "  - `anchor`:    an EXACT substring of the current module content that",
        "                 locates the edit. Rust will call `content.find(anchor)`.",
        "                 The anchor MUST appear EXACTLY ONCE in the module — if",
        "                 it is missing or ambiguous the whole edit fails and we",
        "                 fall back to a full re-split. Include enough surrounding",
        "                 context (usually 1-3 lines, or a full statement) to make",
        "                 the anchor unique. Whitespace is preserved — copy the",
        "                 anchor verbatim from the current content above.",
        "  - `content`:   the new text. For insert_after / insert_before this is",
        "                 the code to insert. For replace this is what replaces",
        "                 the anchor. For delete this is ignored (use an empty",
        "                 string). Preserve the surrounding indentation style.",
        "",
        "Operations:",
        "  - insert_after:  put `content` immediately AFTER the anchor",
        "  - insert_before: put `content` immediately BEFORE the anchor",
        "  - replace:       replace the anchor with `content`",
        "  - delete:        remove the anchor (content ignored)",
        "",
        "If no changes are needed, return `{\"edits\": []}`.",
        "",
        "# EXAMPLE",
        "",
        "Suppose the diff adds a red button after an existing blue button. The",
        "current gui module contains:",
        "",
        "```",
        "    SDL_Rect btn1 = {50, 50, 200, 60};",
        "    SDL_SetRenderDrawColor(state->renderer, 60, 120, 220, 255);",
        "    SDL_RenderFillRect(state->renderer, &btn1);",
        "```",
        "",
        "A correct output would be:",
        "",
        "```",
        "{",
        '  "edits": [',
        "    {",
        '      "module": "gui",',
        '      "operation": "insert_after",',
        '      "anchor": "SDL_RenderFillRect(state->renderer, &btn1);",',
        '      "content": "\\n\\n    SDL_Rect btn2 = {50, 130, 200, 60};\\n    SDL_SetRenderDrawColor(state->renderer, 220, 60, 60, 255);\\n    SDL_RenderFillRect(state->renderer, &btn2);"',
        "    }",
        "  ]",
        "}",
        "```",
        "",
        "Return ONLY the JSON object. No markdown fences, no prose, no explanation.",
    ]
    return "\n".join(parts)

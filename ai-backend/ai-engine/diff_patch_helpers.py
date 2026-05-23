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

ULTRAPLAN Phase 6: this module also hosts the manifest-heal request
schema and prompt builder for `/refactor/heal/manifest`. The endpoint
is the runtime safety net that catches link-time `undefined reference`
failures: extract symbols → ask AI to update link flags → retry once.
The prompt is intentionally library-agnostic — it never names a
specific library or symbol prefix. The AI uses general knowledge of
which symbols come from which library to produce updated link flags.
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
        "6. Generated-module include purity: do NOT introduce quoted includes",
        "   for original workspace/project headers that are not already emitted",
        "   split role files. Split modules must remain self-contained; copy or",
        "   adapt required declarations/helpers into shared/core/gui/host_runner",
        "   instead of adding `#include \"project/path.hpp\"`.",
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


# ─────────────────────────────────────────────────────────────────────────────
# Manifest heal — ULTRAPLAN Phase 6
# ─────────────────────────────────────────────────────────────────────────────
#
# Runtime safety net for link errors that slipped past Phase 4.5's
# pre-flight include→link validator. Sequence:
#
#   1. compile_core / compile_gui / compile_runner spawns g++/clang
#   2. linker emits `undefined reference to X` errors
#   3. Rust worker calls hmr::undef_symbols::extract_undefined_symbols
#   4. Worker calls /refactor/heal/manifest with (manifest, symbols, source, module)
#   5. AI returns updated manifest with new link flags
#   6. Worker retries compile ONCE with the updated manifest
#   7. On second failure, surface the visible 3-option error card
#
# This module owns the schema + prompt builder. The actual endpoint
# handler in main.py is a thin wrapper that calls the LLM provider
# and parses the response.
#
# ANTI-HARDCODING GUARANTEE: the prompt below contains zero library
# names. It uses placeholder syntax and instructs the AI to read the
# user's source + symbols and update the manifest using its general
# knowledge. Adding a new library tomorrow needs no prompt changes.


class HealManifestRequest(BaseModel):
    """Request for AI-driven manifest heal after link failure.

    Sent by the Rust worker when `extract_undefined_symbols` returns
    a non-empty list and the existing source-heal loop hasn't already
    burned its retry budget. The AI returns an updated manifest whose
    runner_link_flags / gui_link_flags / core_link_flags satisfy the
    missing symbols.
    """

    # The manifest the worker tried to use, as the same dict shape that
    # came out of `manifest_to_dict` originally. Pydantic accepts dict
    # here so the worker can ship the JSON it has on disk verbatim.
    current_manifest: dict

    # List of undefined symbol names extracted from the linker stderr.
    # Order is preserved for diagnostic clarity but doesn't affect
    # correctness — the AI heals based on the set, not the sequence.
    undefined_symbols: List[str]

    # Excerpt of the user's source so the AI can correlate symbols
    # with #include directives + call sites. Should include AT LEAST
    # the #include lines + any function bodies that reference the
    # missing symbols. The worker's responsibility to slice this down.
    source_excerpt: str

    # Which compile stage failed: "core" / "gui" / "host_runner" /
    # "shared". Tells the AI which manifest field needs the new flag
    # (gui_link_flags vs core_link_flags vs runner_link_flags). The
    # set of valid values is fixed but the rule for what they mean
    # is generic — `failed_module` is just a routing hint.
    failed_module: str

    # Optional — the original architecture cache markdown, for context.
    architecture: Optional[str] = None
    model: Optional[str] = None
    api_key: Optional[str] = None


# Set of valid values for `failed_module`. host_runner is the runner
# binary, shared is the header (rare to fail-link-on but possible if
# the user puts a function body in the header — kept for completeness).
VALID_FAILED_MODULES = {"core", "gui", "shared", "host_runner"}


class HealManifestResponse(BaseModel):
    """Response from /refactor/heal/manifest.

    `updated_manifest` is the new manifest dict the worker should retry
    with. `unchanged` is True when the AI couldn't suggest any new
    flags — Rust short-circuits the retry in that case and goes
    straight to the error card.
    """

    updated_manifest: dict
    unchanged: bool = False
    notes: str = ""


def build_manifest_heal_prompt(req: HealManifestRequest) -> str:
    """Library-agnostic prompt asking the AI to update link flags
    based on undefined symbols + user source + current manifest.

    NO library names appear anywhere in this string. All examples use
    placeholder syntax (`<name>`) so the prompt cannot bias the AI
    toward known libraries. The rule is generic: read the symbols and
    the source, infer which library each symbol belongs to from your
    own training-set knowledge, return updated flag arrays.
    """
    symbols_block = "\n".join(f"  - {s}" for s in req.undefined_symbols) or "  (none)"

    parts: List[str] = [
        "You are repairing a build manifest after a link-time failure.",
        "",
        "The user's project compiled successfully but the LINKER reported",
        "undefined references for the symbols listed below. These symbols",
        "exist in some external library that the manifest's link flags do",
        "not yet pull in. Your task: update the manifest's link flag arrays",
        "so the next compile attempt resolves these symbols.",
        "",
        "# CONTEXT",
        "",
        f"FAILED COMPILE STAGE: {req.failed_module}",
        "",
        "  - If `core`: update `core_link_flags` (and usually also",
        "    `gui_link_flags` if the same library is referenced from gui).",
        "  - If `gui`:  update `gui_link_flags`.",
        "  - If `host_runner`: update `runner_link_flags`. Most missing-",
        "    symbol cases at link time are runner-stage failures because",
        "    the runner is the executable that gets the actual link.",
        "  - If `shared`: rare — usually the symbol belongs in core/gui",
        "    instead. Be conservative; prefer adding to core_link_flags.",
        "",
        "UNDEFINED SYMBOLS (raw, as the linker reported them):",
        "",
        symbols_block,
        "",
        "USER SOURCE EXCERPT (look for `#include` lines and call sites):",
        "```",
        req.source_excerpt,
        "```",
        "",
        "CURRENT MANIFEST (this is what we tried, and the linker rejected):",
        "```json",
        _safe_dump_json(req.current_manifest),
        "```",
        "",
    ]

    if req.architecture and req.architecture.strip():
        parts += [
            "ARCHITECTURE CACHE (for additional context — same one used at split):",
            "```",
            req.architecture.strip(),
            "```",
            "",
        ]

    parts += [
        "# RULES",
        "",
        "1. KEEP THE SAME SHAPE. Return the same JSON keys in the same order.",
        "   You may add/remove entries inside the link flag arrays but you",
        "   may NOT add new top-level fields, drop existing ones, or change",
        "   `compiler` / `std` / `hot_reload_mode` / `confidence`.",
        "",
        "2. ADD link flags that satisfy the undefined symbols. Use your",
        "   general knowledge of which libraries export which symbol prefixes",
        "   (e.g. `Foo_Bar()` typically comes from `-lfoo`, `xy_init()` from",
        "   `-lxy`). DO NOT ask the user; infer from the symbols and the",
        "   `#include` directives in the source excerpt.",
        "",
        "3. PRESERVE existing link flags. If the manifest already has",
        "   `-lSomething`, keep it — the new symbols ADD to the requirements,",
        "   they do not replace them.",
        "",
        "4. DO NOT remove flags except when you're CERTAIN they are wrong",
        "   (e.g. duplicate, contradictory, or a typo). Conservative additions",
        "   only.",
        "",
        "5. UPDATE BOTH the failed-module field AND any sibling flag arrays",
        "   that reference the same library. Example: if `core` failed and",
        "   `<some-lib>` is used, the new flag goes into `core_link_flags`",
        "   AND `runner_link_flags` (because the runner re-links against",
        "   the same .so). If you're not sure whether a sibling needs the",
        "   flag, add it conservatively — duplicate `-l` flags are harmless.",
        "",
        "6. IF YOU CANNOT INFER a library from a symbol, leave the manifest",
        "   unchanged and set `unchanged: true`. The system will surface the",
        "   3-option error card to the user instead of looping forever.",
        "",
        "# OUTPUT FORMAT (strict)",
        "",
        "Return a SINGLE JSON object with three fields:",
        "",
        "  {",
        '    "updated_manifest": { ...same shape as the input manifest... },',
        '    "unchanged": false,',
        '    "notes": "<one-sentence explanation of what you added and why>"',
        "  }",
        "",
        "If you couldn't determine the library for any symbol, return:",
        "",
        "  {",
        '    "updated_manifest": { ...the input manifest, byte-identical... },',
        '    "unchanged": true,',
        '    "notes": "<one-sentence explanation of what was unclear>"',
        "  }",
        "",
        "Return ONLY the JSON object. No markdown fences, no prose.",
    ]
    return "\n".join(parts)


def _safe_dump_json(obj: dict) -> str:
    """Dump dict as pretty JSON, falling back to repr() on any error.
    Used in prompt assembly where we'd rather show a debuggable string
    than crash the whole heal endpoint on a non-serialisable manifest.
    """
    import json as _json

    try:
        return _json.dumps(obj, indent=2, sort_keys=False)
    except (TypeError, ValueError):
        return repr(obj)


def parse_heal_manifest_response(raw: str) -> HealManifestResponse:
    """Parse the AI's JSON response into a HealManifestResponse.

    Strips markdown fences if the model added them despite the prompt's
    "no fences" instruction. Raises ValueError on shape mismatch — the
    Rust worker treats that as "treat heal as failed, go to error card".
    """
    import json as _json

    cleaned = raw.strip()
    if cleaned.startswith("```json"):
        cleaned = cleaned[7:]
        if cleaned.endswith("```"):
            cleaned = cleaned[:-3]
    elif cleaned.startswith("```"):
        cleaned = cleaned[3:]
        if cleaned.endswith("```"):
            cleaned = cleaned[:-3]
    cleaned = cleaned.strip()

    try:
        data = _json.loads(cleaned)
    except _json.JSONDecodeError as e:
        raise ValueError(f"manifest heal response is not valid JSON: {e}") from e

    if not isinstance(data, dict):
        raise ValueError(
            f"manifest heal response must be a JSON object, got {type(data).__name__}"
        )
    if "updated_manifest" not in data:
        raise ValueError("manifest heal response missing `updated_manifest`")
    if not isinstance(data["updated_manifest"], dict):
        raise ValueError("`updated_manifest` must be a JSON object")
    return HealManifestResponse(
        updated_manifest=data["updated_manifest"],
        unchanged=bool(data.get("unchanged", False)),
        notes=str(data.get("notes", "")),
    )

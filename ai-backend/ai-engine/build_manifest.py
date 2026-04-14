"""
Build manifest schema + V1 validator for the universal split pipeline.

The universal split prompt (llm/prompts.py::UNIVERSAL_SPLIT_PROMPT) asks
the AI to emit a machine-readable JSON block inside the architecture
cache describing how to compile the user's split modules. Python parses
it, validates the shape with pydantic, and forwards it to the Rust worker
via the split sidecar.

Manifest format (emitted by the AI inside <synthi_build_manifest>):

    {
      "compiler": "g++",
      "std": "c++17",
      "common_flags": ["-shared", "-fPIC", "-g", ...],
      "core_link_flags": [],
      "gui_link_flags": ["-lSDL2"],
      "shared_link_flags": [],
      "runner_link_flags": ["-lSDL2", "-ldl"],
      "system_packages": ["libsdl2-dev"],
      "hot_reload_mode": "swap" | "process_restart" | "auto",
      "confidence": {
        "overall": "high" | "medium" | "low",
        "runner_synthesis": "high" | "medium" | "low",
        "link_flags": "high" | "medium" | "low",
        "notes": "..."
      }
    }

V1 scope: single-step `g++` builds only. Multi-step builds (Qt MOC,
CMake, etc.) are detected via a non-empty `build_steps` array — V1
REJECTS those with a clean actionable error. V2 will execute them.
See HMR_AGNOSTIC_ULTRAPLAN.md §5.3 for the full Point 3 design.
"""
from __future__ import annotations

from typing import Any, List, Literal, Optional

try:
    from pydantic import BaseModel, Field, field_validator, ConfigDict
    _PYDANTIC_V2 = True
except ImportError:  # pragma: no cover — fallback for pydantic v1
    from pydantic import BaseModel, Field, validator as field_validator  # type: ignore
    _PYDANTIC_V2 = False


ConfidenceLevel = Literal["high", "medium", "low"]
HotReloadMode = Literal["swap", "process_restart", "auto"]
Compiler = Literal["g++", "clang++"]


class ConfidenceBlock(BaseModel):
    """AI's self-reported confidence in the manifest it just generated.

    See HMR_AGNOSTIC_ULTRAPLAN.md §5.2 (Point 2 — hidden entry points).
    The `runner_synthesis == "low"` case is the guardrail: if the AI
    can't cleanly isolate the user's main() (e.g. wrapped in
    IMPLEMENT_APP macro), the worker refuses to compile and surfaces
    the Bring Your Own Runner option.
    """

    overall: ConfidenceLevel
    runner_synthesis: ConfidenceLevel
    link_flags: ConfidenceLevel
    notes: str = ""

    if _PYDANTIC_V2:
        model_config = ConfigDict(extra="ignore")


class BuildManifest(BaseModel):
    """Everything the Rust worker needs to know to compile a user's project.

    Forwarded via the split sidecar (`.synthi_split_meta.json`).
    The worker reads this to assemble compile commands per module
    (core / gui / shared / host_runner) and to decide whether to
    use `swap` or `process_restart` on hot-reload.
    """

    compiler: Compiler = "g++"
    std: str = "c++17"
    common_flags: List[str] = Field(default_factory=list)
    core_link_flags: List[str] = Field(default_factory=list)
    gui_link_flags: List[str] = Field(default_factory=list)
    shared_link_flags: List[str] = Field(default_factory=list)
    runner_link_flags: List[str] = Field(default_factory=list)
    system_packages: List[str] = Field(default_factory=list)
    hot_reload_mode: HotReloadMode = "swap"
    confidence: ConfidenceBlock

    # Forward-compat for V2. V1 rejects non-empty build_steps via
    # validate_manifest_v1() below — the schema ACCEPTS the shape so
    # V2 doesn't need a migration, but V1 refuses execution.
    build_steps: Optional[List[dict]] = None

    if _PYDANTIC_V2:
        model_config = ConfigDict(extra="ignore")


class ManifestRejection(Exception):
    """Raised when a manifest is syntactically valid but V1 cannot execute it.

    The caller converts this into an HTTP 422 with the message in `detail`,
    which the frontend renders as the three-option error card from
    HMR_AGNOSTIC_ULTRAPLAN.md §5.3.
    """

    def __init__(self, message: str, actionable_options: Optional[List[str]] = None):
        super().__init__(message)
        self.message = message
        self.actionable_options = actionable_options or []


REJECTION_MULTI_STEP = (
    "This project needs a pre-compile step that V1 doesn't support yet.\n"
    "\n"
    "V1 only supports frameworks that compile with a single `g++` invocation.\n"
    "Projects requiring Qt MOC, CMake, make, meson, or similar multi-step\n"
    "builds are not yet executable.\n"
    "\n"
    "Options:\n"
    "  - Switch to a simpler framework (SDL2, GLFW, raylib, SFML, ...)\n"
    "  - Use \"Bring Your Own Runner\" mode and manage your build externally,\n"
    "    letting Synthi just swap the `.so` files after your build runs\n"
    "  - Wait for V2 multi-step build support"
)

REJECTION_RUNNER_SYNTHESIS_LOW = (
    "Runner synthesis failed (low confidence).\n"
    "\n"
    "Your project uses a macro-driven or framework-specific entry point that\n"
    "the AI cannot safely untangle into a plain `host_runner.cpp`. HMR cannot\n"
    "proceed without a correct runner.\n"
    "\n"
    "Options:\n"
    "  - Enable \"Bring Your Own Runner\" mode and write your own\n"
    "    `host_runner.cpp` with `// SYNTHI_USER_RUNNER` at the top\n"
    "  - Switch to a framework with a plain `int main()` (SDL2, GLFW, raylib, ...)\n"
    "  - (Advanced) Manually expand the macro into a concrete `main()` and retry"
)


def validate_manifest_v1(manifest: BuildManifest) -> None:
    """V1 execution-gate validator. Raises ManifestRejection on things V1
    knows it can't handle yet (but the schema accepts for forward compat).

    Does NOT check confidence.runner_synthesis == "low" here — that check
    happens in the Rust worker after the response is returned, because
    the user might have Bring Your Own Runner mode enabled (which bypasses
    the low-confidence guardrail). The Python side just validates structure
    and the multi-step build rejection.
    """
    # Point 3: multi-step builds
    if manifest.build_steps:
        raise ManifestRejection(
            REJECTION_MULTI_STEP,
            actionable_options=[
                "switch_framework",
                "bring_your_own_runner",
                "wait_for_v2",
            ],
        )

    # Sanity: compiler must be recognised
    if manifest.compiler not in ("g++", "clang++"):
        raise ManifestRejection(
            f"Unsupported compiler {manifest.compiler!r}. V1 accepts only "
            "`g++` or `clang++`."
        )

    # Sanity: hot_reload_mode matches spec
    if manifest.hot_reload_mode not in ("swap", "process_restart", "auto"):
        raise ManifestRejection(
            f"Unsupported hot_reload_mode {manifest.hot_reload_mode!r}. "
            "V1 accepts `swap`, `process_restart`, or `auto`."
        )


def parse_manifest(raw: dict | str) -> BuildManifest:
    """Parse a raw dict or JSON string into a BuildManifest.

    Raises `ValidationError` on schema mismatch. Caller should catch and
    re-raise as HTTPException(422) with the pydantic error message. Does
    NOT run the V1 execution gate — call `validate_manifest_v1()` after
    parsing if you want the full gate.
    """
    import json as _json

    if isinstance(raw, str):
        raw = _json.loads(raw)

    if not isinstance(raw, dict):
        raise TypeError(
            f"manifest must be a JSON object at the top level, got {type(raw).__name__}"
        )

    if _PYDANTIC_V2:
        return BuildManifest.model_validate(raw)
    return BuildManifest(**raw)  # type: ignore[call-arg]


def manifest_to_dict(manifest: BuildManifest) -> dict:
    """Serialize a BuildManifest back to a plain dict for JSON response."""
    if _PYDANTIC_V2:
        return manifest.model_dump(exclude_none=False)
    return manifest.dict()  # type: ignore[attr-defined]

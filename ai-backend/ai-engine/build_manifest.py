"""
Build manifest schema + V1 validator for the universal split pipeline.

The universal split prompt (llm/prompts.py::UNIVERSAL_SPLIT_PROMPT) asks
the AI to emit a machine-readable JSON block inside the architecture
cache describing how to compile the user's split modules. Python parses
it, validates the shape with pydantic, and forwards it to the Rust worker
via the split sidecar.

The validator here also enforces the include→link rule (see prompts.py
"INCLUDE → LINK RULE" section): every non-stdlib `#include <X.h>` in the
user source must be reflected by a matching link flag in the manifest's
runner_link_flags AND gui_link_flags, OR explicitly excused via
`confidence.notes`. The check is generic — no library catalog — so it
scales to any framework the AI throws at it.

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

import re
from typing import Any, List, Literal, Optional, Set, Tuple

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


# ─────────────────────────────────────────────────────────────────────────────
# INCLUDE → LINK VALIDATOR (generic, library-agnostic)
# ─────────────────────────────────────────────────────────────────────────────
#
# Contract: every non-stdlib `#include <X.h>` in the user source must be
# satisfied by either:
#   (A) a link flag in BOTH runner_link_flags AND gui_link_flags whose
#       name contains the include's identifier as a substring, OR
#   (B) an explicit excuse line in confidence.notes mentioning the
#       include's identifier (header-only, system, etc.)
#
# The check is deliberately heuristic — substring match, not regex,
# not exact match. The goal is "loud failure when the AI obviously
# forgot a flag", not "perfect static analysis". False positives on
# valid manifests would block users; false negatives are the safety
# net Phase 6's heal loop catches.

# C and C++ standard library headers. NOT a library catalog — these are
# bundled with every C++ compiler and never need a -l flag. The list is
# extracted from cppreference's stdlib index. Anything outside this set
# is treated as a third-party include that REQUIRES a corresponding link
# flag (or an explicit confidence.notes excuse).
_STDLIB_HEADERS: Set[str] = {
    # C standard library (C99 + C11)
    "assert.h", "complex.h", "ctype.h", "errno.h", "fenv.h", "float.h",
    "inttypes.h", "iso646.h", "limits.h", "locale.h", "math.h", "setjmp.h",
    "signal.h", "stdalign.h", "stdarg.h", "stdatomic.h", "stdbool.h",
    "stddef.h", "stdint.h", "stdio.h", "stdlib.h", "stdnoreturn.h",
    "string.h", "tgmath.h", "threads.h", "time.h", "uchar.h", "wchar.h",
    "wctype.h",
    # C++ standard library (C++98 → C++23) — names without the .h
    "algorithm", "any", "array", "atomic", "barrier", "bit", "bitset",
    "cassert", "ccomplex", "cctype", "cerrno", "cfenv", "cfloat",
    "charconv", "chrono", "cinttypes", "ciso646", "climits", "clocale",
    "cmath", "codecvt", "compare", "complex", "concepts", "condition_variable",
    "coroutine", "csetjmp", "csignal", "cstdalign", "cstdarg", "cstdbool",
    "cstddef", "cstdint", "cstdio", "cstdlib", "cstring", "ctgmath",
    "ctime", "cuchar", "cwchar", "cwctype", "deque", "exception",
    "execution", "expected", "filesystem", "flat_map", "flat_set",
    "format", "forward_list", "fstream", "functional", "future",
    "generator", "hazard_pointer", "initializer_list", "iomanip", "ios",
    "iosfwd", "iostream", "istream", "iterator", "latch", "limits",
    "list", "locale", "map", "mdspan", "memory", "memory_resource",
    "mutex", "new", "numbers", "numeric", "optional", "ostream",
    "print", "queue", "random", "ranges", "ratio", "rcu", "regex",
    "scoped_allocator", "semaphore", "set", "shared_mutex", "source_location",
    "span", "spanstream", "sstream", "stack", "stacktrace", "stdexcept",
    "stdfloat", "stop_token", "streambuf", "string", "string_view",
    "strstream", "syncstream", "system_error", "text_encoding", "thread",
    "tuple", "type_traits", "typeindex", "typeinfo", "unordered_map",
    "unordered_set", "utility", "valarray", "variant", "vector",
    "version",
    # POSIX / glibc headers (covered by libc — no -l needed beyond stdc)
    "unistd.h", "fcntl.h", "sys/types.h", "sys/stat.h", "sys/mman.h",
    "sys/wait.h", "sys/socket.h", "sys/un.h", "sys/time.h", "sys/select.h",
    "sys/epoll.h", "sys/ioctl.h", "sys/resource.h", "sys/syscall.h",
    "sys/utsname.h", "netinet/in.h", "netinet/tcp.h", "arpa/inet.h",
    "netdb.h", "poll.h", "pwd.h", "grp.h", "syslog.h", "termios.h",
    "dirent.h", "dlfcn.h", "pthread.h", "sched.h", "semaphore.h",
    "execinfo.h", "endian.h", "byteswap.h", "getopt.h", "libgen.h",
    "regex.h", "fnmatch.h", "glob.h", "iconv.h", "wordexp.h", "ftw.h",
    "search.h", "ucontext.h", "spawn.h", "aio.h", "mqueue.h",
    "linux/limits.h", "linux/types.h",
    # GNU extensions / common compiler intrinsics
    "x86intrin.h", "immintrin.h", "emmintrin.h", "smmintrin.h",
    "tmmintrin.h", "xmmintrin.h", "mmintrin.h", "wmmintrin.h",
    "cpuid.h", "stdc-predef.h",
}

# Regex matches both `#include <X>` and `#include "X"`, capturing the
# header path. Skips comments by looking for `#include` at the start of
# a line (after optional whitespace) and not inside a /* */ or // line.
# The simple `#\s*include` pattern is good enough for V1 — the
# pathological cases (multiline macros, conditional preprocessing) are
# rare in user-facing code and would also confuse a real preprocessor.
_INCLUDE_RE = re.compile(
    r'^\s*#\s*include\s*[<"]([^>"]+)[>"]',
    re.MULTILINE,
)


def _strip_block_comments(src: str) -> str:
    """Remove `/* ... */` block comments before include-scanning so that
    a commented-out `#include <fmod.h>` doesn't trigger a false rejection.

    Naive single-pass strip: doesn't handle nested block comments (C/C++
    don't have those anyway) and intentionally leaves `//` line comments
    alone — `_INCLUDE_RE` matches start-of-line so `//` comments don't
    interfere unless someone deliberately writes `//#include<x.h>`, which
    we accept as a missed edge case.
    """
    return re.sub(r"/\*.*?\*/", "", src, flags=re.DOTALL)


def extract_third_party_includes(source: str) -> List[str]:
    """Return the list of non-stdlib include identifiers found in `source`.

    Each return value is the FIRST PATH SEGMENT of the include — so
    `#include <SDL2/SDL.h>` becomes `"SDL2"`, `#include <fmod/core.h>`
    becomes `"fmod"`, `#include <raylib.h>` becomes `"raylib"` (the
    `.h` is stripped). This is what the validator matches against link
    flag names. Order is preserved; duplicates are deduplicated while
    preserving first-seen order.
    """
    cleaned = _strip_block_comments(source)
    seen: Set[str] = set()
    result: List[str] = []
    for match in _INCLUDE_RE.finditer(cleaned):
        header = match.group(1).strip()
        if not header:
            continue
        # Stdlib short-circuit: exact match against the C/C++ stdlib set.
        if header in _STDLIB_HEADERS:
            continue
        # Bare basename match too — `<algorithm>` and `algorithm` should
        # both hit. Already handled above since both forms are in the set.
        # Now extract the identifier:
        first_segment = header.split("/", 1)[0]
        # Strip extension if present (.h, .hpp, .hxx, .H)
        ident = re.sub(r"\.(h|hpp|hxx|H)$", "", first_segment, flags=re.IGNORECASE)
        if not ident:
            continue
        if ident in seen:
            continue
        seen.add(ident)
        result.append(ident)
    return result


def _flag_satisfies(ident: str, flags: List[str]) -> bool:
    """True iff at least one flag in `flags` contains `ident` as a
    case-insensitive substring. Strips the leading `-l` for the match
    so `["-lSDL2"]` satisfies `"SDL"`, `["-lfmod"]` satisfies `"fmod"`.
    """
    needle = ident.lower()
    for f in flags:
        flag_body = f.lower()
        if flag_body.startswith("-l"):
            flag_body = flag_body[2:]
        if needle in flag_body:
            return True
    return False


def _excused_in_notes(ident: str, notes: str) -> bool:
    """True iff confidence.notes mentions `ident` as a substring,
    case-insensitively. The prompt says to write lines like
    `Header-only: stb_image.h (single-file ...)`; we just look for the
    identifier anywhere in the notes string.
    """
    return ident.lower() in notes.lower()


REJECTION_INCLUDE_LINK_MISMATCH_TEMPLATE = (
    "Build manifest is missing a link flag for `#include <{header}>`.\n"
    "\n"
    "The user's source includes `{header}` but the manifest's "
    "{which_flags} does not contain any flag whose name references "
    "`{ident}`.\n"
    "\n"
    "Either:\n"
    "  - add a link flag containing `{ident}` to {which_flags} "
    "(e.g. `-l{ident}`, `-l{ident}-dev`, ...), OR\n"
    "  - add an explanation to `confidence.notes` mentioning `{ident}` "
    "(for header-only / system-bundled libraries)\n"
    "\n"
    "This is the generic INCLUDE → LINK rule from the universal split "
    "prompt — it applies to every non-stdlib include and exists to "
    "prevent silent linker errors at compile time."
)


def validate_include_link_coverage(
    manifest: BuildManifest, source: str
) -> None:
    """Generic include→link rule enforcement.

    Scans `source` for non-stdlib `#include` directives. For each one,
    requires that BOTH `manifest.runner_link_flags` AND
    `manifest.gui_link_flags` contain a flag whose name references the
    include identifier, OR that `manifest.confidence.notes` excuses it
    by mentioning the identifier. Raises `ManifestRejection` on the
    first violation, with a message naming the missing header so the
    AI's retry can target the specific gap.

    Library-agnostic by design — there is no library catalog. The rule
    is purely "does the manifest reference each include the source
    references". A new library tomorrow is handled with zero changes.
    """
    includes = extract_third_party_includes(source)
    if not includes:
        return  # stdlib-only source, nothing to enforce

    notes = manifest.confidence.notes if manifest.confidence else ""
    runner_flags = list(manifest.runner_link_flags)
    gui_flags = list(manifest.gui_link_flags)

    for ident in includes:
        runner_ok = _flag_satisfies(ident, runner_flags)
        gui_ok = _flag_satisfies(ident, gui_flags)
        excused = _excused_in_notes(ident, notes)

        if excused:
            continue
        if runner_ok and gui_ok:
            continue

        # Identify which flag list is missing the reference, so the
        # error message points at the actual gap rather than vaguely
        # saying "missing flag somewhere".
        missing: List[str] = []
        if not gui_ok:
            missing.append("`gui_link_flags`")
        if not runner_ok:
            missing.append("`runner_link_flags`")
        which_flags = " and ".join(missing)

        raise ManifestRejection(
            REJECTION_INCLUDE_LINK_MISMATCH_TEMPLATE.format(
                header=ident,
                ident=ident,
                which_flags=which_flags,
            )
        )

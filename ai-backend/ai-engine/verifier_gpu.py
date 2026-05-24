"""GPU-side verifier — enforces the no-shim contract.

Spec: docs/GPU_HMR_ULTRAPLAN.md §11.4. The host healer is allowed to
emit `{module, operation, anchor, content}` edits to existing files;
this module rejects, mechanically, any output that would amount to a
shim/wrapper — that's the discipline the plan's "agentic, no shims"
promise rests on. Same role as `verifier.py` for the host pipeline,
scoped specifically to the GPU-edit shape.

The rules (verbatim from §11.4) are mechanical so the verifier never
makes a judgement call:

  1. **No file creation.** Only modules already listed in the project's
     `BuildManifest.files` may be edited. Verifier rejects any edit
     whose `module` isn't in that set.

  2. **No wrapper kernels.** Newly-declared `__global__` symbols whose
     names look like a `_safe`/`_v2`/`_fallback` extension of an
     existing kernel — or a `safe_<existing>` prefix — are rejected.

  3. **Signature preservation on Tier 2/3.** For heals targeting the
     manifest-declared device role under the perf or runtime tiers, every
     existing kernel symbol must still exist with an unchanged parameter
     list unless the diff also patches the host launch site for it.

  4. **No new `.cu`/`.hip` files.** The current GPU HMR manifest supports
     one device translation unit role. Multi-TU device builds require a
     later manifest/runtime contract.

In addition, split-path checks (§5.6 item 2):

  - every host launch has been rewritten to `synthi_gpu_launch(...)`,
    and every referenced kernel is declared in the device role file,
  - the declared `gpu.arch` list isn't empty.

The verifier returns a structured rejection (list of `Violation`s)
rather than raising — the orchestrator's MAX_HEAL_RETRIES loop
re-prompts with the rejection notes appended to
`previous_heal_attempts` (§11.3).
"""

from __future__ import annotations

import re
import posixpath
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from typing import Dict, Iterable, List, Mapping, Optional, Set

from agents.abi_stamper import mask_comments_for_parsing, normalize_param_list


HealTier = str  # "compile_hard" | "compile_soft" | "runtime"


# ─────────────────────────────────────────────────────────────────────────────
# Violation types
# ─────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Violation:
    rule: str  # short stable identifier — used in rejection notes
    message: str  # human-readable explanation
    offending_module: Optional[str] = None
    offending_symbol: Optional[str] = None

    def to_dict(self) -> dict:
        d = {"rule": self.rule, "message": self.message}
        if self.offending_module is not None:
            d["offending_module"] = self.offending_module
        if self.offending_symbol is not None:
            d["offending_symbol"] = self.offending_symbol
        return d


@dataclass
class HealVerificationResult:
    ok: bool
    violations: List[Violation] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "ok": self.ok,
            "violations": [v.to_dict() for v in self.violations],
        }


# ─────────────────────────────────────────────────────────────────────────────
# Heal-output verifier (§11.4)
# ─────────────────────────────────────────────────────────────────────────────


_GLOBAL_DECL_RE = re.compile(
    r"(?:"
    r"__global__\s+(?:void\s+)?"
    r"|GLOBAL_KERNEL_SIGNATURE\s*\([^)]*\)\s+(?:__launch_bounds__\s*\([^)]*\)\s*)?"
    r")(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s*\(",
    re.MULTILINE,
)
_QUOTED_INCLUDE_RE = re.compile(r'^\s*#\s*include\s*"([^"]+)"', re.MULTILINE)
_ANY_INCLUDE_RE = re.compile(
    r'^\s*#\s*include\s*(?P<delimiter>[<"])(?P<path>[^>"]+)[>"]',
    re.MULTILINE,
)
_STANDARD_SYSTEM_INCLUDES = {
    "algorithm",
    "array",
    "atomic",
    "bit",
    "cassert",
    "cctype",
    "cerrno",
    "cfloat",
    "chrono",
    "climits",
    "cmath",
    "condition_variable",
    "cstddef",
    "cstdint",
    "cstdio",
    "cstdlib",
    "cstring",
    "deque",
    "exception",
    "filesystem",
    "fstream",
    "functional",
    "initializer_list",
    "iostream",
    "limits",
    "list",
    "map",
    "memory",
    "mutex",
    "new",
    "optional",
    "queue",
    "set",
    "span",
    "sstream",
    "stdexcept",
    "string",
    "string_view",
    "thread",
    "tuple",
    "type_traits",
    "unordered_map",
    "unordered_set",
    "utility",
    "variant",
    "vector",
    "assert.h",
    "ctype.h",
    "dlfcn.h",
    "errno.h",
    "fcntl.h",
    "float.h",
    "inttypes.h",
    "limits.h",
    "math.h",
    "pthread.h",
    "signal.h",
    "stdalign.h",
    "stdarg.h",
    "stdbool.h",
    "stddef.h",
    "stdint.h",
    "stdio.h",
    "stdlib.h",
    "string.h",
    "time.h",
    "unistd.h",
    "windows.h",
}
_ALLOWED_GENERATED_SYSTEM_INCLUDE_PREFIXES = (
    "cuda/",
    "EGL/",
    "GL/",
    "GLES2/",
    "GLES3/",
    "GLFW/",
    "glad/",
    "hip/",
    "hiprt/",
    "linux/",
    "OpenGL/",
    "SDL2/",
    "sys/",
    "vulkan/",
    "webgpu/",
)
_GPU_SDK_VECTOR_TYPE_NAMES = {
    "char2",
    "char3",
    "char4",
    "uchar2",
    "uchar3",
    "uchar4",
    "short2",
    "short3",
    "short4",
    "ushort2",
    "ushort3",
    "ushort4",
    "int2",
    "int3",
    "int4",
    "uint2",
    "uint3",
    "uint4",
    "long2",
    "long3",
    "long4",
    "ulong2",
    "ulong3",
    "ulong4",
    "longlong2",
    "longlong3",
    "longlong4",
    "ulonglong2",
    "ulonglong3",
    "ulonglong4",
    "float2",
    "float3",
    "float4",
    "double2",
    "double3",
    "double4",
    "dim3",
}
_GPU_SDK_VECTOR_TYPE_PATTERN = "|".join(
    re.escape(name)
    for name in sorted(_GPU_SDK_VECTOR_TYPE_NAMES, key=len, reverse=True)
)
_GPU_SDK_VECTOR_STRUCT_RE = re.compile(
    r"\b(?:struct|class)\s+(?P<name>"
    + _GPU_SDK_VECTOR_TYPE_PATTERN
    + r")\b"
)
_GPU_SDK_VECTOR_MAKE_FUNCTION_RE = re.compile(
    r"\b(?:(?:static|inline|constexpr|consteval|__host__|__device__|"
    r"__forceinline__|__inline__|HIPRT_HOST_DEVICE|HIPRT_DEVICE|CUDA_HOST_DEVICE)\s+)*"
    r"(?P<vector_type>"
    + _GPU_SDK_VECTOR_TYPE_PATTERN
    + r")\s+"
    r"(?P<name>make_(?P=vector_type))\s*"
    r"\([^;{}]*\)\s*"
    r"(?:noexcept\s*)?"
    r"\{",
    re.DOTALL,
)
_FORBIDDEN_GPU_RUNTIME_ACCESSOR_RE = re.compile(
    r"\b(?P<name>"
    r"synthi_get_gpu_context|"
    r"synthi_get_context|"
    r"synthi_get_gpu_runtime|"
    r"synthi_gpu_context"
    r")\s*\("
)
_PLACEHOLDER_RENDER_RE = re.compile(
    r"\b(?:TODO|stub|placeholder|rendering logic|draw(?:ing)?\s+code\s+here|"
    r"render(?:ing)?\s+code\s+here|drawing\s+loop|real\s+implementation|omitted)\b"
    r"|\.{3}\s*(?:draw(?:ing)?|render(?:ing)?)",
    re.IGNORECASE,
)
_GUI_BACKEND_PRESENT_RE = re.compile(
    r"\b(?P<name>"
    r"SDL_RenderPresent|"
    r"SDL_GL_SwapWindow|"
    r"glfwSwapBuffers|"
    r"glXSwapBuffers|"
    r"eglSwapBuffers|"
    r"wglSwapLayerBuffers|"
    r"SwapBuffers|"
    r"glutSwapBuffers|"
    r"EndDrawing|"
    r"sfRenderWindow_display"
    r")\s*\("
)
_GUI_CREATES_RENDER_SURFACE_RE = re.compile(
    r"\b(?P<name>"
    r"SDL_CreateWindow|"
    r"SDL_CreateRenderer|"
    r"SDL_GL_CreateContext|"
    r"glfwCreateWindow|"
    r"glutCreateWindow|"
    r"eglCreateWindowSurface|"
    r"XCreateWindow|"
    r"InitWindow|"
    r"sfRenderWindow_create"
    r")\s*\("
)
_SDL_RENDER_API_RE = re.compile(r"\bSDL_Render[A-Za-z0-9_]*\s*\(")
_SDL_SUBSTANTIAL_DRAW_RE = re.compile(
    r"\bSDL_Render(?:FillRect|DrawRect|DrawLine|DrawLines|DrawPoints|Copy|CopyEx|Geometry)\s*\("
)
_OPENGL_RENDER_API_RE = re.compile(
    r"\b(?:glBegin|glDrawArrays|glDrawElements|glDrawPixels|glVertex[234][a-zA-Z]*)\s*\("
)
_GUI_RENDER_EFFECT_RE = re.compile(
    r"\b(?:"
    r"SDL_Render(?:FillRect|DrawRect|DrawLine|DrawLines|DrawPoints|Copy|CopyEx|Geometry)|"
    r"gl(?:Begin|DrawArrays|DrawElements|DrawPixels|Vertex[234][A-Za-z]*|Color[34][A-Za-z]*|TexCoord[234]?[A-Za-z]*)|"
    r"Draw(?:Pixel|Line|Circle|Rectangle|Triangle|Texture|Text|FPS|Poly|Spline|Ring)[A-Za-z0-9_]*|"
    r"sfRenderWindow_draw[A-Za-z0-9_]*"
    r")\s*\("
)
_GUI_RENDER_CONTEXT_RE = re.compile(
    r"\b(?:GLFW/glfw3\.h|GL/gl\.h|OpenGL/gl\.h|gl[A-Z][A-Za-z0-9_]*\s*\()"
)
_OPENGL_SURFACE_API_RE = re.compile(
    r"\b(?:glClear|glClearColor|glViewport|glMatrixMode|glOrtho|gluOrtho2D|"
    r"glBegin|glDrawArrays|glDrawElements|glDrawPixels|glVertex[234][a-zA-Z]*)\s*\("
)
_OPENGL_PROJECTION_RE = re.compile(
    r"\b(?:glOrtho|gluOrtho2D|glFrustum|glMatrixMode\s*\(\s*GL_PROJECTION|glm::ortho)\b"
)
_RENDER_BACKEND_MARKERS = {
    "sdl": re.compile(r"(?:\bSDL_[A-Za-z0-9_]*\b|SDL2?/SDL\.h|SDL2/SDL\.h)"),
    "glfw": re.compile(r"(?:\bGLFWwindow\b|\bglfw[A-Za-z0-9_]*\b|GLFW/glfw3\.h)"),
    "raylib": re.compile(r"(?:\bInitWindow\b|\bBeginDrawing\b|\bEndDrawing\b|raylib\.h)"),
    "sfml": re.compile(r"(?:\bsf::RenderWindow\b|\bsfRenderWindow_[A-Za-z0-9_]*\b|SFML/Graphics\.hpp)"),
    "glut": re.compile(r"(?:\bglutCreateWindow\b|\bglutSwapBuffers\b|GL/glut\.h)"),
}
_GUI_STATE_RENDERER_FIELD_RE = re.compile(r"(?:->|\.)\s*(?P<name>renderer)\b")
_CORE_RENDERER_FIELD_ASSIGN_RE = re.compile(
    r"(?:->|\.)\s*renderer\s*=\s*"
    r"(?:(?:reinterpret_cast|static_cast)\s*<[^>]+>\s*\(\s*)?"
    r"(?:\([^)]*\)\s*)?"
    r"(?:renderer|window_ptr|render_surface|surface|context|host_ctx\s*->\s*renderer|ctx\s*->\s*renderer)\b"
)
_GUI_DEVICE_POINTER_DEREF_RE = re.compile(
    r"(?:->|\.)\s*(?P<name>(?:d_|device)[A-Za-z0-9_]*)\s*\["
)
_GPU_MEM_ALLOC_RE = re.compile(r"\b(?:cudaMalloc|hipMalloc|cuMemAlloc)\s*\(")
_GPU_MEM_INIT_RE = re.compile(
    r"\b(?:cudaMemcpy|hipMemcpy)\s*\([^;]*\b(?:cudaMemcpyHostToDevice|hipMemcpyHostToDevice)\b|"
    r"\b(?:cudaMemset|hipMemset)\s*\(",
    re.DOTALL,
)
_GPU_HOST_TO_DEVICE_COPY_RE = re.compile(
    r"\b(?:cudaMemcpy|hipMemcpy)\s*\([^;]*\b(?:cudaMemcpyHostToDevice|hipMemcpyHostToDevice)\b",
    re.DOTALL,
)
_GPU_DEVICE_TO_HOST_COPY_RE = re.compile(
    r"\b(?:cudaMemcpy|hipMemcpy)\s*\([^;]*\b(?:cudaMemcpyDeviceToHost|hipMemcpyDeviceToHost)\b",
    re.DOTALL,
)
_GPU_INIT_KERNEL_LAUNCH_RE = re.compile(
    r"\bsynthi_gpu_launch\s*\([^;]*\"[^\"]*(?:init|seed|setup|reset)[^\"]*\"",
    re.IGNORECASE | re.DOTALL,
)
_SYNTHI_LAUNCH_RESULT_CHECK_RE = re.compile(
    r"(?:\bif\s*\(\s*synthi_gpu_launch\s*\(|\b(?:const\s+)?(?:bool|auto)(?:\s+const)?\s+[A-Za-z_][A-Za-z0-9_]*\s*=\s*synthi_gpu_launch\s*\()",
    re.DOTALL,
)
_GUI_RENDER_MIRROR_INDEX_RE = re.compile(
    r"(?:->|\.)\s*(?P<name>(?!(?:d_|device))[A-Za-z_][A-Za-z0-9_]*)"
    r"\s*\[[^\]]+\]\s*(?:(?:->|\.)\s*(?P<field>[A-Za-z_][A-Za-z0-9_]*))?"
)
_DEVICE_DESCRIPTOR_INIT_RE = re.compile(
    r"\bDeviceDescriptor\s+[A-Za-z_][A-Za-z0-9_]*\s*=\s*\{(?P<body>.*?)\}\s*;",
    re.DOTALL,
)
_SOURCE_DEVICE_IDENTIFIER_RE = re.compile(r"\bk[A-Z][A-Za-z0-9_]*\b")
_SOURCE_DEVICE_CONST_DECL_RE = re.compile(
    r"\b(?:constexpr\s+|const\s+)?"
    r"(?P<type>(?:std::)?uint32_t|unsigned\s+int|int|float|double)\s+"
    r"(?P<name>k[A-Z][A-Za-z0-9_]*)\s*=",
    re.MULTILINE,
)

_NEW_FILE_OPS = {"create", "new", "add_file"}

_SHIM_SUFFIXES = ("_safe", "_v2", "_v3", "_fallback", "_fixed", "_patched", "_wrap", "_wrapper")
_SHIM_PREFIXES = ("safe_", "fixed_", "patched_", "wrap_")


def _is_shim_name(new_name: str, existing_names: Iterable[str]) -> Optional[str]:
    """Heuristic: is `new_name` a thinly-disguised duplicate of one of
    `existing_names`? Returns the matched existing kernel or None.

    The rule has two halves:

      - `existing + suffix` — `kernel_foo_safe`, `kernel_foo_v2`,
        `kernel_foo_fallback`. Matched by suffix-strip + exact-match.
      - `prefix + existing` — `safe_kernel_foo`, `wrap_kernel_foo`.
        Same idea in reverse.

    Plus a fuzzy backstop: edit distance (Levenshtein-ish via
    `SequenceMatcher`) > 0.85 to an existing name with the same
    length-1 suffix difference is treated as a shim. This catches
    `kernel_foo2` / `kernel_fooSafe` etc. without us enumerating
    every possible mutation.
    """
    existing_set = {n for n in existing_names if n}
    if not existing_set:
        return None

    for suf in _SHIM_SUFFIXES:
        if new_name.endswith(suf):
            stem = new_name[: -len(suf)]
            if stem in existing_set:
                return stem
    for pre in _SHIM_PREFIXES:
        if new_name.startswith(pre):
            stem = new_name[len(pre):]
            if stem in existing_set:
                return stem

    # Fuzzy backstop: > 0.85 similarity AND length delta ≤ 3 AND the
    # new name strictly contains the existing as a substring (drops
    # most coincidental matches like sibling kernels with shared
    # prefixes).
    for existing in existing_set:
        if abs(len(new_name) - len(existing)) > 3:
            continue
        if existing not in new_name and new_name not in existing:
            continue
        if SequenceMatcher(None, new_name, existing).ratio() > 0.85:
            if new_name != existing:
                return existing
    return None


def verify_heal_output(
    *,
    tier: HealTier,
    project_files: Iterable[str],
    edits: List[Mapping[str, str]],
    existing_kernels: Iterable[str],
    existing_device_source: Optional[str] = None,
    host_launch_sites: Optional[Mapping[str, str]] = None,
) -> HealVerificationResult:
    """Run §11.4 mechanical checks against a healer's `edits` list.

    Args:
      tier: which heal tier the prompt fired ("compile_hard" |
        "compile_soft" | "runtime"). Signature-preservation only
        applies on the latter two.
      project_files: iterable of files currently listed in the
        BuildManifest (rule 1: no file creation).
      edits: the healer's `{module, operation, anchor, content}` list.
      existing_kernels: iterable of kernel symbol names defined in the
        pre-heal device role.
      existing_device_source: the unedited device file content (used
        for rule 3 — signature preservation).
      host_launch_sites: kernel name → host launch-site source line,
        used to detect coordinated host updates.

    Returns:
      `HealVerificationResult` with `.ok == True` and an empty
      violations list on a clean pass.
    """
    violations: List[Violation] = []
    project_files_set: Set[str] = set(project_files)
    device_files = {
        f for f in project_files_set
        if f.replace("\\", "/").lower().endswith((".cu", ".hip"))
    }
    allowed_modules = set(project_files_set)
    alias_to_file = _module_aliases(project_files_set)
    allowed_modules.update(alias_to_file)
    existing_kernels_set: Set[str] = {k for k in existing_kernels if k}
    host_sites: Mapping[str, str] = host_launch_sites or {}

    # Rule 1 + 4: no file creation, no new .cu/.hip files.
    for edit in edits:
        module = edit.get("module", "")
        op = (edit.get("operation") or "").lower()
        normalized_module = alias_to_file.get(module, module)
        if op in _NEW_FILE_OPS or module not in allowed_modules:
            violations.append(
                Violation(
                    rule="no_file_creation",
                    message=(
                        f"Heal output edits or creates a file outside the project's "
                        f"BuildManifest: module={module!r} op={op!r}. "
                        f"Allowed files: {sorted(project_files_set)}"
                    ),
                    offending_module=module,
                )
            )
        if normalized_module.endswith((".cu", ".hip")) and normalized_module not in device_files:
            violations.append(
                Violation(
                    rule="no_extra_device_tu",
                    message=(
                        f"Heal output introduces a new device translation unit: {module!r}. "
                        "Multi-TU device builds require a later manifest/runtime "
                        "contract; the current contract supports one device role."
                    ),
                    offending_module=module,
                )
            )

    # Rule 2: no wrapper kernels.
    device_edits = [
        {**e, "module": alias_to_file.get(e.get("module", ""), e.get("module", ""))}
        for e in edits
        if alias_to_file.get(e.get("module", ""), e.get("module", "")) in device_files
    ]
    introduced_kernels = _collect_new_kernels(device_edits, existing_kernels_set)
    for new_name in introduced_kernels:
        existing_match = _is_shim_name(new_name, existing_kernels_set)
        if existing_match is not None:
            violations.append(
                Violation(
                    rule="no_wrapper_kernel",
                    message=(
                        f"Heal output introduces __global__ {new_name!r} that "
                        f"resembles an existing kernel {existing_match!r}. Patch "
                        "the existing kernel in place rather than adding a wrapper."
                    ),
                    offending_module=alias_to_file.get("device", "device"),
                    offending_symbol=new_name,
                )
            )

    # Rule 3: signature preservation on Tier 2/3.
    if tier in {"compile_soft", "runtime"} and existing_device_source:
        post_source = _apply_edits_dry_run(existing_device_source, device_edits)
        post_kernel_sigs = _collect_kernel_signatures(post_source)
        pre_kernel_sigs = _collect_kernel_signatures(existing_device_source)
        for name, pre_sig in pre_kernel_sigs.items():
            post_sig = post_kernel_sigs.get(name)
            if post_sig is None:
                # Removed — accept only if the heal also removed the
                # host launch site for this kernel.
                if name in host_sites and not _host_site_was_removed(
                    name, host_sites, edits
                ):
                    violations.append(
                        Violation(
                            rule="signature_preserved_missing_host_update",
                            message=(
                                f"Tier-{tier} heal removed kernel {name!r} "
                                "without removing/updating its host launch "
                                "site. Patch both sides in one edit batch."
                            ),
                            offending_module=alias_to_file.get("device", "device"),
                            offending_symbol=name,
                        )
                    )
            elif post_sig != pre_sig:
                if not _host_site_was_updated(name, host_sites, edits):
                    violations.append(
                        Violation(
                            rule="signature_changed_without_host_update",
                            message=(
                                f"Tier-{tier} heal changed signature of kernel "
                                f"{name!r} without a matching host launch-site "
                                "update. Patch both sides in one edit batch."
                            ),
                            offending_module=alias_to_file.get("device", "device"),
                            offending_symbol=name,
                        )
                    )

    return HealVerificationResult(ok=not violations, violations=violations)


# ─────────────────────────────────────────────────────────────────────────────
# Split-output verifier (§5.6 item 2)
# ─────────────────────────────────────────────────────────────────────────────


@dataclass
class SplitVerificationResult:
    ok: bool
    violations: List[Violation] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "ok": self.ok,
            "violations": [v.to_dict() for v in self.violations],
        }


_RAW_LAUNCH_CALL_RE = re.compile(
    r"(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s*<<<[^;]{0,256}?>>>",
)
_SYNTHI_LAUNCH_CALL_RE = re.compile(
    r"\bsynthi_gpu_launch\s*\(\s*[^,]+,\s*[\"'](?P<name>[A-Za-z_][A-Za-z0-9_]*)[\"']",
    re.DOTALL,
)
_SYNTHI_LAUNCH_BYPASS_RE = re.compile(
    r"\bsynthi_gpu_(?:launch_raw(?:_checked)?|launch_table|launch_generation)\s*\(",
    re.DOTALL,
)
_CPP_CAST_RE = re.compile(
    r"\b(?:reinterpret_cast|static_cast|const_cast)\s*<(?P<type>[^>]+)>\s*"
    r"\(\s*(?P<expr>.*?)\s*\)\s*$",
    re.DOTALL,
)
_CPP_C_STYLE_VOID_CAST_RE = re.compile(
    r"^\(\s*(?:const\s+)?void\s*\*\s*\)\s*",
    re.DOTALL,
)
_CPP_DECL_TYPE_TEMPLATE = (
    r"(?:^|[;\n{{}}])\s*"
    r"(?P<type>"
    r"(?:(?:static|inline|thread_local|extern|const|constexpr|volatile|mutable)\s+)*"
    r"(?:struct\s+|class\s+)?"
    r"[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*"
    r"(?:\s*<[^;{{}}()=]+>)?"
    r"(?:\s*[*&])?"
    r")\s+"
    r"{name}\b\s*(?:\[[^\]]*\])?\s*(?:[=;{{,)]|\))"
)
_CPP_DECL_KEYWORDS = {
    "return",
    "if",
    "for",
    "while",
    "switch",
    "case",
    "else",
    "sizeof",
    "alignof",
}


def _iter_call_bodies(source: str, name: str) -> Iterable[str]:
    needle = f"{name}("
    cursor = 0
    while True:
        start = source.find(needle, cursor)
        if start < 0:
            return
        i = start + len(needle)
        depth = 1
        while i < len(source) and depth:
            if source[i] == "(":
                depth += 1
            elif source[i] == ")":
                depth -= 1
            i += 1
        if depth == 0:
            yield source[start + len(needle): i - 1]
            cursor = i
        else:
            return


def _split_top_level_args(body: str) -> List[str]:
    args: List[str] = []
    start = 0
    depth = 0
    pairs = {"(": ")", "{": "}", "[": "]"}
    closers = set(pairs.values())
    stack: List[str] = []
    for i, ch in enumerate(body):
        if ch in pairs:
            stack.append(pairs[ch])
            depth += 1
        elif ch in closers and stack and ch == stack[-1]:
            stack.pop()
            depth -= 1
        elif ch == "," and depth == 0:
            args.append(body[start:i].strip())
            start = i + 1
    tail = body[start:].strip()
    if tail:
        args.append(tail)
    return args


def _function_body(source: str, name: str) -> str:
    masked = mask_comments_for_parsing(source)
    for match in re.finditer(rf"\b{re.escape(name)}\s*\(", masked):
        params_end = _balanced_end(masked, match.end() - 1, "(", ")")
        if params_end is None:
            continue
        body_open = _next_function_body_open(masked, params_end)
        if body_open is None:
            continue
        body_close = _balanced_end(masked, body_open, "{", "}")
        if body_close is None:
            continue
        return source[body_open + 1 : body_close - 1]
    return ""


def _balanced_end(source: str, open_index: int, open_ch: str, close_ch: str) -> Optional[int]:
    if open_index < 0 or open_index >= len(source) or source[open_index] != open_ch:
        return None
    i = open_index + 1
    depth = 1
    while i < len(source):
        if source[i] == open_ch:
            depth += 1
        elif source[i] == close_ch:
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    return None


def _next_function_body_open(masked_source: str, start: int) -> Optional[int]:
    i = start
    n = len(masked_source)
    while i < n:
        while i < n and masked_source[i].isspace():
            i += 1
        if i >= n:
            return None
        if masked_source[i] == "{":
            return i
        if masked_source[i] == "#":
            while i < n and masked_source[i] not in "\r\n":
                i += 1
            continue
        return None
    return None


def _function_param_names(source: str, name: str) -> List[str]:
    match = re.search(rf"\b{name}\s*\((?P<params>[^)]*)\)", source, re.DOTALL)
    if not match:
        return []
    names: List[str] = []
    for param in _split_top_level_args(match.group("params")):
        tokens = re.findall(r"[A-Za-z_][A-Za-z0-9_]*", param)
        if tokens:
            names.append(tokens[-1])
    return names


def _normalize_cpp_type_name(type_text: str) -> str:
    value = re.sub(r"/\*.*?\*/", " ", type_text, flags=re.DOTALL)
    value = re.sub(r"\b(?:const|volatile|static|inline|thread_local|extern|mutable)\b", " ", value)
    value = re.sub(r"\b(?:struct|class)\b", " ", value)
    value = value.replace("*", " ").replace("&", " ")
    value = re.sub(r"\s+", "", value)
    value = value.strip(":")
    return value


def _cpp_type_compatible(a: str, b: str) -> bool:
    left = _normalize_cpp_type_name(a)
    right = _normalize_cpp_type_name(b)
    if not left or not right:
        return False
    if left == right:
        return True
    return left.rsplit("::", 1)[-1] == right.rsplit("::", 1)[-1]


def _cpp_type_basename(type_text: str) -> str:
    normalized = _normalize_cpp_type_name(type_text)
    return normalized.rsplit("::", 1)[-1] if normalized else ""


def _declared_record_type_basenames(source: str) -> Set[str]:
    return {
        match.group("name")
        for match in re.finditer(
            r"\b(?:struct|class)\s+(?P<name>[A-Za-z_][A-Za-z0-9_]*)\b",
            source,
        )
    }


def _iter_namespace_bodies(source: str) -> Iterable[tuple[str, str]]:
    namespace_re = re.compile(r"\bnamespace\s+(?P<namespace>[A-Za-z_][A-Za-z0-9_]*)\s*\{")
    for match in namespace_re.finditer(source):
        body_start = match.end()
        depth = 1
        cursor = body_start
        while cursor < len(source) and depth:
            if source[cursor] == "{":
                depth += 1
            elif source[cursor] == "}":
                depth -= 1
            cursor += 1
        if depth == 0:
            yield match.group("namespace"), source[body_start : cursor - 1]


def _namespaced_shared_symbols(shared_source: str) -> Dict[str, Set[str]]:
    symbols: Dict[str, Set[str]] = {}
    symbol_re = re.compile(
        r"\b(?:constexpr|const)\s+"
        r"(?:[A-Za-z_][A-Za-z0-9_:<>]*\s+)+"
        r"(?P<name>k[A-Z][A-Za-z0-9_]*)\b"
    )
    for namespace, body in _iter_namespace_bodies(shared_source):
        names = {match.group("name") for match in symbol_re.finditer(body)}
        if names:
            symbols.setdefault(namespace, set()).update(names)
    return symbols


def _uses_shared_symbol_unqualified(source: str, namespace: str, symbol: str) -> bool:
    if re.search(rf"\busing\s+namespace\s+{re.escape(namespace)}\s*;", source):
        return False
    if re.search(rf"\busing\s+{re.escape(namespace)}::{re.escape(symbol)}\s*;", source):
        return False
    bare_re = re.compile(rf"(?<![:.\w]){re.escape(symbol)}\b")
    for match in bare_re.finditer(source):
        prefix_start = max(0, match.start() - len(namespace) - 2)
        if source[prefix_start:match.start()] == f"{namespace}::":
            continue
        return True
    return False


def _strip_cpp_casts(expr: str) -> str:
    out = expr.strip()
    changed = True
    while changed:
        changed = False
        cast = _CPP_CAST_RE.match(out)
        if cast:
            out = cast.group("expr").strip()
            changed = True
        out2 = _CPP_C_STYLE_VOID_CAST_RE.sub("", out).strip()
        if out2 != out:
            out = out2
            changed = True
    return out.strip()


def _return_state_variable(expr: str) -> Optional[str]:
    value = _strip_cpp_casts(expr)
    value = re.sub(r"^\s*&\s*", "", value)
    value = value.strip()
    while value.startswith("(") and value.endswith(")"):
        value = value[1:-1].strip()
    match = re.match(r"(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s*$", value)
    return match.group("name") if match else None


def _declared_variable_type(source: str, name: str) -> Optional[str]:
    pattern = re.compile(
        _CPP_DECL_TYPE_TEMPLATE.format(name=re.escape(name)),
        re.DOTALL,
    )
    for match in pattern.finditer(source):
        type_name = _normalize_cpp_type_name(match.group("type"))
        if not type_name or type_name in _CPP_DECL_KEYWORDS:
            continue
        return type_name
    return None


def _core_returned_state_types(core_source: str) -> Set[str]:
    body = _function_body(core_source, "core_on_load")
    if not body:
        return set()
    types: Set[str] = set()
    search_blobs = (body, core_source)
    for match in re.finditer(r"\breturn\s+(?P<expr>[^;]+);", body):
        variable = _return_state_variable(match.group("expr"))
        if not variable or variable in {"nullptr", "NULL", "null"}:
            continue
        for blob in search_blobs:
            declared_type = _declared_variable_type(blob, variable)
            if declared_type:
                types.add(declared_type)
                break
    return types


def _gui_render_state_cast_types(gui_source: str) -> Set[str]:
    body = _function_body(gui_source, "gui_on_render")
    if not body:
        return set()
    param_names = _function_param_names(gui_source, "gui_on_render")
    if not param_names:
        return set()
    state_param = param_names[0]
    cast_types: Set[str] = set()
    escaped = re.escape(state_param)
    cpp_cast_re = re.compile(
        rf"\b(?:reinterpret_cast|static_cast|const_cast)\s*<(?P<type>[^>]+)>\s*"
        rf"\(\s*{escaped}\s*\)",
        re.DOTALL,
    )
    c_style_cast_re = re.compile(
        rf"\(\s*(?P<type>[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*"
        rf"(?:\s*<[^;{{}}()=]+>)?\s*[*&]?)\s*\)\s*{escaped}\b",
        re.DOTALL,
    )
    for pattern in (cpp_cast_re, c_style_cast_re):
        for match in pattern.finditer(body):
            normalized = _normalize_cpp_type_name(match.group("type"))
            if normalized and normalized not in {"void", "auto"}:
                cast_types.add(normalized)
    return cast_types


def _device_kernel_params(source: str, name: str) -> List[str]:
    masked = mask_comments_for_parsing(source)
    match = re.search(
        rf"\b(?:"
        rf"(?:extern\s+\"C\"\s+)?__global__\s+(?:void\s+)?"
        rf"|GLOBAL_KERNEL_SIGNATURE\s*\([^)]*\)\s+"
        rf"(?:__launch_bounds__\s*\([^)]*\)\s*)?"
        rf")"
        rf"{re.escape(name)}\s*\((?P<params>[^)]*)\)",
        masked,
        re.DOTALL,
    )
    if not match:
        return []
    return _split_top_level_args(match.group("params"))


def _device_kernel_pointer_param_indexes(source: str, name: str) -> List[int]:
    return [i for i, param in enumerate(_device_kernel_params(source, name)) if "*" in param]


def _device_kernel_pointer_param_names(source: str, name: str) -> List[str]:
    names: List[str] = []
    for param in _device_kernel_params(source, name):
        if "*" not in param:
            continue
        tokens = re.findall(r"[A-Za-z_][A-Za-z0-9_]*", param)
        if tokens:
            names.append(tokens[-1])
    return names


def _device_kernel_pointer_param_init_requirements(source: str, name: str) -> dict[int, bool]:
    requirements: dict[int, bool] = {}
    for index, param in enumerate(_device_kernel_params(source, name)):
        if "*" not in param:
            continue
        tokens = re.findall(r"[A-Za-z_][A-Za-z0-9_]*", param)
        if not tokens:
            requirements[index] = True
            continue
        requirements[index] = _pointer_param_requires_initialization(
            source,
            name,
            declaration=param,
            param_name=tokens[-1],
        )
    return requirements


def _pointer_param_requires_initialization(
    source: str,
    kernel_name: str,
    *,
    declaration: str,
    param_name: str,
) -> bool:
    star_at = declaration.find("*")
    if star_at < 0:
        return False
    if re.search(r"\bconst\b", declaration[:star_at]):
        return True
    body = _function_body(source, kernel_name)
    if not body:
        return True
    return _pointer_param_body_requires_initialization(body, param_name)


def _pointer_param_body_requires_initialization(body: str, param_name: str) -> bool:
    masked = mask_comments_for_parsing(body)
    pattern = re.compile(rf"\b{re.escape(param_name)}\b")
    for match in pattern.finditer(masked):
        if _pointer_param_occurrence_is_plain_write(masked, match):
            continue
        if _pointer_param_occurrence_is_address_check(masked, match):
            continue
        return True
    return False


def _pointer_param_occurrence_is_plain_write(body: str, match: re.Match[str]) -> bool:
    tail = body[match.end() :]
    tail = re.sub(r"^\s*", "", tail)
    if tail.startswith("["):
        close = _balanced_end(tail, 0, "[", "]")
        if close is None:
            return False
        after = tail[close:]
    elif tail.startswith("->"):
        field = re.match(r"->\s*[A-Za-z_][A-Za-z0-9_]*", tail)
        if not field:
            return False
        after = tail[field.end() :]
    else:
        head = body[max(0, match.start() - 4) : match.start()]
        if not re.search(r"(?:^|[^A-Za-z0-9_])\*\s*$", head):
            return False
        after = tail

    assign = re.match(r"\s*(?P<op>[+\-*/%&|^]?=)", after)
    if not assign:
        return False
    return assign.group("op") == "="


def _pointer_param_occurrence_is_address_check(body: str, match: re.Match[str]) -> bool:
    start = max(0, match.start() - 32)
    end = min(len(body), match.end() + 32)
    window = body[start:end]
    relative_start = match.start() - start
    relative_end = match.end() - start
    before = window[:relative_start]
    after = window[relative_end:]
    if re.search(r"\b(?:if|while)\s*\([^()]*$", before) and re.match(r"\s*(?:\)|&&|\|\|)", after):
        return True
    return False


def _launch_kernel_name(arg: str) -> Optional[str]:
    match = re.match(r'\s*["\'](?P<name>[A-Za-z_][A-Za-z0-9_]*)["\']\s*$', arg)
    return match.group("name") if match else None


def _launch_initializer_args(arg: str) -> List[str]:
    arg = arg.strip()
    if not (arg.startswith("{") and arg.endswith("}")):
        return []
    return _split_top_level_args(arg[1:-1])


def _normalize_launch_buffer_arg(arg: str) -> str:
    arg = arg.strip()
    arg = re.sub(r"^\s*&\s*", "", arg)
    return re.sub(r"\s+", "", arg)


def _strip_cpp_comments(source: str) -> str:
    return re.sub(r"//.*?$|/\*.*?\*/", " ", source, flags=re.MULTILINE | re.DOTALL)


def _missing_init_launch_buffers(core_source: str, device_source: str) -> Set[str]:
    return set(_missing_init_launch_buffer_sources(core_source, device_source))


def _missing_init_launch_buffer_sources(core_source: str, device_source: str) -> dict[str, Set[str]]:
    required: Set[str] = set()
    required_by_kernel: dict[str, Set[str]] = {}
    initialized: Set[str] = set()
    for body in _iter_call_bodies(core_source, "synthi_gpu_launch"):
        args = _split_top_level_args(body)
        if len(args) != 7:
            continue
        kernel_name = _launch_kernel_name(args[1])
        if not kernel_name:
            continue
        launch_args = _launch_initializer_args(args[-1])
        if not launch_args:
            continue
        pointer_requirements = _device_kernel_pointer_param_init_requirements(
            device_source,
            kernel_name,
        )
        all_pointer_buffers = {
            _normalize_launch_buffer_arg(launch_args[i])
            for i in pointer_requirements
            if i < len(launch_args)
        }
        required_pointer_buffers = {
            _normalize_launch_buffer_arg(launch_args[i])
            for i, requires_init in pointer_requirements.items()
            if requires_init
            if i < len(launch_args)
        }
        if re.search(r"(?:init|seed|setup|reset)", kernel_name, re.IGNORECASE):
            initialized.update(all_pointer_buffers)
        else:
            required.update(required_pointer_buffers)
            for pointer_buffer in required_pointer_buffers:
                required_by_kernel.setdefault(pointer_buffer, set()).add(kernel_name)
    return {
        buf: required_by_kernel.get(buf, set())
        for buf in required
        if buf not in initialized
    }


def _host_runner_routes_gui_module(host_runner_source: str) -> bool:
    if not host_runner_source:
        return True

    resolves_gui_render = bool(
        re.search(
            r"\b(?:dlsym|GetProcAddress)\s*\([^;]*[\"']gui_on_render[\"']",
            host_runner_source,
            re.DOTALL,
        )
        or re.search(
            r"\bgui_on_render\s*\(",
            _strip_cpp_comments(host_runner_source),
        )
    )
    if not resolves_gui_render:
        return False

    code = _strip_cpp_comments(host_runner_source)
    call_pattern = re.compile(
        r"\b(?!(?:dlsym|GetProcAddress|decltype|typedef|using|if|while|for|switch)\b)"
        r"(?P<callee>[A-Za-z_][A-Za-z0-9_]*(?:\s*(?:->|\.)\s*[A-Za-z_][A-Za-z0-9_]*)*)"
        r"\s*\((?P<args>[^(){};]*)\)\s*;",
        re.DOTALL,
    )
    for match in call_pattern.finditer(code):
        callee = re.sub(r"\s+", "", match.group("callee"))
        args = match.group("args")
        if "render" in callee.lower() and re.search(r"\b(?:state|core_state|app_state)\b", args):
            return True
    return False


def _mirror_allocated_in_load(core_load_body: str, mirror: str) -> bool:
    field = re.escape(mirror)
    return bool(
        re.search(
            rf"(?:->|\.)\s*{field}\s*=\s*[^;]*(?:\bnew\b|\b(?:std::)?(?:malloc|calloc)\s*\()",
            core_load_body,
        )
    )


def _mirror_initialized_in_load(core_load_body: str, mirror: str, fields: Set[str]) -> bool:
    field = re.escape(mirror)
    indexed_access = rf"(?:->|\.)\s*{field}\s*\[[^\]]+\]"
    aggregate_assignment = re.search(rf"{indexed_access}\s*=", core_load_body)
    copy_assignment = re.search(
        rf"\b(?:memcpy|std::copy(?:_n)?)\s*\([^;]*(?:->|\.)\s*{field}\b",
        core_load_body,
    )
    if aggregate_assignment or copy_assignment:
        return True
    if not fields:
        return bool(
            re.search(
                rf"{indexed_access}\s*(?:->|\.)\s*[A-Za-z_][A-Za-z0-9_]*\s*=",
                core_load_body,
            )
        )
    return all(
        re.search(rf"{indexed_access}\s*(?:->|\.)\s*{re.escape(member)}\s*=", core_load_body)
        for member in fields
    )


def _source_device_files(source_files: Optional[Mapping[str, str]]) -> Mapping[str, str]:
    if not source_files:
        return {}
    return {
        path: source
        for path, source in source_files.items()
        if _is_source_device_file(path, source)
    }


def _resolve_source_include(
    include_path: str,
    source_device_sources: Mapping[str, str],
) -> Optional[str]:
    normalized = include_path.replace("\\", "/").lstrip("./")
    if normalized in source_device_sources:
        return normalized
    matches = [
        path
        for path in source_device_sources
        if path.endswith("/" + normalized)
        or (path.startswith("src/") and path[4:] == normalized)
    ]
    if len(matches) == 1:
        return matches[0]
    return None


def _resolve_project_include(
    include_path: str,
    source_files: Optional[Mapping[str, str]],
) -> Optional[str]:
    if not source_files:
        return None
    normalized_sources = {path.replace("\\", "/"): source for path, source in source_files.items()}
    normalized = include_path.replace("\\", "/").lstrip("./")
    if normalized in normalized_sources:
        return normalized
    matches = [
        path
        for path in normalized_sources
        if path.endswith("/" + normalized)
        or (path.startswith("src/") and path[4:] == normalized)
    ]
    if len(matches) == 1:
        return matches[0]
    basename = normalized.rsplit("/", 1)[-1]
    basename_matches = [
        path
        for path in normalized_sources
        if path.rsplit("/", 1)[-1] == basename
    ]
    if len(basename_matches) == 1:
        return basename_matches[0]
    return None


def _is_allowed_generated_system_include(include_path: str) -> bool:
    normalized = include_path.replace("\\", "/").lstrip("./")
    if not normalized:
        return False
    if normalized in _STANDARD_SYSTEM_INCLUDES:
        return True
    return normalized.startswith(_ALLOWED_GENERATED_SYSTEM_INCLUDE_PREFIXES)


def _device_role_included_source_files(
    device_source: str,
    source_device_sources: Mapping[str, str],
) -> Mapping[str, str]:
    included: dict[str, str] = {}
    queue: List[str] = []
    for match in _QUOTED_INCLUDE_RE.finditer(device_source):
        resolved = _resolve_source_include(match.group(1).strip(), source_device_sources)
        if resolved is not None:
            queue.append(resolved)
    while queue:
        resolved = queue.pop(0)
        if resolved in included:
            continue
        source = source_device_sources.get(resolved)
        if source is None:
            continue
        included[resolved] = source
        for match in _QUOTED_INCLUDE_RE.finditer(source):
            child = _resolve_source_include(match.group(1).strip(), source_device_sources)
            if child is not None and child not in included:
                queue.append(child)
    return included


def _is_source_device_file(path: str, source: str) -> bool:
    normalized = path.replace("\\", "/").lower()
    masked = mask_comments_for_parsing(source)
    if normalized.endswith((".cu", ".hip")):
        return True
    if not normalized.endswith((".cuh", ".hpp", ".hh", ".h")):
        return False
    return bool(
        "__global__" in masked
        or "__device__" in masked
        or "GLOBAL_KERNEL_SIGNATURE" in masked
        or "HIPRT_DEVICE" in masked
        or "HIPRT_HOST_DEVICE" in masked
    )


def _render_backends_in_sources(sources: Iterable[str]) -> Set[str]:
    found: Set[str] = set()
    for source in sources:
        for backend, pattern in _RENDER_BACKEND_MARKERS.items():
            if pattern.search(source):
                found.add(backend)
    return found


def _source_device_identifiers(source_device_sources: Mapping[str, str]) -> Set[str]:
    identifiers: Set[str] = set()
    for source in source_device_sources.values():
        masked = mask_comments_for_parsing(source)
        if (
            "__global__" not in masked
            and "__device__" not in masked
            and "GLOBAL_KERNEL_SIGNATURE" not in masked
        ):
            continue
        identifiers.update(_SOURCE_DEVICE_IDENTIFIER_RE.findall(masked))
    return identifiers


def _source_device_constant_declarations(source_device_sources: Mapping[str, str]) -> Mapping[str, str]:
    declarations: dict[str, str] = {}
    for source in source_device_sources.values():
        masked = mask_comments_for_parsing(source)
        if (
            "__global__" not in masked
            and "__device__" not in masked
            and "GLOBAL_KERNEL_SIGNATURE" not in masked
        ):
            continue
        for match in _SOURCE_DEVICE_CONST_DECL_RE.finditer(masked):
            declarations[match.group("name")] = re.sub(r"\s+", " ", match.group("type").strip())
    return declarations


def _source_body_effectively_empty(body: str) -> bool:
    without_block_comments = re.sub(r"/\*.*?\*/", "", body, flags=re.DOTALL)
    without_line_comments = re.sub(r"//.*", "", without_block_comments)
    return not without_line_comments.strip()


def _manifest_role_path(manifest: Optional[Mapping[str, object]], role: str) -> Optional[str]:
    if not isinstance(manifest, dict):
        return None
    module_files = manifest.get("module_files")
    if not isinstance(module_files, dict):
        return None
    value = module_files.get(role)
    if not isinstance(value, str) or not value.strip():
        return None
    return value.strip().lstrip("./").replace("\\", "/")


def _normalize_generated_path(path: str) -> str:
    value = path.strip().replace("\\", "/")
    while value.startswith("./"):
        value = value[2:]
    return posixpath.normpath(value)


def _resolve_split_role_paths(
    files: Mapping[str, str],
    manifest: Optional[Mapping[str, object]],
) -> dict[str, Optional[str]]:
    def first_existing(candidates: Iterable[str]) -> Optional[str]:
        for candidate in candidates:
            if candidate in files:
                return candidate
        return None

    paths: dict[str, Optional[str]] = {}
    fallback_candidates = {
        "shared": ("shared.h",),
        "core": ("core.cpp",),
        "gui": ("gui.cpp",),
        "host_runner": ("host_runner.cpp",),
    }
    for role, candidates in fallback_candidates.items():
        declared = _manifest_role_path(manifest, role)
        paths[role] = declared if declared else first_existing(candidates)

    declared_device = _manifest_role_path(manifest, "device")
    if declared_device:
        paths["device"] = declared_device
    else:
        paths["device"] = first_existing(("device.cu", "device.hip"))
        if paths["device"] is None:
            paths["device"] = next(
                (
                    name
                    for name in files
                    if name.replace("\\", "/").lower().endswith((".cu", ".hip"))
                ),
                None,
            )
    return paths


def verify_split_output(
    *,
    files: Mapping[str, str],
    manifest_arch: Iterable[str],
    manifest: Optional[Mapping[str, object]] = None,
    source_files: Optional[Mapping[str, str]] = None,
) -> SplitVerificationResult:
    """Verify the Kernel Splitter Agent's output (§5.6 item 2).

    Asserts:

      - `manifest_arch` is non-empty (the Rust mirror's
        `validate_manifest_v1` also catches this, but failing here
        gives the LLM a tighter retry signal).
      - every host launch site uses `synthi_gpu_launch(...)`, not raw
        CUDA/HIP triple-chevron syntax.
      - every `synthi_gpu_launch(...)` kernel name is declared in
        the manifest-declared device role file.
      - the manifest-declared shared role includes the worker-generated
        `synthi_gpu_runtime.h` ABI header instead of inventing local
        launch/lifecycle declarations.
      - the split contains every current GPU HMR semantic role. Filenames
        come from `compile_manifest.module_files`; canonical names are only
        fallbacks for older outputs.
    """
    violations: List[Violation] = []
    if not list(manifest_arch):
        violations.append(
            Violation(
                rule="manifest_arch_empty",
                message="gpu.arch must list at least one target arch.",
            )
        )

    role_paths = _resolve_split_role_paths(files, manifest)
    for role in ("shared", "core", "gui", "host_runner"):
        path = role_paths.get(role)
        if not path or path not in files:
            violations.append(
                Violation(
                    rule="split_missing_file",
                    message=f"Split output is missing required {role} role file.",
                    offending_module=path or role,
                )
            )
    device_path = role_paths.get("device")
    if not device_path or device_path not in files:
        violations.append(
            Violation(
                rule="split_missing_device_file",
                message=(
                    "GPU split output is missing the manifest-declared device "
                    "role file. Kernels must live in the dedicated device role."
                ),
                offending_module=device_path or "device",
            )
        )

    shared_path = role_paths.get("shared") or "shared"
    core_path = role_paths.get("core") or "core"
    gui_path = role_paths.get("gui") or "gui"
    host_runner_path = role_paths.get("host_runner") or "host_runner"
    device_path = role_paths.get("device") or "device"
    device_source = files.get(device_path) or ""
    source_device_sources = _source_device_files(source_files)
    source_blob = "\n".join(source_files.values()) if source_files else ""
    source_render_backends = _render_backends_in_sources(
        source_files.values() if source_files else []
    )
    device_included_sources = _device_role_included_source_files(device_source, source_device_sources)
    device_semantic_source = "\n".join(
        [device_source, *device_included_sources.values()]
    )

    allowed_include_paths: Set[str] = {"synthi_gpu_runtime.h"}
    for path in (shared_path, core_path, gui_path, host_runner_path, device_path):
        if path and path in files:
            normalized = _normalize_generated_path(path)
            allowed_include_paths.add(normalized)
            allowed_include_paths.add(posixpath.basename(normalized))

    for role_path in (shared_path, core_path, gui_path, host_runner_path, device_path):
        src = files.get(role_path)
        if not src:
            continue
        role_dir = posixpath.dirname(_normalize_generated_path(role_path))
        for match in _ANY_INCLUDE_RE.finditer(src):
            included = match.group("path").strip()
            delimiter = match.group("delimiter")
            normalized_include = _normalize_generated_path(included)
            basename = posixpath.basename(normalized_include)
            resolved_from_role = _normalize_generated_path(
                posixpath.join(role_dir, included)
            )
            if (
                normalized_include in allowed_include_paths
                or basename in allowed_include_paths
                or resolved_from_role in allowed_include_paths
                or (
                    role_path == device_path
                    and _resolve_source_include(included, source_device_sources) is not None
                )
            ):
                continue
            if (
                role_path != device_path
                and _resolve_project_include(included, source_files) is not None
            ) or (
                role_path != device_path
                and not _is_allowed_generated_system_include(included)
            ) or delimiter == '"':
                violations.append(
                    Violation(
                        rule="generated_role_includes_project_header",
                        message=(
                            f"Generated role file includes project header {included!r}. "
                            "GPU split output must be self-contained role code: use the "
                            "provided workspace files as source context and copy/adapt "
                            "needed structs, constants, and helpers into the generated "
                            "roles instead of including original user project headers."
                        ),
                        offending_module=role_path,
                        offending_symbol=included,
                    )
                )
                continue
        for match in _GPU_SDK_VECTOR_STRUCT_RE.finditer(mask_comments_for_parsing(src)):
            violations.append(
                Violation(
                    rule="generated_role_redeclares_gpu_sdk_type",
                    message=(
                        f"Generated role file redeclares GPU SDK vector type "
                        f"{match.group('name')!r}. HIP/CUDA runtime headers own "
                        "these ABI names; generated roles must use the SDK type "
                        "instead of shadowing it with local structs."
                    ),
                    offending_module=role_path,
                    offending_symbol=match.group("name"),
                )
            )
        for match in _GPU_SDK_VECTOR_MAKE_FUNCTION_RE.finditer(mask_comments_for_parsing(src)):
            violations.append(
                Violation(
                    rule="generated_role_redeclares_gpu_sdk_type",
                    message=(
                        f"Generated role file redeclares GPU SDK vector constructor "
                        f"helper {match.group('name')!r}. HIP/CUDA runtime headers "
                        "own these ABI helper names; generated roles must use the "
                        "SDK helper instead of shadowing it with local definitions."
                    ),
                    offending_module=role_path,
                    offending_symbol=match.group("name"),
                )
            )

    declared_kernel_signatures = _collect_kernel_signatures(device_source)
    device_included_kernel_names: Set[str] = set()
    for included_source in device_included_sources.values():
        for kernel, signature in _collect_kernel_signatures(included_source).items():
            declared_kernel_signatures.setdefault(kernel, signature)
            device_included_kernel_names.add(kernel)
    declared_kernels = set(declared_kernel_signatures.keys())
    source_kernel_names: Set[str] = set()
    source_kernel_bodies: dict[str, str] = {}
    source_kernel_signatures: dict[str, str] = {}
    for source in source_device_sources.values():
        for kernel, signature in _collect_kernel_signatures(source).items():
            source_kernel_names.add(kernel)
            source_kernel_signatures.setdefault(kernel, signature)
            source_kernel_bodies.setdefault(kernel, _function_body(source, kernel))
    for kernel in sorted(source_kernel_names):
        if kernel not in declared_kernels:
            violations.append(
                Violation(
                    rule="source_device_kernel_not_preserved",
                    message=(
                        f"The generated device role omits original kernel {kernel!r}. "
                        "GPU splits must preserve user-authored kernel names and "
                        "semantics so device-only HMR can patch the existing kernel "
                        "instead of replacing it with a simplified substitute."
                    ),
                    offending_module=device_path,
                    offending_symbol=kernel,
                )
            )
        elif normalize_param_list(source_kernel_signatures.get(kernel, "")) != normalize_param_list(
            declared_kernel_signatures.get(kernel, "")
        ):
            violations.append(
                Violation(
                    rule="source_device_kernel_signature_not_preserved",
                    message=(
                        f"The generated device role changes original kernel {kernel!r} "
                        "parameters. Preserve the source kernel signature so host "
                        "launch ABI, signature hashes, and device-only HMR mappings "
                        "refer to the same callable kernel."
                    ),
                    offending_module=device_path,
                    offending_symbol=kernel,
                )
            )
        elif (
            kernel not in device_included_kernel_names
            and
            not _source_body_effectively_empty(source_kernel_bodies.get(kernel, ""))
            and _source_body_effectively_empty(_function_body(device_source, kernel))
        ):
            violations.append(
                Violation(
                    rule="source_device_kernel_body_not_preserved",
                    message=(
                        f"The generated device role keeps original kernel {kernel!r} "
                        "by name but emits an empty body. Preserve the user's kernel "
                        "branches, math, memory writes, and constants inside the "
                        "generated kernel instead of stubbing it."
                    ),
                    offending_module=device_path,
                    offending_symbol=kernel,
                )
            )
    masked_device_source = mask_comments_for_parsing(device_source)
    for match in _GLOBAL_DECL_RE.finditer(masked_device_source):
        prefix = device_source[max(0, match.start() - 48) : match.start()]
        if 'extern "C"' not in prefix:
            violations.append(
                Violation(
                    rule="device_kernel_not_extern_c",
                    message=(
                        f"Kernel {match.group('name')!r} must be declared as "
                        'extern "C" __global__ so the sidecar loader can '
                        "resolve the unmangled symbol by name."
                    ),
                    offending_module=device_path,
                    offending_symbol=match.group("name"),
                )
            )

    shared_source = files.get(shared_path) or ""
    source_const_declarations = _source_device_constant_declarations(source_device_sources)
    for identifier, source_type in sorted(source_const_declarations.items()):
        type_pattern = re.escape(source_type).replace(r"\ ", r"\s+")
        if not re.search(
            rf"\b(?:constexpr\s+|const\s+|__constant__\s+)*{type_pattern}\s+"
            rf"{re.escape(identifier)}\s*=",
            device_semantic_source,
        ):
            violations.append(
                Violation(
                    rule="source_device_constant_declaration_not_preserved",
                    message=(
                        f"The generated device role does not preserve original "
                        f"constant declaration {source_type} {identifier} = ... . "
                        "Keep the same constant name, scalar type, and initializer "
                        "in the device role so device-only HMR can edit the original "
                        "tokenized value."
                    ),
                    offending_module=device_path,
                    offending_symbol=identifier,
                )
            )
    for identifier in sorted(_source_device_identifiers(source_device_sources)):
        if identifier not in device_semantic_source:
            violations.append(
                Violation(
                    rule="source_device_identifier_not_preserved",
                    message=(
                        f"The generated device role omits original device identifier "
                        f"{identifier!r}. Preserve constants and tokenized values from "
                        "the user's GPU source in the device role instead of folding "
                        "or replacing them; device-only HMR must be able to edit the "
                        "same device semantics."
                    ),
                    offending_module=device_path,
                    offending_symbol=identifier,
                )
            )
        elif len(re.findall(rf"\b{re.escape(identifier)}\b", device_semantic_source)) < 2:
            violations.append(
                Violation(
                    rule="source_device_identifier_not_used",
                    message=(
                        f"The generated device role declares or mentions {identifier!r} "
                        "without using it in generated device semantics. Preserve "
                        "device constants where the user's kernels actually read "
                        "them; dangling declarations do not make device-only HMR "
                        "observable."
                    ),
                    offending_module=device_path,
                    offending_symbol=identifier,
                )
            )
    if "synthi_gpu_runtime.h" not in shared_source:
        violations.append(
            Violation(
                rule="missing_gpu_runtime_header",
                message=(
                    "The shared role must include \"synthi_gpu_runtime.h\". "
                    "The GPU ABI lives in the worker-generated runtime header; "
                    "the agent should conform to it rather than declaring a "
                    "private launch contract."
                ),
                offending_module=shared_path,
            )
        )
    if "synthi_gpu_runtime.h" in shared_source and re.search(r"\bstruct\s+DeviceDescriptor\b", shared_source):
        violations.append(
            Violation(
                rule="runtime_abi_redeclared",
                message=(
                    "The shared role includes synthi_gpu_runtime.h but also "
                    "redeclares DeviceDescriptor. The worker-generated runtime "
                    "header owns that ABI; remove the local struct declaration."
                ),
                offending_module=shared_path,
            )
        )

    core_source = files.get(core_path) or ""
    for symbol in ("core_on_load", "core_on_update"):
        if not re.search(rf'extern\s+"C"[^;{{\n]*\b{symbol}\s*\(', core_source):
            violations.append(
                Violation(
                    rule="missing_core_lifecycle_export",
                    message=f"The core role must export extern \"C\" {symbol} with the Synthi runner ABI.",
                    offending_module=core_path,
                    offending_symbol=symbol,
                )
            )
    for symbol in ("device_descriptor", "device_on_load", "device_kernel_sig_hash"):
        if not re.search(rf'extern\s+"C"[^;{{\n]*\b{symbol}\s*\(', core_source):
            violations.append(
                Violation(
                    rule="missing_core_gpu_lifecycle_export",
                    message=(
                        f"The core role must export extern \"C\" {symbol}. "
                        "The host GPU lifecycle ABI belongs in the host module, "
                        "not in the device role."
                    ),
                    offending_module=core_path,
                    offending_symbol=symbol,
                )
            )
    for match in _DEVICE_DESCRIPTOR_INIT_RE.finditer(core_source):
        args = _split_top_level_args(match.group("body"))
        first_arg = args[0].strip() if args else ""
        if len(args) != 6 or re.match(r"^\d", first_arg):
            violations.append(
                Violation(
                    rule="invalid_device_descriptor_initializer",
                    message=(
                        "DeviceDescriptor must use the runtime header field order "
                        "{ vendor, arches, kernels, num_arches, num_kernels, "
                        "constant_layout_bytes }. The vendor field is const char* "
                        "(for example SYNTHI_GPU_VENDOR or \"rocm\"), not an integer; "
                        "provide static arch/kernel string arrays and the two counts."
                    ),
                    offending_module=core_path,
                    offending_symbol="DeviceDescriptor",
                )
            )
    if re.search(
        r"\bnew\s+AppState\b|\b(?:std::)?make_unique\s*<\s*AppState\s*>|\b(?:std::)?make_shared\s*<\s*AppState\s*>|\b(?:malloc|calloc)\s*\([^;]*\bAppState\b",
        core_source,
    ):
        violations.append(
            Violation(
                rule="heap_allocated_app_state",
                message=(
                    "The core role must not allocate AppState with new/malloc/calloc "
                    "or smart-pointer factories. Use static module storage and "
                    "copy preserved fields from prev_state on hot reload."
                ),
                offending_module=core_path,
            )
        )
    for match in _FORBIDDEN_GPU_RUNTIME_ACCESSOR_RE.finditer(core_source):
        violations.append(
            Violation(
                rule="invented_gpu_runtime_accessor",
                message=(
                    f"The core role calls {match.group('name')}(), but "
                    "synthi_gpu_runtime.h does not expose a GPU context getter. "
                    "Do not invent runtime accessors; pass nullptr to "
                    "synthi_gpu_launch/synthi_register unless the ABI provides "
                    "a real SynthiGpuRuntime* handle."
                ),
                offending_module=core_path,
                offending_symbol=match.group("name"),
            )
        )
    if re.search(r'extern\s+"C"[^;{\n]*\b(?:device_descriptor|device_on_load|device_kernel_sig_hash)\s*\(', device_source):
        violations.append(
            Violation(
                rule="device_file_owns_host_gpu_lifecycle",
                message=(
                    "The device role must contain kernels/device helpers only. "
                    "Move device_descriptor/device_on_load/device_kernel_sig_hash "
                    "exports to the core role."
                ),
                offending_module=device_path,
            )
        )
    if re.search(r"\bsynthi_register\s*\(\s*&", core_source):
        violations.append(
            Violation(
                rule="registers_pointer_slot",
                message=(
                    "The core role registers the address of a pointer field. Allocate "
                    "the device buffer first, then call synthi_register(ptr, ...), "
                    "not synthi_register(&ptr, ...)."
                ),
                offending_module=core_path,
            )
        )
    core_load_body = _function_body(core_source, "core_on_load")
    if _GPU_HOST_TO_DEVICE_COPY_RE.search(core_load_body):
        violations.append(
            Violation(
                rule="host_to_device_copy_in_core_on_load",
                message=(
                    "core_on_load must not block first render on a raw "
                    "cudaMemcpy/hipMemcpy HostToDevice copy. Populate "
                    "host-visible mirrors for the first frame, allocate and "
                    "register device buffers, then initialize device state "
                    "through a Synthi-launched init/seed kernel that can be "
                    "retried from core_on_update once the sidecar dispatcher "
                    "is installed."
                ),
                offending_module=core_path,
                offending_symbol="core_on_load",
            )
        )
    if (
        _GPU_DEVICE_TO_HOST_COPY_RE.search(core_source)
        and re.search(r"\bsynthi_gpu_launch\s*\(", core_source)
        and not _SYNTHI_LAUNCH_RESULT_CHECK_RE.search(core_source)
    ):
        violations.append(
            Violation(
                rule="device_to_host_copy_not_launch_guarded",
                message=(
                    "DeviceToHost mirror copies must be guarded by the boolean "
                    "result of synthi_gpu_launch. If the sidecar dispatcher is "
                    "not installed or the launch fails, keep the previous "
                    "host-visible mirror instead of immediately calling "
                    "cudaMemcpy/hipMemcpy and blocking the preview. Use "
                    "`bool launched = synthi_gpu_launch(...); if (launched) "
                    "{ hipMemcpy(...DeviceToHost); }`."
                ),
                offending_module=core_path,
                offending_symbol="core_on_update",
            )
        )
    core_update_body = _function_body(core_source, "core_on_update")
    for match in re.finditer(
        r"\b(?:bool|auto)(?:\s+const)?\s+"
        r"(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s*=\s*false\s*;\s*"
        r"if\s*\(\s*(?P=name)\s*\)",
        core_update_body,
    ):
        violations.append(
            Violation(
                rule="constant_false_launch_guard",
                message=(
                    f"core_on_update initializes launch guard {match.group('name')!r} "
                    "to false and immediately guards runtime state updates on that "
                    "constant. This makes later GPU launch paths unreachable and can "
                    "compile into a black preview. Assign the guard from a real "
                    "synthi_gpu_launch(...) result, or remove the dead branch and "
                    "preserve a reachable source launch path."
                ),
                offending_module=core_path,
                offending_symbol=match.group("name"),
            )
        )
    if (
        re.search(r"\bsynthi_gpu_launch\s*\(", core_source)
        and re.search(r"\b(?:cuda|hip)Memcpy\s*\(", core_source)
        and not re.search(r"\b(?:cudaMalloc|hipMalloc|cuMemAlloc)\s*\(", core_source)
    ):
        violations.append(
            Violation(
                rule="device_buffers_not_allocated",
                message=(
                    "The core role launches/copies GPU buffers but does not allocate "
                    "them. Move the user's cudaMalloc/hipMalloc setup into "
                    "core_on_load before registration and first launch."
                ),
                offending_module=core_path,
            )
        )
    missing_init_buffer_sources = (
        _missing_init_launch_buffer_sources(core_source, device_semantic_source)
        if _GPU_MEM_ALLOC_RE.search(core_source)
        else {}
    )
    missing_init_buffers = set(missing_init_buffer_sources)
    missing_init_detail = "; ".join(
        f"{buffer} via {', '.join(sorted(kernels))}"
        if kernels
        else buffer
        for buffer, kernels in sorted(missing_init_buffer_sources.items())
    )
    if (
        missing_init_buffers
        and not _GPU_MEM_INIT_RE.search(core_source)
        and not _GPU_INIT_KERNEL_LAUNCH_RE.search(core_source)
    ):
        violations.append(
            Violation(
                rule="device_buffers_not_initialized",
                message=(
                    "The core role allocates GPU buffers and launches kernels "
                    "but never initializes those buffers with a host-to-device "
                    "copy, memset, or dedicated init/seed kernel. Preserve "
                    "the user's initial state in host-visible mirrors, then "
                    "launch a real initialization kernel such as init_particles "
                    "from core_on_update before the first update kernel. Since "
                    "raw HostToDevice copies in core_on_load are rejected, the "
                    "init kernel should fill every device buffer from the same "
                    "constructor/setup math used for the first-frame host mirror."
                    + (f" Missing: {missing_init_detail}." if missing_init_detail else "")
                ),
                offending_module=core_path,
                offending_symbol=missing_init_detail or None,
            )
        )
    if missing_init_buffers and _GPU_INIT_KERNEL_LAUNCH_RE.search(core_source):
        buffer_list = ", ".join(sorted(missing_init_buffers))
        violations.append(
            Violation(
                rule="device_init_kernel_incomplete",
                message=(
                    "The generated init/seed kernel launch does not initialize "
                    "every device buffer used by the update kernels. Include "
                    f"these buffers in the init launch and write them in the "
                    f"init kernel body before the first update: {buffer_list}."
                ),
                offending_module=core_path,
                offending_symbol=buffer_list,
            )
        )
    if re.search(r"\bvoid\s*\*\s+args\s*\[[^\]]*\][^;]*;", core_source) and re.search(
        r"\bsynthi_gpu_launch\s*\([^;]*\bargs\s*\)", core_source, re.DOTALL
    ):
        violations.append(
            Violation(
                rule="launch_args_array",
                message=(
                    "synthi_gpu_launch must receive an initializer-list literal "
                    "like `{ &arg0, &arg1 }`, not a `void* args[]` array."
                ),
                offending_module=core_path,
            )
        )
    for body in _iter_call_bodies(core_source, "synthi_gpu_launch"):
        args = _split_top_level_args(body)
        if len(args) != 7 or not args[-1].lstrip().startswith("{"):
            violations.append(
                Violation(
                    rule="invalid_synthi_launch_signature",
                    message=(
                        "synthi_gpu_launch must have exactly 7 arguments: "
                        "gpu, kernel name, grid, block, shared bytes, stream, "
                        "and an initializer-list literal `{ &arg0, ... }`."
                    ),
                    offending_module=core_path,
                )
            )
            continue

        kernel_name = _launch_kernel_name(args[1])
        launch_args = args[-1].strip()
        if "(uintptr_t)" in launch_args or "reinterpret_cast" in launch_args or re.search(
            r"\(\s*const\s+void\s*\*\s*\)", launch_args
        ):
            violations.append(
                Violation(
                    rule="launch_arg_pointer_cast",
                    message=(
                        "synthi_gpu_launch arguments must be addresses of real "
                        "host variables, e.g. `{ &device_ptr, &count, &dt }`. "
                        "Do not cast scalar values or bit patterns to pointers."
                    ),
                    offending_module=core_path,
                )
            )
            continue

        if launch_args.endswith("}"):
            entries = _split_top_level_args(launch_args[1:-1])
            if kernel_name:
                kernel_params = _device_kernel_params(device_semantic_source, kernel_name)
                if kernel_params and len(entries) != len(kernel_params):
                    violations.append(
                        Violation(
                            rule="kernel_launch_abi_mismatch",
                            message=(
                                "synthi_gpu_launch argument count must match "
                                "the generated kernel parameter list exactly. "
                                f"Kernel {kernel_name} declares {len(kernel_params)} "
                                f"parameters but the host launch passes {len(entries)} "
                                "arguments. Pass aggregate launch parameters as one "
                                "host variable, or flatten the generated kernel "
                                "signature to match the host launch ABI."
                            ),
                            offending_module=core_path,
                            offending_symbol=kernel_name,
                        )
                    )
            for entry in entries:
                stripped = entry.strip()
                if stripped and not stripped.startswith("&"):
                    violations.append(
                        Violation(
                            rule="launch_arg_not_address",
                            message=(
                                "Every synthi_gpu_launch initializer-list entry "
                                "must pass the address of a host-side argument "
                                "variable, e.g. `{ &device_ptr, &count }`."
                            ),
                            offending_module=core_path,
                        )
                    )
                    break

    gui_source = files.get(gui_path) or ""
    host_runner_source = files.get(host_runner_path) or ""
    core_state_types = _core_returned_state_types(core_source)
    gui_state_cast_types = _gui_render_state_cast_types(gui_source)
    shared_record_types = _declared_record_type_basenames(shared_source)
    for core_state_type in sorted(core_state_types):
        core_state_basename = _cpp_type_basename(core_state_type)
        if core_state_basename and core_state_basename not in shared_record_types:
            violations.append(
                Violation(
                    rule="generated.host_state_type_not_shared",
                    message=(
                        "core_on_load returns host-visible state type "
                        f"{core_state_type}, but that record type is not declared "
                        "in shared.h. Core and GUI are separate generated roles; "
                        "any state layout passed across that boundary must be in "
                        "the shared role before a split can be accepted."
                    ),
                    offending_module=core_path,
                    offending_symbol=core_state_type,
                )
            )
    if core_state_types and gui_state_cast_types:
        for gui_state_type in sorted(gui_state_cast_types):
            if any(_cpp_type_compatible(core_type, gui_state_type) for core_type in core_state_types):
                continue
            core_type_list = ", ".join(sorted(core_state_types))
            violations.append(
                Violation(
                    rule="generated.core_gui_state_abi_mismatch",
                    message=(
                        "core_on_load returns host-visible state object type "
                        f"{core_type_list}, but gui_on_render casts the runner-provided "
                        f"state pointer to {gui_state_type}. The Synthi runner passes "
                        "the core state to gui_on_render; generated core and GUI roles "
                        "must agree on one shared host-visible state layout before a "
                        "split can be accepted."
                    ),
                    offending_module=gui_path,
                    offending_symbol=f"{core_type_list}->{gui_state_type}",
                )
            )
    for namespace, symbols in sorted(_namespaced_shared_symbols(shared_source).items()):
        for role_path, role_source in (
            (core_path, core_source),
            (gui_path, gui_source),
            (host_runner_path, host_runner_source),
        ):
            if not role_path or not role_source:
                continue
            for symbol in sorted(symbols):
                if _uses_shared_symbol_unqualified(role_source, namespace, symbol):
                    violations.append(
                        Violation(
                            rule="generated.shared_namespace_symbol_unqualified",
                            message=(
                                "shared.h declares "
                                f"{namespace}::{symbol}, but generated role "
                                f"{role_path} uses {symbol} without qualifying it "
                                "or importing it with a using declaration. Generated "
                                "roles must preserve shared namespace boundaries so "
                                "compile repair is not required to guess symbol scope."
                            ),
                            offending_module=role_path,
                            offending_symbol=f"{namespace}::{symbol}",
                        )
                    )
    generated_render_backends = _render_backends_in_sources(
        (shared_source, core_source, gui_source, host_runner_source)
    )
    changed_backends = {
        backend
        for backend in generated_render_backends - source_render_backends
        if backend == "sdl" and source_render_backends - {"sdl"}
    }
    for backend in sorted(changed_backends):
        violations.append(
            Violation(
                rule="render_backend_changed",
                message=(
                    f"The generated split introduced {backend.upper()} rendering "
                    "even though the source project used a different rendering "
                    "backend. Preserve the user's backend/windowing library and "
                    "render through the runner-supplied surface for that backend."
                ),
                offending_module=gui_path,
                offending_symbol=backend,
            )
        )
    for symbol in ("gui_on_load", "gui_on_render"):
        if not re.search(rf'extern\s+"C"[^;{{\n]*\b{symbol}\s*\(', gui_source):
            violations.append(
                Violation(
                    rule="missing_gui_lifecycle_export",
                    message=f"The gui role must export extern \"C\" {symbol} with the Synthi runner ABI.",
                    offending_module=gui_path,
                    offending_symbol=symbol,
                )
            )
    placeholder_render = _PLACEHOLDER_RENDER_RE.search(gui_source)
    if placeholder_render:
        violations.append(
            Violation(
                rule="gui_render_placeholder",
                message=(
                    f"The gui role contains placeholder render text "
                    f"{placeholder_render.group(0)!r}. gui_on_render must "
                    "contain complete backend-specific drawing code that "
                    "updates the supplied render surface and produces visible "
                    "non-black frames; comments or stubs are invalid split output."
                ),
                offending_module=gui_path,
                offending_symbol=placeholder_render.group(0),
            )
        )
    gui_render_body = _function_body(gui_source, "gui_on_render")
    gui_has_render_context = bool(
        source_render_backends
        or _GUI_RENDER_CONTEXT_RE.search(gui_source)
    )
    if (
        gui_has_render_context
        and gui_render_body
        and not _GUI_RENDER_EFFECT_RE.search(_strip_cpp_comments(gui_render_body))
    ):
        violations.append(
            Violation(
                rule="gui_render_no_effect",
                message=(
                    "The gui_on_render body does not contain any concrete "
                    "backend drawing operation. A cast, comment, or empty "
                    "function can compile but produces a black frame; render "
                    "a visible primitive, texture, pixel buffer, UI widget, or "
                    "other backend-specific representation from preserved state."
                ),
                offending_module=gui_path,
            )
        )
    render_present = _GUI_BACKEND_PRESENT_RE.search(gui_source)
    if render_present:
        symbol = render_present.group("name")
        violations.append(
            Violation(
                rule="gui_calls_sdl_render_present"
                if symbol == "SDL_RenderPresent"
                else "gui_calls_backend_present",
                message=(
                    f"The gui role must not call {symbol}(). The Synthi "
                    "runner owns presentation for the selected backend after "
                    "gui_on_render returns; generated GUI code should only "
                    "clear and draw."
                ),
                offending_module=gui_path,
                offending_symbol=symbol,
            )
        )
    created_surface = _GUI_CREATES_RENDER_SURFACE_RE.search(gui_source)
    if created_surface:
        symbol = created_surface.group("name")
        violations.append(
            Violation(
                rule="gui_creates_render_surface",
                message=(
                    f"The gui role must not call {symbol}(). The runner owns "
                    "window/context creation; generated hot modules must use "
                    "the host render surface passed through core_on_load or "
                    "gui_on_load instead of creating replacement surfaces."
                ),
                offending_module=gui_path,
                offending_symbol=symbol,
            )
        )
    if _SDL_RENDER_API_RE.search(gui_source) and not _SDL_SUBSTANTIAL_DRAW_RE.search(gui_source):
        violations.append(
            Violation(
                rule="gui_render_too_sparse",
                message=(
                    "The gui role uses SDL rendering APIs but does not draw "
                    "any substantial visible primitive. A first frame that "
                    "only clears or draws isolated pixels can compile yet "
                    "remain black under screenshot validation; render filled "
                    "rects, lines, geometry, textures, or another visible "
                    "backend-specific representation from preserved state."
                ),
                offending_module=gui_path,
            )
        )
    if (
        "glfw" in source_render_backends
        and _OPENGL_SURFACE_API_RE.search(gui_source)
        and not _OPENGL_RENDER_API_RE.search(gui_source)
    ):
        violations.append(
            Violation(
                rule="gui_render_too_sparse",
                message=(
                    "The gui role uses GLFW/OpenGL APIs but only clears or "
                    "sets up the surface without drawing any substantial "
                    "visible primitive. A first frame that only clears can "
                    "compile yet remain black under screenshot validation; "
                    "draw filled geometry, points, lines, textured quads, or "
                    "another visible OpenGL representation from preserved "
                    "state."
                ),
                offending_module=gui_path,
            )
        )
    if (
        "glfw" in source_render_backends
        and _OPENGL_PROJECTION_RE.search(source_blob)
        and _OPENGL_RENDER_API_RE.search(gui_source)
        and not _OPENGL_PROJECTION_RE.search(gui_source)
    ):
        violations.append(
            Violation(
                rule="opengl_projection_not_preserved",
                message=(
                    "The source GLFW/OpenGL project establishes an explicit "
                    "projection/coordinate transform, but the generated GUI "
                    "draws OpenGL geometry without preserving that transform. "
                    "Pixel-space vertices sent under OpenGL's default -1..1 "
                    "clip-space projection compile but render only the clear "
                    "color. Preserve the source projection, for example with "
                    "glViewport + GL_PROJECTION + glOrtho, or convert all "
                    "vertices to normalized device coordinates."
                ),
                offending_module=gui_path,
                offending_symbol="GL_PROJECTION",
            )
        )
    if (
        _SDL_RENDER_API_RE.search(gui_source)
        and _GUI_STATE_RENDERER_FIELD_RE.search(gui_source)
        and not _CORE_RENDERER_FIELD_ASSIGN_RE.search(core_source)
    ):
        violations.append(
            Violation(
                rule="gui_render_surface_not_initialized",
                message=(
                    "The gui role renders through state->renderer, but the "
                    "core role never stores the render surface passed to "
                    "core_on_load into AppState.renderer. The Synthi runner "
                    "passes the core state to gui_on_render, so leaving that "
                    "field null produces black frames. Assign the second "
                    "core_on_load argument to the renderer field before "
                    "returning the core state."
                ),
                offending_module=core_path,
                offending_symbol="renderer",
            )
        )
    device_deref = _GUI_DEVICE_POINTER_DEREF_RE.search(gui_source)
    if device_deref:
        violations.append(
            Violation(
                rule="gui_dereferences_device_pointer",
                message=(
                    f"The gui role indexes {device_deref.group('name')} as if "
                    "it were host memory. Device pointers allocated with "
                    "cudaMalloc/hipMalloc are not CPU-addressable in "
                    "gui_on_render; copy GPU outputs into host-visible mirror "
                    "fields in core_on_update before rendering."
                ),
                offending_module=gui_path,
                offending_symbol=device_deref.group("name"),
            )
        )
    rendered_host_mirrors: dict[str, Set[str]] = {}
    for match in _GUI_RENDER_MIRROR_INDEX_RE.finditer(gui_source):
        mirror = match.group("name")
        if not mirror:
            continue
        rendered_host_mirrors.setdefault(mirror, set())
        member = match.group("field")
        if member:
            rendered_host_mirrors[mirror].add(member)
    zeroed_render_mirrors: Set[str] = set()
    for mirror in sorted(rendered_host_mirrors):
        zeroed_mirror = re.search(
            rf"\bmemset\s*\(\s*(?:[A-Za-z_][A-Za-z0-9_]*\s*(?:->|\.)\s*)?"
            rf"{re.escape(mirror)}\s*,\s*0\s*,",
            core_source,
        ) or re.search(
            rf"\bstd::fill(?:_n)?\s*\([^;]*\b{re.escape(mirror)}\b[^;]*,\s*(?:0|0\.0f?)\s*\)",
            core_source,
        ) or re.search(
            rf"(?:->|\.)\s*{re.escape(mirror)}\s*=\s*[^;]*\bcalloc\s*\(",
            core_source,
        )
        if zeroed_mirror:
            zeroed_render_mirrors.add(mirror)
            violations.append(
                Violation(
                    rule="host_visible_mirror_zeroed_for_render",
                    message=(
                        f"The gui role renders coordinates or pixels from "
                        f"{mirror}, but the core role initializes that host-visible "
                        "mirror entirely to zero. That makes generated primitives "
                        "overlap at the origin or stay black in first-frame screenshot "
                        "validation. Populate rendered host mirrors with varied, "
                        "on-screen initial values from the user's setup logic, or "
                        "launch a real init kernel and copy those values back before "
                        "the first render."
                    ),
                    offending_module=core_path,
                    offending_symbol=mirror,
                )
            )
    for mirror, fields in sorted(rendered_host_mirrors.items()):
        if mirror in zeroed_render_mirrors:
            continue
        if _mirror_allocated_in_load(core_load_body, mirror) and not _mirror_initialized_in_load(
            core_load_body, mirror, fields
        ):
            field_list = ", ".join(sorted(fields))
            field_suffix = f" fields ({field_list})" if field_list else ""
            violations.append(
                Violation(
                    rule="host_visible_mirror_not_initialized_for_render",
                    message=(
                        f"The gui role renders from {mirror}{field_suffix}, but "
                        "core_on_load allocates that host-visible mirror without "
                        "populating first-frame values. Allocate host mirrors and "
                        "immediately fill every rendered coordinate/color/pixel "
                        "with varied, on-screen data copied from the user's setup "
                        "logic before returning from core_on_load."
                    ),
                    offending_module=core_path,
                    offending_symbol=mirror,
                )
            )
    if re.search(r"\bSDL_GetWindowFromID\s*\(\s*1\s*\)", gui_source):
        violations.append(
            Violation(
                rule="gui_uses_global_window_id_lookup",
                message=(
                    "The gui role must not recover the renderer through "
                    "SDL_GetWindowFromID(1). Preserve the user's rendering "
                    "backend and use the host render surface passed through "
                    "gui_on_load instead of guessing a global window id."
                ),
                offending_module=gui_path,
            )
        )
    implicit_surface_lookup = re.search(
        r"\b(?:"
        r"SDL_GL_GetCurrentWindow|"
        r"glfwGetCurrentContext|"
        r"glXGetCurrentContext|"
        r"eglGetCurrentContext|"
        r"wglGetCurrentContext|"
        r"glutGetWindow"
        r")\s*\(",
        gui_source,
    )
    if implicit_surface_lookup:
        violations.append(
            Violation(
                rule="gui_uses_implicit_render_surface_lookup",
                message=(
                    "The gui role must not recover the render surface through "
                    "implicit current/global backend APIs. The hot module must "
                    "use the stable host render surface/context passed through "
                    "gui_on_load/core_on_load."
                ),
                offending_module=gui_path,
            )
        )
    if re.search(
        r"\bSDL_GetRenderer\s*\(\s*(?:\(\s*SDL_Window\s*\*\s*\)|reinterpret_cast\s*<\s*SDL_Window\s*\*\s*>\s*\()\s*window_ptr",
        gui_source,
    ):
        violations.append(
            Violation(
                rule="gui_treats_renderer_as_window",
                message=(
                    "The gui role must not treat gui_on_load's window_ptr as "
                    "SDL_Window*. For SDL2 source, the shipped runner passes "
                    "the stable SDL_Renderer* render surface through that "
                    "historical parameter; for other backends, preserve the "
                    "source backend's corresponding render surface/context."
                ),
                offending_module=gui_path,
            )
        )
    if re.search(r"\bsynthi_(?:gpu_)?register", host_runner_source):
        violations.append(
            Violation(
                rule="host_runner_registers_gpu_buffers",
                message=(
                    "The host_runner role must not call synthi_register or "
                    "synthi_gpu_register_buffer. Keep device allocation and "
                    "registration in core role lifecycle code."
                ),
                offending_module=host_runner_path,
            )
        )
    if not _host_runner_routes_gui_module(host_runner_source):
        violations.append(
            Violation(
                rule="host_runner_omits_gui_module",
                message=(
                    "The host_runner role must resolve and invoke the generated "
                    "GUI render entrypoint every frame. Marker variables or "
                    "dead references to libgui/gui_on_render are not enough; "
                    "route the core state through gui_on_render before the "
                    "backend presents the frame."
                ),
                offending_module=host_runner_path,
            )
        )

    synthi_launch_count = 0
    for host_path in (core_path, gui_path, host_runner_path):
        src = files.get(host_path)
        if not src:
            continue
        for match in _RAW_LAUNCH_CALL_RE.finditer(src):
            kernel = match.group("name")
            violations.append(
                Violation(
                    rule="raw_launch_not_rewritten",
                    message=(
                        f"Host file {host_path} still contains raw launch "
                        f"{kernel}<<<...>>>. GPU split output must launch "
                        "through synthi_gpu_launch(...) so the worker can "
                        "resolve CUfunction/HIP function handles after a "
                        "sidecar module swap."
                    ),
                    offending_module=host_path,
                    offending_symbol=kernel,
                )
            )
        for match in _SYNTHI_LAUNCH_BYPASS_RE.finditer(src):
            symbol = match.group(0).split("(", 1)[0]
            violations.append(
                Violation(
                    rule="launch_indirection_bypassed",
                    message=(
                        f"Host file {host_path} calls {symbol} directly. "
                        "Generated roles must call synthi_gpu_launch(...) so "
                        "the runtime can use the generation-checked launch "
                        "indirection table and reject stale launch pointers."
                    ),
                    offending_module=host_path,
                    offending_symbol=symbol,
                )
            )
        for match in _SYNTHI_LAUNCH_CALL_RE.finditer(src):
            synthi_launch_count += 1
            kernel = match.group("name")
            if kernel not in declared_kernels:
                violations.append(
                    Violation(
                        rule="launch_site_unresolved",
                        message=(
                            f"Host file {host_path} launches {kernel!r} via "
                            "synthi_gpu_launch(...) "
                            "but no matching __global__ symbol is declared "
                            "in the device role."
                        ),
                        offending_module=host_path,
                        offending_symbol=kernel,
                    )
                )

    if declared_kernels and synthi_launch_count == 0:
        violations.append(
            Violation(
                rule="device_kernels_not_launched",
                message=(
                    "The generated device role declares GPU kernels, but no "
                    "generated host role launches them through synthi_gpu_launch(...). "
                    "A split that only advertises kernels can compile and reload "
                    "yet produce an inert or black preview; preserve at least one "
                    "reachable source launch path through the Synthi launch "
                    "indirection table."
                ),
                offending_module=core_path,
            )
        )

    return SplitVerificationResult(ok=not violations, violations=violations)


# ─────────────────────────────────────────────────────────────────────────────
# Helpers — kernel signature extraction + edit application
# ─────────────────────────────────────────────────────────────────────────────


def _collect_new_kernels(
    device_edits: Iterable[Mapping[str, str]],
    existing_kernels: Set[str],
) -> Set[str]:
    """Pull kernel names out of the edit `content` fields, filtering
    out edits that target the body of an existing kernel (those just
    re-render the surrounding signature without introducing it).
    """
    found: Set[str] = set()
    for edit in device_edits:
        content = edit.get("content", "") or ""
        for m in _GLOBAL_DECL_RE.finditer(mask_comments_for_parsing(content)):
            name = m.group("name")
            if name and name not in existing_kernels:
                found.add(name)
    return found


def _collect_kernel_signatures(source: str) -> dict[str, str]:
    """`kernel_name -> normalised parameter list` for every `__global__`
    in `source`. The signature is the literal text between `(` and `)`
    with whitespace collapsed — good enough for "did the params
    change" without writing a C++ parser.
    """
    sigs: dict[str, str] = {}
    masked = mask_comments_for_parsing(source)
    cursor = 0
    while True:
        m = _GLOBAL_DECL_RE.search(masked, cursor)
        if not m:
            break
        name = m.group("name")
        paren_start = m.end()  # m.end() is position right after '('
        depth = 1
        i = paren_start
        n = len(masked)
        while i < n and depth > 0:
            c = masked[i]
            if c == "(":
                depth += 1
            elif c == ")":
                depth -= 1
            i += 1
        if depth == 0:
            params = source[paren_start : i - 1]
            sigs[name] = re.sub(r"\s+", " ", params).strip()
        cursor = i if i > cursor else cursor + 1
    return sigs


def _apply_edits_dry_run(source: str, edits: Iterable[Mapping[str, str]]) -> str:
    """Approximate post-edit source so the signature-preservation rule
    can compare. For Phase-1 we only handle `replace`/`patch` edits with
    an `anchor` substring; full diff_patch semantics live in
    `diff_patch_helpers.py`. Unknown ops are ignored — the verifier
    errs on the side of letting the patch through (the worker will
    re-verify after applying).
    """
    out = source
    for edit in edits:
        op = (edit.get("operation") or "").lower()
        anchor = edit.get("anchor")
        content = edit.get("content") or ""
        if op in {"replace", "patch", "rewrite", "edit"} and anchor:
            if anchor in out:
                out = out.replace(anchor, content, 1)
            elif anchor.strip() and anchor.strip() in out:
                # Tolerate whitespace differences in the anchor.
                out = out.replace(anchor.strip(), content.strip(), 1)
        elif op in {"insert_after", "append"} and anchor:
            idx = out.find(anchor)
            if idx >= 0:
                idx += len(anchor)
                out = out[:idx] + "\n" + content + out[idx:]
        elif op == "delete" and anchor and anchor in out:
            out = out.replace(anchor, "", 1)
    return out


def _host_site_was_updated(
    kernel: str,
    host_sites: Mapping[str, str],
    edits: Iterable[Mapping[str, str]],
) -> bool:
    """True if the heal's edit batch touches the host file that
    contains the launch site for `kernel`. Conservative — any
    matching-module edit counts as "host updated"; the worker's
    post-apply diff will catch the false-positive case.
    """
    if kernel not in host_sites:
        return False
    # We don't carry per-file source of the launch site; use the
    # kernel name as a substring marker for which host file edits
    # reference it.
    for edit in edits:
        module = edit.get("module", "")
        if module in {"core", "gui", "shared", "host_runner"} or module.endswith((".cpp", ".cc", ".cxx", ".h", ".hpp")):
            content = edit.get("content", "") or ""
            anchor = edit.get("anchor", "") or ""
            if kernel in content or kernel in anchor:
                return True
    return False


def _host_site_was_removed(
    kernel: str,
    host_sites: Mapping[str, str],
    edits: Iterable[Mapping[str, str]],
) -> bool:
    """Specialised case of `_host_site_was_updated` for the
    "kernel removed" path — looks for an edit that either deletes the
    launch-site anchor or replaces it with content not containing the
    kernel name.
    """
    if kernel not in host_sites:
        return False
    for edit in edits:
        module = edit.get("module", "")
        if module not in {"core", "gui", "host_runner"} and not module.endswith((".cpp", ".cc", ".cxx")):
            continue
        op = (edit.get("operation") or "").lower()
        anchor = edit.get("anchor", "") or ""
        content = edit.get("content", "") or ""
        if op == "delete" and kernel in anchor:
            return True
        if op in {"replace", "patch", "rewrite", "edit"} and kernel in anchor and kernel not in content:
            return True
    return False


def _module_aliases(project_files: Set[str]) -> dict[str, str]:
    aliases: dict[str, str] = {}

    def pick(canonical: str, predicate) -> Optional[str]:
        if canonical in project_files:
            return canonical
        return next(
            (
                path
                for path in sorted(project_files)
                if predicate(path.replace("\\", "/").split("/")[-1].lower(), path.lower())
            ),
            None,
        )

    role_candidates = {
        "core": pick("core.cpp", lambda base, _: "core" in base and base.endswith((".cpp", ".cc", ".cxx"))),
        "gui": pick("gui.cpp", lambda base, _: ("gui" in base or "render" in base) and base.endswith((".cpp", ".cc", ".cxx"))),
        "shared": pick("shared.h", lambda base, _: "shared" in base and base.endswith((".h", ".hpp"))),
        "host_runner": pick("host_runner.cpp", lambda base, _: "runner" in base and base.endswith((".cpp", ".cc", ".cxx"))),
        "device": pick("device.cu", lambda base, _: base.endswith((".cu", ".hip"))),
    }
    if role_candidates["device"] is None:
        role_candidates["device"] = pick("device.hip", lambda base, _: base.endswith((".cu", ".hip")))
    for role, path in role_candidates.items():
        if path:
            aliases[role] = path
    return aliases

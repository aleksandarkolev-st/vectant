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
      "std": "c++26",
      "common_flags": ["-shared", "-fPIC", "-g", ...],
      "core_link_flags": [],
      "gui_link_flags": ["-lSDL2"],
      "shared_link_flags": [],
      "runner_link_flags": ["-lSDL2", "-ldl"],
      "files": ["shared.h", "core.cpp", "gui.cpp", "host_runner.cpp"],
      "module_files": {
        "shared": "shared.h",
        "core": "core.cpp",
        "gui": "gui.cpp",
        "host_runner": "host_runner.cpp",
        "device": "device.cu"
      },
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
from typing import Any, List, Literal, Mapping, Optional, Set, Tuple

try:
    from pydantic import BaseModel, Field, field_validator, ConfigDict
    _PYDANTIC_V2 = True
except ImportError:  # pragma: no cover — fallback for pydantic v1
    from pydantic import BaseModel, Field, validator as field_validator  # type: ignore
    _PYDANTIC_V2 = False


ConfidenceLevel = Literal["high", "medium", "low"]
HotReloadMode = Literal["swap", "process_restart", "auto"]
Compiler = Literal["g++", "clang++"]

# ─────────────────────────────────────────────────────────────────────────────
# GPU EXTENSION (GPU_HMR_ULTRAPLAN §5.1)
# ─────────────────────────────────────────────────────────────────────────────
# A vendor-neutral GPU block sits alongside the existing host fields on
# BuildManifest. Every GPU field is OPTIONAL — host-only manifests are
# unchanged because the gpu sub-block defaults to None. The Rust mirror
# lives at backend/synthi-webrtc-compiler/worker/src/hmr/compile_manifest.rs.
DeviceCompiler = Literal["nvcc", "clang-cuda", "hipcc"]
DeviceVendor   = Literal["cuda", "rocm"]
SnapshotMode   = Literal["driver_checkpoint", "userspace", "auto"]
FatbinStrategy = Literal["sidecar_module"]


class GpuBuildBlock(BaseModel):
    """GPU-side build recipe — mirrors the host fields above for the
    `device.cu` / `device.hip` 5th module that the Kernel Splitter Agent
    emits. Every field is required when `gpu` is present; the validator
    enforces `fatbin_strategy == "sidecar_module"` because embedded
    fatbins can't be hot-swapped (cuModuleLoadData replaces the cubin in
    place; an in-binary fatbin would require relinking the host .so).
    """

    vendor: DeviceVendor
    device_compiler: DeviceCompiler
    arch: List[str] = Field(default_factory=list)
    device_flags: List[str] = Field(default_factory=list)
    runtime_libs: List[str] = Field(default_factory=list)
    snapshot_mode: SnapshotMode = "auto"
    fatbin_strategy: FatbinStrategy = "sidecar_module"

    if _PYDANTIC_V2:
        model_config = ConfigDict(extra="ignore")


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


class ModuleFilesBlock(BaseModel):
    """Semantic split-module role paths.

    `files` is the full set of source files the browser should resend after
    adaptation. `module_files` tells the worker which arbitrary path owns each
    compile role, so projects are not coupled to core.cpp/gui.cpp/shared.h.
    """

    shared: Optional[str] = None
    core: Optional[str] = None
    gui: Optional[str] = None
    host_runner: Optional[str] = None
    device: Optional[str] = None

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
    std: str = "c++26"
    common_flags: List[str] = Field(default_factory=list)
    core_link_flags: List[str] = Field(default_factory=list)
    gui_link_flags: List[str] = Field(default_factory=list)
    shared_link_flags: List[str] = Field(default_factory=list)
    runner_link_flags: List[str] = Field(default_factory=list)
    # Source modules that browser-side compile requests should resend once
    # a workspace has already been adapted. The worker still owns the compile
    # stages; this prevents the browser from guessing split-project shape.
    files: List[str] = Field(default_factory=list)
    # Semantic module role paths for dynamically named split projects.
    module_files: ModuleFilesBlock = Field(default_factory=ModuleFilesBlock)
    system_packages: List[str] = Field(default_factory=list)
    hot_reload_mode: HotReloadMode = "swap"
    confidence: ConfidenceBlock

    # Forward-compat for V2. V1 rejects non-empty build_steps via
    # validate_manifest_v1() below — the schema ACCEPTS the shape so
    # V2 doesn't need a migration, but V1 refuses execution.
    build_steps: Optional[List[dict]] = None

    # GPU_HMR_ULTRAPLAN §5.1: optional GPU sub-block. None for host-only
    # projects (the overwhelming majority). When present, the Rust worker
    # schedules compile_device alongside the host compile stages and the
    # GPU module adapter participates in hot-reload.
    gpu: Optional[GpuBuildBlock] = None

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

    # GPU_HMR_ULTRAPLAN §5.1: GPU sub-block sanity
    if manifest.gpu is not None:
        g = manifest.gpu
        if g.fatbin_strategy != "sidecar_module":
            raise ManifestRejection(
                f"Unsupported gpu.fatbin_strategy {g.fatbin_strategy!r}. "
                "Only `sidecar_module` is HMR-compatible — embedded "
                "fatbins can't be hot-swapped because cuModuleLoadData "
                "needs an external cubin/hsaco file."
            )
        if g.vendor not in ("cuda", "rocm"):
            raise ManifestRejection(
                f"Unsupported gpu.vendor {g.vendor!r}. Use `cuda` or `rocm`."
            )
        if g.device_compiler not in ("nvcc", "clang-cuda", "hipcc"):
            raise ManifestRejection(
                f"Unsupported gpu.device_compiler {g.device_compiler!r}. "
                "Use `nvcc`, `clang-cuda`, or `hipcc`."
            )
        # Vendor / compiler consistency: prevent `cuda` + `hipcc` mixups.
        cuda_compilers = ("nvcc", "clang-cuda")
        if g.vendor == "cuda" and g.device_compiler not in cuda_compilers:
            raise ManifestRejection(
                f"gpu.vendor=cuda is incompatible with device_compiler="
                f"{g.device_compiler!r}. Use `nvcc` or `clang-cuda`."
            )
        if g.vendor == "rocm" and g.device_compiler != "hipcc":
            raise ManifestRejection(
                f"gpu.vendor=rocm is incompatible with device_compiler="
                f"{g.device_compiler!r}. Use `hipcc`."
            )
        if not g.arch:
            raise ManifestRejection(
                "gpu.arch must not be empty — declare at least one target "
                "arch (e.g. [\"sm_80\"] for CUDA, [\"gfx90a\"] for ROCm)."
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


GPU_GENERATED_ROLE_ROOT = ".synthi/generated/gpu"


def _gpu_internal_role_paths(vendor: str) -> dict[str, str]:
    device_ext = "hip" if vendor == "rocm" else "cu"
    return {
        "shared": f"{GPU_GENERATED_ROLE_ROOT}/shared.h",
        "core": f"{GPU_GENERATED_ROLE_ROOT}/core.cpp",
        "gui": f"{GPU_GENERATED_ROLE_ROOT}/gui.cpp",
        "host_runner": f"{GPU_GENERATED_ROLE_ROOT}/host_runner.cpp",
        "device": f"{GPU_GENERATED_ROLE_ROOT}/device.{device_ext}",
    }


def _lookup_generated_role_content(
    split_files: Mapping[str, str],
    *,
    role: str,
    declared_path: Optional[str],
    vendor: str,
) -> tuple[Optional[str], Optional[str]]:
    normalized_files = {str(k).replace("\\", "/"): v for k, v in split_files.items()}
    default_device = "device.hip" if vendor == "rocm" else "device.cu"
    fallback_names = {
        "shared": ["shared.h"],
        "core": ["core.cpp"],
        "gui": ["gui.cpp"],
        "host_runner": ["host_runner.cpp"],
        "device": [default_device, "device.cu", "device.hip"],
    }
    candidates = []
    if declared_path:
        normalized = str(declared_path).replace("\\", "/")
        candidates.extend([normalized, normalized.rsplit("/", 1)[-1]])
    candidates.extend([role, *fallback_names.get(role, [])])
    if role == "device":
        candidates.extend(
            path
            for path in normalized_files
            if path.lower().endswith((".cu", ".hip"))
        )
    for candidate in candidates:
        if candidate in normalized_files:
            value = normalized_files[candidate]
            return (value if isinstance(value, str) else str(value), candidate)
    return None, None


def internalize_gpu_generated_artifacts(
    split_files: Mapping[str, str],
    manifest: Mapping[str, Any],
) -> tuple[dict[str, str], dict, dict]:
    """Move generated GPU role filenames under Synthi-owned internal paths."""

    manifest_out = dict(manifest)
    gpu = dict(manifest_out.get("gpu") if isinstance(manifest_out.get("gpu"), dict) else {})
    vendor = str(gpu.get("vendor") or "cuda").lower()
    if vendor not in {"cuda", "rocm"}:
        vendor = "cuda"
    declared_roles = dict(
        manifest_out.get("module_files")
        if isinstance(manifest_out.get("module_files"), Mapping)
        else {}
    )
    internal_roles = _gpu_internal_role_paths(vendor)
    internal_files: dict[str, str] = {}
    mappings = []
    missing_roles = []

    for role, internal_path in internal_roles.items():
        content, source_path = _lookup_generated_role_content(
            split_files,
            role=role,
            declared_path=declared_roles.get(role),
            vendor=vendor,
        )
        if content is None:
            content = ""
            missing_roles.append(role)
        internal_files[internal_path] = content
        mappings.append(
            {
                "role": role,
                "sourcePath": source_path,
                "internalPath": internal_path,
            }
        )

    manifest_out["module_files"] = internal_roles
    manifest_out["files"] = list(internal_roles.values())
    consumed_paths = {m["sourcePath"] for m in mappings if m["sourcePath"]}
    report = {
        "schemaVersion": "synthi.gpu.generated_artifact_purity.v1",
        "rolesAreInternal": True,
        "internalRoot": GPU_GENERATED_ROLE_ROOT,
        "userWorkspaceMaterialization": "forbidden",
        "mappings": mappings,
        "missingRoles": missing_roles,
        "droppedExtraGeneratedFiles": sorted(
            str(path).replace("\\", "/")
            for path in split_files
            if str(path).replace("\\", "/") not in consumed_paths
        ),
    }
    return internal_files, manifest_out, report


def normalize_gpu_split_manifest(
    raw: Mapping[str, Any] | None,
    *,
    split_files: Mapping[str, str],
    vendor_hint: Optional[str] = None,
    arch_hint: Optional[str] = None,
) -> dict:
    """Fill mechanical defaults the GPU splitter prompt may omit.

    The LLM owns source code and semantic split choices; this helper owns the
    boilerplate needed by the worker's manifest validator/compile pipeline.
    """

    manifest = dict(raw or {})
    file_names = [str(k) for k in split_files.keys()]

    def file_by(predicate, fallback: Optional[str] = None) -> Optional[str]:
        for name in file_names:
            if predicate(name.replace("\\", "/").split("/")[-1].lower(), name.lower()):
                return name
        return fallback

    gpu = dict(manifest.get("gpu") if isinstance(manifest.get("gpu"), dict) else {})
    vendor = str(gpu.get("vendor") or vendor_hint or "").lower()
    if vendor not in {"cuda", "rocm"}:
        device_name = file_by(lambda base, full: base.endswith(".hip") or ".hip" in full)
        vendor = "rocm" if device_name else "cuda"

    default_device = "device.hip" if vendor == "rocm" else "device.cu"
    roles = dict(manifest.get("module_files") if isinstance(manifest.get("module_files"), dict) else {})
    roles.setdefault("shared", file_by(lambda base, _: base == "shared.h" or "shared" in base, "shared.h"))
    roles.setdefault("core", file_by(lambda base, _: base == "core.cpp" or "core" in base, "core.cpp"))
    roles.setdefault("gui", file_by(lambda base, _: base == "gui.cpp" or "gui" in base, "gui.cpp"))
    roles.setdefault("host_runner", file_by(lambda base, _: "runner" in base, "host_runner.cpp"))
    roles.setdefault(
        "device",
        file_by(lambda base, full: base.endswith((".cu", ".hip")) or "device" in full, default_device),
    )
    manifest["module_files"] = roles

    files = manifest.get("files")
    if not isinstance(files, list) or not files:
        files = file_names
    for path in roles.values():
        if path and path not in files:
            files.append(path)
    manifest["files"] = [str(p) for p in files]

    manifest["compiler"] = manifest.get("compiler") if manifest.get("compiler") in {"g++", "clang++"} else "g++"
    manifest["std"] = str(manifest.get("std") or "c++26")
    for field in (
        "common_flags",
        "core_link_flags",
        "gui_link_flags",
        "shared_link_flags",
        "runner_link_flags",
        "system_packages",
    ):
        manifest[field] = _normalize_str_list(manifest.get(field))
    if manifest.get("hot_reload_mode") not in {"swap", "process_restart", "auto"}:
        manifest["hot_reload_mode"] = "swap"
    manifest["confidence"] = _normalize_confidence_block(manifest.get("confidence"))
    # The GPU splitter emits the generated 5-role module pipeline, which the
    # worker compiles directly. Build-system hints copied from the user's
    # original CMake/make project are stale after splitting and should not trip
    # V1's host-project multi-step rejection.
    manifest["build_steps"] = []

    common_flags = list(manifest["common_flags"])
    host_link_fields = ("core_link_flags", "gui_link_flags", "runner_link_flags")
    if vendor == "rocm":
        compiler = "hipcc"
        manifest["compiler"] = "clang++"
        arch = arch_hint or "gfx90a"
        include_flags = ["-D__HIP_PLATFORM_AMD__", "-I/opt/rocm/include"]
        link_flags = ["-L/opt/rocm/lib", "-lamdhip64"]
        runtime_libs = ["amdhip64"]
    else:
        compiler = "nvcc"
        arch = arch_hint or "sm_80"
        include_flags = ["-I/usr/local/cuda/include"]
        link_flags = ["-L/usr/local/cuda/lib64", "-L/usr/local/cuda/lib64/stubs", "-lcudart", "-lcuda"]
        runtime_libs = ["cudart", "cuda"]

    for flag in include_flags:
        if flag not in common_flags:
            common_flags.append(flag)
    if "-shared" not in common_flags:
        common_flags.append("-shared")
    if "-fPIC" not in common_flags:
        common_flags.append("-fPIC")
    manifest["common_flags"] = common_flags
    for field in host_link_fields:
        values = list(manifest.get(field) or [])
        for flag in link_flags:
            if flag not in values:
                values.append(flag)
        manifest[field] = values

    source_blob = "\n".join(str(v) for v in split_files.values())

    def add_host_link_flags(flags: List[str]) -> None:
        for field in ("gui_link_flags", "runner_link_flags"):
            values = list(manifest.get(field) or [])
            for flag in flags:
                if flag not in values:
                    values.append(flag)
            manifest[field] = values

    hinted_flags = _extract_source_link_hints(source_blob)
    if hinted_flags:
        add_host_link_flags(hinted_flags)

    if "SDL2/" in source_blob or "SDL_" in source_blob:
        add_host_link_flags(["-lSDL2"])
    if "GLFW/" in source_blob or "GLFWwindow" in source_blob or "glfw" in source_blob:
        add_host_link_flags(["-lglfw"])
    if (
        "GL/" in source_blob
        or "glClear" in source_blob
        or "glBegin" in source_blob
        or "glDraw" in source_blob
        or "glVertex" in source_blob
    ):
        add_host_link_flags(["-lGL"])

    runner_flags = list(manifest.get("runner_link_flags") or [])
    for flag in ("-ldl", "-pthread", "-rdynamic"):
        if flag not in runner_flags:
            runner_flags.append(flag)
    manifest["runner_link_flags"] = runner_flags

    gpu["vendor"] = vendor
    gpu["device_compiler"] = compiler
    if arch_hint:
        gpu["arch"] = [arch_hint]
    elif not isinstance(gpu.get("arch"), list) or not gpu.get("arch"):
        gpu["arch"] = [arch]
    gpu["device_flags"] = _normalize_gpu_device_flags(gpu.get("device_flags"), vendor)
    if not isinstance(gpu.get("runtime_libs"), list) or not gpu.get("runtime_libs"):
        gpu["runtime_libs"] = runtime_libs
    gpu.setdefault("snapshot_mode", "auto")
    gpu["fatbin_strategy"] = "sidecar_module"
    manifest["gpu"] = gpu
    return manifest


def _extract_source_link_hints(source: str) -> List[str]:
    """Extract explicit linker hints embedded in generated split sources.

    The AI sometimes preserves user-side `// LINK: -lfoo -lbar` comments or
    emits MSVC-style `#pragma comment(lib, "foo")` hints. Linux linkers do not
    consume either form directly, so normalize them into manifest link flags.
    """

    flags: List[str] = []
    seen: Set[str] = set()

    def add(flag: str) -> None:
        flag = flag.strip()
        if not flag:
            return
        if not flag.startswith("-l") and re.match(r"^[A-Za-z0-9_.+-]+$", flag):
            flag = f"-l{flag}"
        if flag.startswith("-l") and flag not in seen:
            flags.append(flag)
            seen.add(flag)

    for match in re.finditer(r"(?im)^\s*//\s*LINK:\s*(.+)$", source):
        for token in match.group(1).split():
            add(token)
    for match in re.finditer(r'#\s*pragma\s+comment\s*\(\s*lib\s*,\s*"([^"]+)"\s*\)', source):
        lib = match.group(1).strip()
        if lib.lower().endswith(".lib"):
            lib = lib[:-4]
        add(lib)
    return flags


def _normalize_str_list(raw: Any) -> List[str]:
    if raw is None:
        return []
    if isinstance(raw, str):
        return [raw] if raw.strip() else []
    if isinstance(raw, list):
        return [str(item) for item in raw if str(item).strip()]
    return []


def _normalize_confidence_block(raw: Any) -> dict:
    default = {
        "overall": "high",
        "runner_synthesis": "high",
        "link_flags": "high",
        "notes": "GPU manifest defaults normalized by ai-engine.",
    }
    if not isinstance(raw, Mapping):
        return default

    confidence = dict(default)
    for key in ("overall", "runner_synthesis", "link_flags"):
        value = str(raw.get(key) or "").lower()
        if value in {"high", "medium", "low"}:
            confidence[key] = value
    notes = raw.get("notes")
    if notes is not None:
        confidence["notes"] = str(notes)
    return confidence


def _normalize_gpu_device_flags(raw_flags: Any, vendor: str) -> List[str]:
    """Keep AI-emitted device flags compatible with the selected backend."""

    if not isinstance(raw_flags, list):
        raw_flags = []

    normalized: List[str] = []
    seen: Set[str] = set()

    def add(flag: str) -> None:
        if flag and flag not in seen:
            normalized.append(flag)
            seen.add(flag)

    for raw in raw_flags:
        flag = str(raw).strip()
        if not flag:
            continue
        if vendor == "rocm" and flag in {"--use_fast_math", "--use-fast-math"}:
            # hipcc's clang device path rejects nvcc's CUDA-only spelling.
            continue
        if vendor == "rocm" and (
            flag.startswith("-arch=sm_")
            or flag.startswith("--gpu-architecture=sm_")
            or flag.startswith("-gencode")
            or flag.startswith("--generate-code")
        ):
            continue
        if vendor == "cuda" and (
            flag.startswith("--offload-arch=gfx")
            or flag.startswith("--amdgpu-target=")
            or flag.startswith("--rocm-path")
        ):
            continue
        add(flag)

    for default in ("-O3", "-lineinfo"):
        add(default)

    return normalized


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
    """True iff confidence.notes mentions `ident` — as a full substring
    OR as a "stem" (the prefix before the first separator).

    The stem match is essential for multi-part identifiers: e.g. a
    project that includes `<imgui_impl_sdl2.h>` gets
    `ident="imgui_impl_sdl2"` but the AI would naturally write
    "Header-only: imgui compiled inline" in the notes — the user
    reasonably expects the "imgui" mention to excuse all three
    imgui-derived headers in one shot. Same for SFML's
    `sfml-graphics-s` → "sfml", Qt's `QtCore-5` → "qt", etc.

    Rule is generic: take the part of `ident` before the first
    `_`, `-`, or `.`, and if it's >= 3 chars, check that too.
    Library-agnostic — no catalog, just lexical stems.
    """
    ident_lower = ident.lower()
    notes_lower = notes.lower()
    if ident_lower in notes_lower:
        return True
    for sep in ("_", "-", "."):
        if sep in ident_lower:
            stem = ident_lower.split(sep, 1)[0]
            if len(stem) >= 3 and stem in notes_lower:
                return True
            break
    return False


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

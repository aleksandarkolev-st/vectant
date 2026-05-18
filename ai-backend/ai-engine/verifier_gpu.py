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
from typing import Iterable, List, Mapping, Optional, Set


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
    r"__global__\s+(?:void\s+)?(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s*\(",
    re.MULTILINE,
)
_QUOTED_INCLUDE_RE = re.compile(r'^\s*#\s*include\s*"([^"]+)"', re.MULTILINE)
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
    r"render(?:ing)?\s+code\s+here|omitted)\b",
    re.IGNORECASE,
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
        for match in _QUOTED_INCLUDE_RE.finditer(src):
            included = match.group(1).strip()
            normalized_include = _normalize_generated_path(included)
            basename = posixpath.basename(normalized_include)
            resolved_from_role = _normalize_generated_path(
                posixpath.join(role_dir, included)
            )
            if (
                normalized_include in allowed_include_paths
                or basename in allowed_include_paths
                or resolved_from_role in allowed_include_paths
            ):
                continue
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

    declared_kernels = set(_collect_kernel_signatures(device_source).keys())
    for match in _GLOBAL_DECL_RE.finditer(device_source):
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

    host_runner_source = files.get(host_runner_path) or ""
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
    if host_runner_source and not re.search(r"\bgui_on_(?:load|render)\b|libgui", host_runner_source):
        violations.append(
            Violation(
                rule="host_runner_omits_gui_module",
                message=(
                    "The host_runner role must load/call the generated GUI module "
                    "or otherwise route rendering through gui_on_render every frame."
                ),
                offending_module=host_runner_path,
            )
        )

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
        for match in _SYNTHI_LAUNCH_CALL_RE.finditer(src):
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
        for m in _GLOBAL_DECL_RE.finditer(content):
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
    cursor = 0
    while True:
        m = _GLOBAL_DECL_RE.search(source, cursor)
        if not m:
            break
        name = m.group("name")
        paren_start = m.end()  # m.end() is position right after '('
        depth = 1
        i = paren_start
        n = len(source)
        while i < n and depth > 0:
            c = source[i]
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

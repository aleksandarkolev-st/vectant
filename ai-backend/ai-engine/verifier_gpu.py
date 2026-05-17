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

  3. **Signature preservation on Tier 2/3.** For heals targeting
     `device.cu` under the perf or runtime tiers, every existing kernel
     symbol must still exist with an unchanged parameter list unless
     the diff also patches the host launch site for it.

  4. **No new `.cu`/`.hip` files.** The "5 files only" rule from
     `GPU_SPLIT_PROMPT` — multi-TU device builds are a Phase-5 concern.

In addition, split-path checks (§5.6 item 2):

  - every host launch has been rewritten to `synthi_gpu_launch(...)`,
    and every referenced kernel is declared in `device.cu`,
  - the declared `gpu.arch` list isn't empty.

The verifier returns a structured rejection (list of `Violation`s)
rather than raising — the orchestrator's MAX_HEAL_RETRIES loop
re-prompts with the rejection notes appended to
`previous_heal_attempts` (§11.3).
"""

from __future__ import annotations

import re
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

_DEVICE_FILES = {"device.cu", "device.hip"}

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
        pre-heal `device.cu` / `device.hip`.
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
        if normalized_module.endswith(".cu") and normalized_module not in _DEVICE_FILES:
            violations.append(
                Violation(
                    rule="no_extra_device_tu",
                    message=(
                        f"Heal output introduces a new .cu file: {module!r}. "
                        "Multi-TU device builds are a Phase-5 concern; v1 "
                        "supports a single device.cu / device.hip module."
                    ),
                    offending_module=module,
                )
            )

    # Rule 2: no wrapper kernels.
    device_edits = [
        {**e, "module": alias_to_file.get(e.get("module", ""), e.get("module", ""))}
        for e in edits
        if alias_to_file.get(e.get("module", ""), e.get("module", "")) in _DEVICE_FILES
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
                    offending_module="device.cu",
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
                            offending_module="device.cu",
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
                            offending_module="device.cu",
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


def verify_split_output(
    *,
    files: Mapping[str, str],
    manifest_arch: Iterable[str],
) -> SplitVerificationResult:
    """Verify the Kernel Splitter Agent's output (§5.6 item 2).

    Asserts:

      - `manifest_arch` is non-empty (the Rust mirror's
        `validate_manifest_v1` also catches this, but failing here
        gives the LLM a tighter retry signal).
      - every host launch site uses `synthi_gpu_launch(...)`, not raw
        CUDA/HIP triple-chevron syntax.
      - every `synthi_gpu_launch(...)` kernel name is declared in
        `device.cu` / `device.hip`.
      - `shared.h` includes the worker-generated
        `synthi_gpu_runtime.h` ABI header instead of inventing local
        launch/lifecycle declarations.
      - the split contains exactly the 5 expected files
        (shared.h / core.cpp / gui.cpp / host_runner.cpp / device.cu|hip).
    """
    violations: List[Violation] = []
    if not list(manifest_arch):
        violations.append(
            Violation(
                rule="manifest_arch_empty",
                message="gpu.arch must list at least one target arch.",
            )
        )

    device_source = files.get("device.cu") or files.get("device.hip") or ""
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
                    offending_module="device.cu" if "device.cu" in files else "device.hip",
                    offending_symbol=match.group("name"),
                )
            )

    expected = {"shared.h", "core.cpp", "gui.cpp", "host_runner.cpp"}
    has_device_file = "device.cu" in files or "device.hip" in files
    missing_host = expected - set(files)
    for f in missing_host:
        violations.append(
            Violation(
                rule="split_missing_file",
                message=f"Split output is missing required host file: {f}.",
            )
        )
    if not has_device_file:
        violations.append(
            Violation(
                rule="split_missing_device_file",
                message=(
                    "GPU split output is missing device.cu (or device.hip). "
                    "Kernels must live in the dedicated 5th file."
                ),
            )
        )

    shared_source = files.get("shared.h") or ""
    if "synthi_gpu_runtime.h" not in shared_source:
        violations.append(
            Violation(
                rule="missing_gpu_runtime_header",
                message=(
                    "shared.h must include \"synthi_gpu_runtime.h\". "
                    "The GPU ABI lives in the worker-generated runtime "
                    "header; the agent should conform to it rather than "
                    "declaring a private launch contract."
                ),
                offending_module="shared.h",
            )
        )
    if "synthi_gpu_runtime.h" in shared_source and re.search(r"\bstruct\s+DeviceDescriptor\b", shared_source):
        violations.append(
            Violation(
                rule="runtime_abi_redeclared",
                message=(
                    "shared.h includes synthi_gpu_runtime.h but also redeclares "
                    "DeviceDescriptor. The worker-generated runtime header owns "
                    "that ABI; remove the local struct declaration."
                ),
                offending_module="shared.h",
            )
        )

    core_source = files.get("core.cpp") or ""
    for symbol in ("core_on_load", "core_on_update"):
        if not re.search(rf'extern\s+"C"[^;{{\n]*\b{symbol}\s*\(', core_source):
            violations.append(
                Violation(
                    rule="missing_core_lifecycle_export",
                    message=f"core.cpp must export extern \"C\" {symbol} with the Synthi runner ABI.",
                    offending_module="core.cpp",
                    offending_symbol=symbol,
                )
            )
    for symbol in ("device_descriptor", "device_on_load", "device_kernel_sig_hash"):
        if not re.search(rf'extern\s+"C"[^;{{\n]*\b{symbol}\s*\(', core_source):
            violations.append(
                Violation(
                    rule="missing_core_gpu_lifecycle_export",
                    message=(
                        f"core.cpp must export extern \"C\" {symbol}. "
                        "The host GPU lifecycle ABI belongs in the host module, "
                        "not in device.cu/device.hip."
                    ),
                    offending_module="core.cpp",
                    offending_symbol=symbol,
                )
            )
    if re.search(r'extern\s+"C"[^;{\n]*\b(?:device_descriptor|device_on_load|device_kernel_sig_hash)\s*\(', device_source):
        violations.append(
            Violation(
                rule="device_file_owns_host_gpu_lifecycle",
                message=(
                    "device.cu/device.hip must contain kernels/device helpers only. "
                    "Move device_descriptor/device_on_load/device_kernel_sig_hash "
                    "exports to core.cpp."
                ),
                offending_module="device.cu" if "device.cu" in files else "device.hip",
            )
        )
    if re.search(r"\bsynthi_register\s*\(\s*&", core_source):
        violations.append(
            Violation(
                rule="registers_pointer_slot",
                message=(
                    "core.cpp registers the address of a pointer field. Allocate "
                    "the device buffer first, then call synthi_register(ptr, ...), "
                    "not synthi_register(&ptr, ...)."
                ),
                offending_module="core.cpp",
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
                    "core.cpp launches/copies GPU buffers but does not allocate "
                    "them. Move the user's cudaMalloc/hipMalloc setup into "
                    "core_on_load before registration and first launch."
                ),
                offending_module="core.cpp",
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
                offending_module="core.cpp",
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
                    offending_module="core.cpp",
                )
            )

    gui_source = files.get("gui.cpp") or ""
    for symbol in ("gui_on_load", "gui_on_render"):
        if not re.search(rf'extern\s+"C"[^;{{\n]*\b{symbol}\s*\(', gui_source):
            violations.append(
                Violation(
                    rule="missing_gui_lifecycle_export",
                    message=f"gui.cpp must export extern \"C\" {symbol} with the Synthi runner ABI.",
                    offending_module="gui.cpp",
                    offending_symbol=symbol,
                )
            )
    if re.search(r"\bSDL_GetWindowFromID\s*\(\s*1\s*\)", gui_source):
        violations.append(
            Violation(
                rule="gui_uses_global_window_id_lookup",
                message=(
                    "gui.cpp must not recover the renderer through "
                    "SDL_GetWindowFromID(1). Use the window_ptr passed to "
                    "gui_on_load, store SDL_GetRenderer((SDL_Window*)window_ptr), "
                    "and render through that stored renderer."
                ),
                offending_module="gui.cpp",
            )
        )

    host_runner_source = files.get("host_runner.cpp") or ""
    if re.search(r"\bsynthi_(?:gpu_)?register", host_runner_source):
        violations.append(
            Violation(
                rule="host_runner_registers_gpu_buffers",
                message=(
                    "host_runner.cpp must not call synthi_register or "
                    "synthi_gpu_register_buffer. Keep device allocation and "
                    "registration in core.cpp lifecycle code."
                ),
                offending_module="host_runner.cpp",
            )
        )
    if host_runner_source and not re.search(r"\bgui_on_(?:load|render)\b|libgui", host_runner_source):
        violations.append(
            Violation(
                rule="host_runner_omits_gui_module",
                message=(
                    "host_runner.cpp must load/call the generated GUI module "
                    "or otherwise route rendering through gui_on_render every frame."
                ),
                offending_module="host_runner.cpp",
            )
        )

    for host_path in ("core.cpp", "gui.cpp", "host_runner.cpp"):
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
                            "in device.cu/device.hip."
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
    if "core.cpp" in project_files:
        aliases["core"] = "core.cpp"
    if "gui.cpp" in project_files:
        aliases["gui"] = "gui.cpp"
    if "shared.h" in project_files:
        aliases["shared"] = "shared.h"
    if "host_runner.cpp" in project_files:
        aliases["host_runner"] = "host_runner.cpp"
    if "device.cu" in project_files:
        aliases["device"] = "device.cu"
    elif "device.hip" in project_files:
        aliases["device"] = "device.hip"
    return aliases

"""Unit tests for verifier_gpu — the no-shim contract enforcer.

Spec: docs/GPU_HMR_ULTRAPLAN.md §11.4 + §5.6 item 2.
"""

from verifier_gpu import (
    HealVerificationResult,
    verify_heal_output,
    verify_split_output,
)


PROJECT_FILES = ("shared.h", "core.cpp", "gui.cpp", "host_runner.cpp", "device.cu")
EXISTING_DEVICE = """
__global__ void vec_add(const float* a, const float* b, float* c, int n) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) c[i] = a[i] + b[i];
}

__global__ void scale(float* x, float s, int n) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) x[i] *= s;
}
"""

EXISTING_KERNELS = ["vec_add", "scale"]


# ─────────────────────────────────────────────────────────────────────────────
# Heal verifier — rule 1 (no file creation)
# ─────────────────────────────────────────────────────────────────────────────


def test_rejects_edit_outside_manifest_files():
    edits = [{"module": "newfile.cu", "operation": "replace", "anchor": "x", "content": "y"}]
    r = verify_heal_output(
        tier="compile_hard",
        project_files=PROJECT_FILES,
        edits=edits,
        existing_kernels=EXISTING_KERNELS,
    )
    assert not r.ok
    assert any(v.rule == "no_file_creation" for v in r.violations)


def test_accepts_edit_to_existing_module():
    edits = [
        {
            "module": "device.cu",
            "operation": "replace",
            "anchor": "c[i] = a[i] + b[i]",
            "content": "c[i] = a[i] * b[i]",
        }
    ]
    r = verify_heal_output(
        tier="compile_hard",
        project_files=PROJECT_FILES,
        edits=edits,
        existing_kernels=EXISTING_KERNELS,
        existing_device_source=EXISTING_DEVICE,
    )
    assert r.ok, r.violations


# ─────────────────────────────────────────────────────────────────────────────
# Heal verifier — rule 2 (no wrapper kernels)
# ─────────────────────────────────────────────────────────────────────────────


def test_rejects_suffix_wrapper():
    edits = [
        {
            "module": "device.cu",
            "operation": "patch",
            "anchor": "// end of file",
            "content": "__global__ void vec_add_safe(const float* a, const float* b, float* c, int n) {}",
        }
    ]
    r = verify_heal_output(
        tier="runtime",
        project_files=PROJECT_FILES,
        edits=edits,
        existing_kernels=EXISTING_KERNELS,
        existing_device_source=EXISTING_DEVICE,
    )
    assert not r.ok
    assert any(v.rule == "no_wrapper_kernel" for v in r.violations)


def test_rejects_v2_wrapper():
    edits = [
        {
            "module": "device.cu",
            "operation": "patch",
            "anchor": "// end of file",
            "content": "__global__ void scale_v2(float* x, float s, int n) {}",
        }
    ]
    r = verify_heal_output(
        tier="compile_soft",
        project_files=PROJECT_FILES,
        edits=edits,
        existing_kernels=EXISTING_KERNELS,
        existing_device_source=EXISTING_DEVICE,
    )
    assert any(v.rule == "no_wrapper_kernel" for v in r.violations)


def test_rejects_safe_prefix_wrapper():
    edits = [
        {
            "module": "device.cu",
            "operation": "patch",
            "anchor": "// end of file",
            "content": "__global__ void safe_vec_add(const float*, const float*, float*, int) {}",
        }
    ]
    r = verify_heal_output(
        tier="compile_hard",
        project_files=PROJECT_FILES,
        edits=edits,
        existing_kernels=EXISTING_KERNELS,
        existing_device_source=EXISTING_DEVICE,
    )
    assert any(v.rule == "no_wrapper_kernel" for v in r.violations)


def test_accepts_legitimate_new_kernel_with_distinct_name():
    edits = [
        {
            "module": "device.cu",
            "operation": "patch",
            "anchor": "// end of file",
            "content": "__global__ void reduce_block(const float* in, float* partials, int n) {}",
        }
    ]
    r = verify_heal_output(
        tier="compile_soft",
        project_files=PROJECT_FILES,
        edits=edits,
        existing_kernels=EXISTING_KERNELS,
        existing_device_source=EXISTING_DEVICE,
    )
    assert r.ok, r.violations


# ─────────────────────────────────────────────────────────────────────────────
# Heal verifier — rule 3 (signature preservation)
# ─────────────────────────────────────────────────────────────────────────────


def test_signature_change_without_host_update_rejected_on_tier3():
    # Patch removes existing vec_add signature line and replaces with
    # a different one. No host update.
    edits = [
        {
            "module": "device.cu",
            "operation": "replace",
            "anchor": "__global__ void vec_add(const float* a, const float* b, float* c, int n)",
            "content": "__global__ void vec_add(const float* a, const float* b, float* c, int n, float scale)",
        }
    ]
    r = verify_heal_output(
        tier="runtime",
        project_files=PROJECT_FILES,
        edits=edits,
        existing_kernels=EXISTING_KERNELS,
        existing_device_source=EXISTING_DEVICE,
        host_launch_sites={"vec_add": "vec_add<<<g, b>>>(...)"},
    )
    assert any(v.rule == "signature_changed_without_host_update" for v in r.violations)


def test_signature_change_with_host_update_accepted():
    edits = [
        {
            "module": "device.cu",
            "operation": "replace",
            "anchor": "__global__ void vec_add(const float* a, const float* b, float* c, int n)",
            "content": "__global__ void vec_add(const float* a, const float* b, float* c, int n, float scale)",
        },
        {
            "module": "core.cpp",
            "operation": "replace",
            "anchor": "vec_add<<<g, b>>>(a, b, c, n)",
            "content": "vec_add<<<g, b>>>(a, b, c, n, scale)",
        },
    ]
    r = verify_heal_output(
        tier="runtime",
        project_files=PROJECT_FILES,
        edits=edits,
        existing_kernels=EXISTING_KERNELS,
        existing_device_source=EXISTING_DEVICE,
        host_launch_sites={"vec_add": "vec_add<<<g, b>>>(...)"},
    )
    assert r.ok, r.violations


def test_signature_preservation_not_enforced_on_tier1():
    # Tier 1 (compile_hard) heals are allowed to change signatures
    # freely — the host already doesn't compile, so the diff is in
    # flight; the next compile catches any drift.
    edits = [
        {
            "module": "device.cu",
            "operation": "replace",
            "anchor": "__global__ void vec_add(const float* a, const float* b, float* c, int n)",
            "content": "__global__ void vec_add(const float* a, const float* b, float* c, int n, float scale)",
        }
    ]
    r = verify_heal_output(
        tier="compile_hard",
        project_files=PROJECT_FILES,
        edits=edits,
        existing_kernels=EXISTING_KERNELS,
        existing_device_source=EXISTING_DEVICE,
    )
    assert r.ok, r.violations


# ─────────────────────────────────────────────────────────────────────────────
# Heal verifier — rule 4 (no new .cu/.hip files)
# ─────────────────────────────────────────────────────────────────────────────


def test_rejects_new_cu_file():
    edits = [
        {
            "module": "device_utils.cu",
            "operation": "create",
            "anchor": "",
            "content": "__global__ void helper() {}",
        }
    ]
    r = verify_heal_output(
        tier="compile_hard",
        project_files=PROJECT_FILES,
        edits=edits,
        existing_kernels=EXISTING_KERNELS,
    )
    # Either rule 1 (no_file_creation) or rule 4 (no_extra_device_tu)
    # is enough — assert at least one fires.
    assert not r.ok


# ─────────────────────────────────────────────────────────────────────────────
# Split verifier (§5.6 item 2)
# ─────────────────────────────────────────────────────────────────────────────


def test_split_clean_output_passes():
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct AppState { int n; };',
        "core.cpp": 'extern "C" void* core_on_load(void*, void*) { return 0; }\nextern "C" void core_on_update(void*, double) { synthi_gpu_launch(gpu, "vec_add", 1, 256, 0, stream, { &a, &b, &c, &n }); }\nextern "C" const DeviceDescriptor* device_descriptor() { return 0; }\nextern "C" void device_on_load(const unsigned char*, size_t) {}\nextern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }',
        "gui.cpp": 'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) {}',
        "host_runner.cpp": "int main() { void* libgui = 0; auto gui_on_render = libgui; return 0; }",
        "device.cu": 'extern "C" __global__ void vec_add(const float*, const float*, float*, int) {}',
    }
    r = verify_split_output(files=files, manifest_arch=["sm_80"])
    assert r.ok, r.violations


def test_split_clean_output_with_manifest_dynamic_paths_passes():
    files = {
        "src/state/shared_runtime_abc123.h": '#include "synthi_gpu_runtime.h"\nstruct AppState { int n; };',
        "host/core_loop_abc123.cpp": 'extern "C" void* core_on_load(void*, void*) { return 0; }\nextern "C" void core_on_update(void*, double) { synthi_gpu_launch(gpu, "vec_add", 1, 256, 0, stream, { &a, &b, &c, &n }); }\nextern "C" const DeviceDescriptor* device_descriptor() { return 0; }\nextern "C" void device_on_load(const unsigned char*, size_t) {}\nextern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }',
        "render/gui_surface_abc123.cpp": 'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) {}',
        "run/flow_runner_abc123.cpp": "int main() { void* libgui = 0; auto gui_on_render = libgui; return 0; }",
        "gpu/kernels/particle_kernel_abc123.hip": 'extern "C" __global__ void vec_add(const float*, const float*, float*, int) {}',
    }
    manifest = {
        "module_files": {
            "shared": "src/state/shared_runtime_abc123.h",
            "core": "host/core_loop_abc123.cpp",
            "gui": "render/gui_surface_abc123.cpp",
            "host_runner": "run/flow_runner_abc123.cpp",
            "device": "gpu/kernels/particle_kernel_abc123.hip",
        },
        "gpu": {"vendor": "rocm", "arch": ["gfx1201"]},
    }
    r = verify_split_output(files=files, manifest_arch=["gfx1201"], manifest=manifest)
    assert r.ok, r.violations


def test_split_rejects_missing_lifecycle_exports_and_runtime_redeclaration():
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct DeviceDescriptor { int bad; };',
        "core.cpp": 'extern "C" void core_update(void*) {}',
        "gui.cpp": 'extern "C" void gui_render(void*) {}',
        "host_runner.cpp": "int main() { return 0; }",
        "device.cu": "__global__ void vec_add(const float*, const float*, float*, int) {}",
    }
    r = verify_split_output(files=files, manifest_arch=["sm_80"])
    assert not r.ok
    rules = {v.rule for v in r.violations}
    assert "runtime_abi_redeclared" in rules
    assert "missing_core_lifecycle_export" in rules
    assert "missing_gui_lifecycle_export" in rules


def test_split_rejects_heap_state_and_args_array_launch():
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct AppState { int n; };',
        "core.cpp": 'extern "C" void* core_on_load(void*, void*) { return new AppState(); }\nextern "C" void core_on_update(void*, double) { void* args[] = { &x }; synthi_gpu_launch(gpu, "vec_add", 1, 256, 0, stream, args); }',
        "gui.cpp": 'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) {}',
        "host_runner.cpp": "int main() { return 0; }",
        "device.cu": "__global__ void vec_add(const float*, const float*, float*, int) {}",
    }
    r = verify_split_output(files=files, manifest_arch=["sm_80"])
    rules = {v.rule for v in r.violations}
    assert "heap_allocated_app_state" in rules
    assert "launch_args_array" in rules


def test_split_rejects_invalid_launch_signature_and_runner_registration():
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct AppState { int n; };',
        "core.cpp": 'extern "C" void* core_on_load(void*, void*) { return 0; }\nextern "C" void core_on_update(void*, double) { synthi_gpu_launch(gpu, "vec_add", 1, 256, 0, stream, &x); }',
        "gui.cpp": 'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) {}',
        "host_runner.cpp": 'int main() { synthi_register(ptr, size, "persistent"); return 0; }',
        "device.cu": "__global__ void vec_add(const float*, const float*, float*, int) {}",
    }
    r = verify_split_output(files=files, manifest_arch=["sm_80"])
    rules = {v.rule for v in r.violations}
    assert "invalid_synthi_launch_signature" in rules
    assert "host_runner_registers_gpu_buffers" in rules


def test_split_rejects_pointer_cast_launch_arguments():
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct AppState { float* x; };',
        "core.cpp": (
            'extern "C" void* core_on_load(void*, void*) { return 0; }\n'
            'extern "C" void core_on_update(void*, double) { '
            'int n = 1; float dt = 0.1f; '
            'synthi_gpu_launch(gpu, "vec_add", 1, 256, 0, stream, '
            '{ &x, (const void*)(uintptr_t)n, (const void*)(uintptr_t)*(unsigned int*)&dt }); }\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": 'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) {}',
        "host_runner.cpp": "int main() { return 0; }",
        "device.cu": 'extern "C" __global__ void vec_add(float*, int, float) {}',
    }
    r = verify_split_output(files=files, manifest_arch=["sm_80"])
    rules = {v.rule for v in r.violations}
    assert "launch_arg_pointer_cast" in rules


def test_split_rejects_non_address_launch_arguments():
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct AppState { float* x; };',
        "core.cpp": (
            'extern "C" void* core_on_load(void*, void*) { return 0; }\n'
            'extern "C" void core_on_update(void*, double) { '
            'int n = 1; synthi_gpu_launch(gpu, "vec_add", 1, 256, 0, stream, { &x, n }); }\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": 'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) {}',
        "host_runner.cpp": "int main() { return 0; }",
        "device.cu": 'extern "C" __global__ void vec_add(float*, int) {}',
    }
    r = verify_split_output(files=files, manifest_arch=["sm_80"])
    rules = {v.rule for v in r.violations}
    assert "launch_arg_not_address" in rules


def test_split_rejects_runtime_unsafe_gpu_buffer_split():
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct AppState { float* deviceX; };',
        "core.cpp": 'extern "C" void* core_on_load(void*, void*) { return 0; }\nextern "C" void core_on_update(void* s, double) { synthi_register(&deviceX, 4, "persistent"); hipMemcpy(h, deviceX, 4, hipMemcpyDeviceToHost); synthi_gpu_launch(gpu, "vec_add", 1, 256, 0, stream, { &deviceX }); }',
        "gui.cpp": 'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) {}',
        "host_runner.cpp": "int main() { return 0; }",
        "device.hip": 'extern "C" const DeviceDescriptor* device_descriptor() { return nullptr; }\nextern "C" __global__ void vec_add(float*) {}',
    }
    r = verify_split_output(files=files, manifest_arch=["gfx1201"])
    rules = {v.rule for v in r.violations}
    assert "missing_core_gpu_lifecycle_export" in rules
    assert "device_file_owns_host_gpu_lifecycle" in rules
    assert "registers_pointer_slot" in rules
    assert "device_buffers_not_allocated" in rules


def test_split_rejects_mangled_device_kernel_exports():
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"',
        "core.cpp": 'extern "C" void* core_on_load(void*, void*) { return 0; }\nextern "C" void core_on_update(void*, double) { synthi_gpu_launch(gpu, "particle_flow", 1, 256, 0, stream, { &x }); }\nextern "C" const DeviceDescriptor* device_descriptor() { return 0; }\nextern "C" void device_on_load(const unsigned char*, size_t) {}\nextern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }',
        "gui.cpp": 'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) {}',
        "host_runner.cpp": "int main() { auto gui_on_render = 0; return 0; }",
        "device.hip": "__global__ void particle_flow(float*) {}",
    }
    r = verify_split_output(files=files, manifest_arch=["gfx1201"])
    assert any(v.rule == "device_kernel_not_extern_c" for v in r.violations)


def test_split_rejects_brittle_sdl_window_id_lookup():
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"',
        "core.cpp": 'extern "C" void* core_on_load(void*, void*) { return 0; }\nextern "C" void core_on_update(void*, double) { synthi_gpu_launch(gpu, "particle_flow", 1, 256, 0, stream, { &x }); }\nextern "C" const DeviceDescriptor* device_descriptor() { return 0; }\nextern "C" void device_on_load(const unsigned char*, size_t) {}\nextern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }',
        "gui.cpp": 'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) { SDL_GetRenderer(SDL_GetWindowFromID(1)); }',
        "host_runner.cpp": "int main() { auto gui_on_render = 0; return 0; }",
        "device.hip": 'extern "C" __global__ void particle_flow(float*) {}',
    }
    r = verify_split_output(files=files, manifest_arch=["gfx1201"])
    assert any(v.rule == "gui_uses_global_window_id_lookup" for v in r.violations)


def test_split_rejects_implicit_render_surface_lookup():
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"',
        "core.cpp": 'extern "C" void* core_on_load(void*, void*) { return 0; }\nextern "C" void core_on_update(void*, double) { synthi_gpu_launch(gpu, "particle_flow", 1, 256, 0, stream, { &x }); }\nextern "C" const DeviceDescriptor* device_descriptor() { return 0; }\nextern "C" void device_on_load(const unsigned char*, size_t) {}\nextern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }',
        "gui.cpp": 'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) { SDL_GetRenderer(SDL_GL_GetCurrentWindow()); }',
        "host_runner.cpp": "int main() { auto gui_on_render = 0; return 0; }",
        "device.hip": 'extern "C" __global__ void particle_flow(float*) {}',
    }
    r = verify_split_output(files=files, manifest_arch=["gfx1201"])
    assert any(v.rule == "gui_uses_implicit_render_surface_lookup" for v in r.violations)


def test_split_rejects_treating_runner_renderer_as_window():
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"',
        "core.cpp": 'extern "C" void* core_on_load(void*, void*) { return 0; }\nextern "C" void core_on_update(void*, double) { synthi_gpu_launch(gpu, "particle_flow", 1, 256, 0, stream, { &x }); }\nextern "C" const DeviceDescriptor* device_descriptor() { return 0; }\nextern "C" void device_on_load(const unsigned char*, size_t) {}\nextern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }',
        "gui.cpp": 'extern "C" void* gui_on_load(void*, void* window_ptr, void*) { auto r = SDL_GetRenderer((SDL_Window*)window_ptr); return r; }\nextern "C" void gui_on_render(void*) {}',
        "host_runner.cpp": "int main() { auto gui_on_render = 0; return 0; }",
        "device.hip": 'extern "C" __global__ void particle_flow(float*) {}',
    }
    r = verify_split_output(files=files, manifest_arch=["gfx1201"])
    assert any(v.rule == "gui_treats_renderer_as_window" for v in r.violations)


def test_split_rejects_empty_arch():
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"',
        "core.cpp": "",
        "gui.cpp": "",
        "host_runner.cpp": "",
        "device.cu": "__global__ void k() {}",
    }
    r = verify_split_output(files=files, manifest_arch=[])
    assert not r.ok
    assert any(v.rule == "manifest_arch_empty" for v in r.violations)


def test_split_rejects_raw_launch_site():
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"',
        "core.cpp": "void l() { vec_add<<<1, 256>>>(0); }",
        "gui.cpp": "",
        "host_runner.cpp": "",
        "device.cu": "__global__ void vec_add(const float*, const float*, float*, int) {}",
    }
    r = verify_split_output(files=files, manifest_arch=["sm_80"])
    assert not r.ok
    assert any(
        v.rule == "raw_launch_not_rewritten" and v.offending_symbol == "vec_add"
        for v in r.violations
    )


def test_split_rejects_unresolved_synthi_launch_site():
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"',
        "core.cpp": "void l() { synthi_gpu_launch(gpu, \"ghost_kernel\", 1, 256, 0, stream, { &x }); }",
        "gui.cpp": "",
        "host_runner.cpp": "",
        "device.cu": "__global__ void vec_add(const float*, const float*, float*, int) {}",
    }
    r = verify_split_output(files=files, manifest_arch=["sm_80"])
    assert not r.ok
    assert any(
        v.rule == "launch_site_unresolved" and v.offending_symbol == "ghost_kernel"
        for v in r.violations
    )


def test_split_rejects_missing_device_file():
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"',
        "core.cpp": "",
        "gui.cpp": "",
        "host_runner.cpp": "",
    }
    r = verify_split_output(files=files, manifest_arch=["sm_80"])
    assert not r.ok
    assert any(v.rule == "split_missing_device_file" for v in r.violations)


def test_split_rejects_missing_runtime_contract_header():
    files = {
        "shared.h": "struct AppState { int n; };",
        "core.cpp": "void launch_vec_add() { synthi_gpu_launch(gpu, \"vec_add\", 1, 256, 0, stream, { &a, &b, &c, &n }); }",
        "gui.cpp": "void draw() {}",
        "host_runner.cpp": "int main() { return 0; }",
        "device.cu": "__global__ void vec_add(const float*, const float*, float*, int) {}",
    }
    r = verify_split_output(files=files, manifest_arch=["sm_80"])
    assert not r.ok
    assert any(v.rule == "missing_gpu_runtime_header" for v in r.violations)

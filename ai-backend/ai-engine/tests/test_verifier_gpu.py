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

VALID_HOST_RUNNER = (
    'using gui_on_render_fn = void (*)(void*);\n'
    'int main() { void* libgui = 0; void* core_state = 0; '
    'auto render = (gui_on_render_fn)dlsym(libgui, "gui_on_render"); '
    'if (render) render(core_state); return 0; }'
)


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


def test_split_rejects_placeholder_opengl_drawing_loop_comment():
    source_files = {
        "src/render/glfw_canvas.cpp": (
            "#include <GLFW/glfw3.h>\n#include <GL/gl.h>\n"
            "void render() { glMatrixMode(GL_PROJECTION); glOrtho(0, 800, 600, 0, -1, 1); }"
        )
    }
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct AppState { int n; };',
        "core.cpp": (
            'extern "C" void* core_on_load(void*, void*) { static AppState s; return &s; }\n'
            'extern "C" void core_on_update(void*, double) { synthi_gpu_launch(nullptr, "step", 1, 256, 0, nullptr, { }); }\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": (
            '#include "shared.h"\n#include <GLFW/glfw3.h>\n#include <GL/gl.h>\n'
            'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\n'
            'extern "C" void gui_on_render(void*) { glClear(GL_COLOR_BUFFER_BIT); // ... drawing loop ...\n }'
        ),
        "host_runner.cpp": "int main() { auto gui_on_render = 0; return 0; }",
        "device.hip": 'extern "C" __global__ void step() {}',
    }
    r = verify_split_output(files=files, manifest_arch=["gfx1201"], source_files=source_files)
    assert any(v.rule == "gui_render_placeholder" for v in r.violations)


def test_split_rejects_gui_render_with_comment_but_no_drawing_effect():
    source_files = {
        "src/render/glfw_canvas.cpp": (
            "#include <GLFW/glfw3.h>\n#include <GL/gl.h>\n"
            "void render() { glBegin(GL_POINTS); glVertex2f(10, 10); glEnd(); }"
        )
    }
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct AppState { void* renderer; };',
        "core.cpp": (
            'extern "C" void* core_on_load(void*, void*) { static AppState s; return &s; }\n'
            'extern "C" void core_on_update(void*, double) { synthi_gpu_launch(nullptr, "step", 1, 256, 0, nullptr, { }); }\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": (
            '#include "shared.h"\n#include <GLFW/glfw3.h>\n#include <GL/gl.h>\n'
            'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\n'
            'extern "C" void gui_on_render(void* state_ptr) { AppState* state = reinterpret_cast<AppState*>(state_ptr); '
            '// Concrete backend drawing code using state->renderer\n }'
        ),
        "host_runner.cpp": VALID_HOST_RUNNER,
        "device.hip": 'extern "C" __global__ void step() {}',
    }
    r = verify_split_output(files=files, manifest_arch=["gfx1201"], source_files=source_files)
    assert any(v.rule == "gui_render_no_effect" for v in r.violations)


def test_split_rejects_glfw_opengl_clear_only_renderer():
    source_files = {
        "src/render/glfw_canvas.cpp": (
            "#include <GLFW/glfw3.h>\n#include <GL/gl.h>\n"
            "void render() { glMatrixMode(GL_PROJECTION); glOrtho(0, 800, 600, 0, -1, 1); "
            "glBegin(GL_POINTS); glVertex2f(10, 10); glEnd(); }"
        )
    }
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct AppState { int n; };',
        "core.cpp": (
            'extern "C" void* core_on_load(void*, void*) { static AppState s; return &s; }\n'
            'extern "C" void core_on_update(void*, double) { synthi_gpu_launch(nullptr, "step", 1, 256, 0, nullptr, { }); }\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": (
            '#include "shared.h"\n#include <GLFW/glfw3.h>\n#include <GL/gl.h>\n'
            'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\n'
            'extern "C" void gui_on_render(void*) { glClearColor(0.02f, 0.03f, 0.04f, 1.0f); glClear(GL_COLOR_BUFFER_BIT); }'
        ),
        "host_runner.cpp": "int main() { auto gui_on_render = 0; return 0; }",
        "device.hip": 'extern "C" __global__ void step() {}',
    }
    r = verify_split_output(files=files, manifest_arch=["gfx1201"], source_files=source_files)
    assert any(v.rule == "gui_render_too_sparse" for v in r.violations)


# ─────────────────────────────────────────────────────────────────────────────
# Heal verifier — rule 2 (no wrapper kernels)
# ─────────────────────────────────────────────────────────────────────────────


def test_split_rejects_source_kernel_launch_with_fabricated_arg_pack():
    source_files = {
        "src/host.cpp": (
            "void run(int w, int h, void* launch_args, void* stream) {\n"
            "  kernels[Pass::Main]->set_kernel_function_name(\"shade_pixels\");\n"
            "  kernels[Pass::Main]->launch_asynchronous(8, 8, w, h, launch_args, stream);\n"
            "}\n"
        ),
        "src/device.hip": 'extern "C" __global__ void shade_pixels(LaunchArgs args) { }',
    }
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct AppState { int n; };',
        "core.cpp": (
            'extern "C" void* core_on_load(void*, void*) { static AppState s; return &s; }\n'
            'extern "C" void core_on_update(void*, double) { int render_data = 0; synthi_gpu_launch(nullptr, "shade_pixels", 1, 64, 0, nullptr, { &render_data }); }\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": 'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) {}',
        "host_runner.cpp": VALID_HOST_RUNNER,
        "device.hip": 'extern "C" __global__ void shade_pixels(LaunchArgs args) { }',
    }
    r = verify_split_output(files=files, manifest_arch=["gfx1201"], source_files=source_files)
    assert any(v.rule == "source_launch_args_not_preserved" for v in r.violations)


def test_split_accepts_source_kernel_launch_with_same_arg_pack_identity():
    source_files = {
        "src/host.cpp": (
            "void run(int w, int h, void* launch_args, void* stream) {\n"
            "  kernels.main.set_kernel_function_name(\"shade_pixels\");\n"
            "  kernels.main.launch_asynchronous(8, 8, w, h, launch_args, stream);\n"
            "}\n"
        ),
        "src/device.hip": 'extern "C" __global__ void shade_pixels(LaunchArgs args) { }',
    }
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct AppState { int n; };',
        "core.cpp": (
            'extern "C" void* core_on_load(void*, void*) { static AppState s; return &s; }\n'
            'extern "C" void core_on_update(void*, double) { int launch_args = 0; synthi_gpu_launch(nullptr, "shade_pixels", 1, 64, 0, nullptr, { &launch_args }); }\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": 'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) {}',
        "host_runner.cpp": VALID_HOST_RUNNER,
        "device.hip": 'extern "C" __global__ void shade_pixels(LaunchArgs args) { }',
    }
    r = verify_split_output(files=files, manifest_arch=["gfx1201"], source_files=source_files)
    assert not any(v.rule == "source_launch_args_not_preserved" for v in r.violations)


def test_split_accepts_runtime_object_launch_with_resolved_arg_pack_entries():
    source_files = {
        "src/host.cpp": (
            "void run(int w, int h, void* stream) {\n"
            "  kernels.main.set_kernel_function_name(\"shade_pixels\");\n"
            "  void* launch_args[] = { &payload, &output_buffer };\n"
            "  kernels.main.launch_asynchronous(8, 8, w, h, launch_args, stream);\n"
            "}\n"
        ),
        "src/device.hip": 'extern "C" __global__ void shade_pixels(Payload payload, float* output_buffer) { }',
    }
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct AppState { int n; };',
        "core.cpp": (
            'extern "C" void* core_on_load(void*, void*) { static AppState s; return &s; }\n'
            'extern "C" void core_on_update(void*, double) { '
            'Payload payload{}; float* output_buffer = nullptr; '
            'synthi_gpu_launch(nullptr, "shade_pixels", 1, 64, 0, nullptr, { &payload, &output_buffer }); }\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": 'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) {}',
        "host_runner.cpp": VALID_HOST_RUNNER,
        "device.hip": 'struct Payload {}; extern "C" __global__ void shade_pixels(Payload payload, float* output_buffer) { }',
    }
    r = verify_split_output(files=files, manifest_arch=["gfx1201"], source_files=source_files)
    assert not any(v.rule == "source_launch_args_not_preserved" for v in r.violations)


def test_split_rejects_launching_preserved_kernel_not_in_source_launch_graph():
    source_files = {
        "src/host.cpp": (
            "void run(int w, int h, void* launch_args, void* stream) {\n"
            "  kernels.main.set_kernel_function_name(\"shade_pixels\");\n"
            "  kernels.main.launch_asynchronous(8, 8, w, h, launch_args, stream);\n"
            "}\n"
        ),
        "src/device.hip": (
            'extern "C" __global__ void shade_pixels(LaunchArgs args) { }\n'
            'extern "C" __global__ void debug_probe(LaunchArgs args) { }\n'
        ),
    }
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct AppState { int n; };',
        "core.cpp": (
            'extern "C" void* core_on_load(void*, void*) { static AppState s; return &s; }\n'
            'extern "C" void core_on_update(void*, double) { int launch_args = 0; synthi_gpu_launch(nullptr, "debug_probe", 1, 64, 0, nullptr, { &launch_args }); }\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": 'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) {}',
        "host_runner.cpp": VALID_HOST_RUNNER,
        "device.hip": (
            'extern "C" __global__ void shade_pixels(LaunchArgs args) { }\n'
            'extern "C" __global__ void debug_probe(LaunchArgs args) { }'
        ),
    }
    r = verify_split_output(files=files, manifest_arch=["gfx1201"], source_files=source_files)
    assert any(
        v.rule == "non_source_reachable_launch_site"
        and v.offending_symbol == "debug_probe"
        for v in r.violations
    )


def test_split_rejects_statically_invalid_launch_dimensions():
    source_files = {
        "src/device.hip": 'extern "C" __global__ void step(int* out) { }',
    }
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct AppState { int* out; };',
        "core.cpp": (
            'extern "C" void* core_on_load(void*, void*) { static AppState s; return &s; }\n'
            'extern "C" void core_on_update(void*, double) { int* out = 0; synthi_gpu_launch(nullptr, "step", -1, 64, 0, nullptr, { &out }); }\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": 'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) {}',
        "host_runner.cpp": VALID_HOST_RUNNER,
        "device.hip": 'extern "C" __global__ void step(int* out) { }',
    }

    r = verify_split_output(files=files, manifest_arch=["gfx1201"], source_files=source_files)

    assert any(v.rule == "invalid_synthi_launch_dimensions" for v in r.violations)


def test_split_rejects_invalid_named_dim3_launch_dimensions():
    source_files = {
        "src/device.hip": 'extern "C" __global__ void step(int* out) { }',
    }
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct AppState { int* out; };',
        "core.cpp": (
            'extern "C" void* core_on_load(void*, void*) { static AppState s; return &s; }\n'
            'extern "C" void core_on_update(void*, double) { int* out = 0; Dim3 grid(1, 1, 1); Dim3 block(0, 16, 1); synthi_gpu_launch(nullptr, "step", grid, block, 0, nullptr, { &out }); }\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": 'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) {}',
        "host_runner.cpp": VALID_HOST_RUNNER,
        "device.hip": 'extern "C" __global__ void step(int* out) { }',
    }

    r = verify_split_output(files=files, manifest_arch=["gfx1201"], source_files=source_files)

    assert any(
        v.rule == "invalid_synthi_launch_dimensions" and "block[0]" in v.message
        for v in r.violations
    )


def test_split_allows_dynamic_launch_dimensions_for_runtime_evidence():
    source_files = {
        "src/device.hip": 'extern "C" __global__ void step(int* out, int n) { }',
    }
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct AppState { int* out; int n; };',
        "core.cpp": (
            'extern "C" void* core_on_load(void*, void*) { static AppState s; return &s; }\n'
            'extern "C" void core_on_update(void* p, double) { auto* s = static_cast<AppState*>(p); int block = 64; int grid = (s->n + block - 1) / block; synthi_gpu_launch(nullptr, "step", grid, block, 0, nullptr, { &s->out, &s->n }); }\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": 'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) {}',
        "host_runner.cpp": VALID_HOST_RUNNER,
        "device.hip": 'extern "C" __global__ void step(int* out, int n) { }',
    }

    r = verify_split_output(files=files, manifest_arch=["gfx1201"], source_files=source_files)

    assert not any(v.rule == "invalid_synthi_launch_dimensions" for v in r.violations)


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
        "host_runner.cpp": VALID_HOST_RUNNER,
        "device.cu": 'extern "C" __global__ void vec_add(const float*, const float*, float*, int) {}',
    }
    r = verify_split_output(files=files, manifest_arch=["sm_80"])
    assert r.ok, r.violations


def test_split_clean_output_with_manifest_dynamic_paths_passes():
    files = {
        "src/state/shared_runtime_abc123.h": '#include "synthi_gpu_runtime.h"\nstruct AppState { int n; };',
        "host/core_loop_abc123.cpp": 'extern "C" void* core_on_load(void*, void*) { return 0; }\nextern "C" void core_on_update(void*, double) { synthi_gpu_launch(gpu, "vec_add", 1, 256, 0, stream, { &a, &b, &c, &n }); }\nextern "C" const DeviceDescriptor* device_descriptor() { return 0; }\nextern "C" void device_on_load(const unsigned char*, size_t) {}\nextern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }',
        "render/gui_surface_abc123.cpp": 'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) {}',
        "run/flow_runner_abc123.cpp": VALID_HOST_RUNNER,
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


def test_split_allows_quoted_includes_of_generated_role_paths():
    files = {
        "src/state/shared_runtime_abc123.h": '#include "synthi_gpu_runtime.h"\nstruct AppState { int n; };',
        "host/core_loop_abc123.cpp": '#include "../src/state/shared_runtime_abc123.h"\nextern "C" void* core_on_load(void*, void*) { return 0; }\nextern "C" void core_on_update(void*, double) { synthi_gpu_launch(gpu, "vec_add", 1, 256, 0, stream, { &a, &b, &c, &n }); }\nextern "C" const DeviceDescriptor* device_descriptor() { return 0; }\nextern "C" void device_on_load(const unsigned char*, size_t) {}\nextern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }',
        "render/gui_surface_abc123.cpp": '#include "shared_runtime_abc123.h"\nextern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) {}',
        "run/flow_runner_abc123.cpp": VALID_HOST_RUNNER,
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


def test_split_rejects_marker_only_host_runner_gui_reference():
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct AppState { int n; };',
        "core.cpp": 'extern "C" void* core_on_load(void*, void*) { return 0; }\nextern "C" void core_on_update(void*, double) { synthi_gpu_launch(gpu, "vec_add", 1, 256, 0, stream, { &a, &b, &c, &n }); }\nextern "C" const DeviceDescriptor* device_descriptor() { return 0; }\nextern "C" void device_on_load(const unsigned char*, size_t) {}\nextern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }',
        "gui.cpp": 'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) {}',
        "host_runner.cpp": "int main() { void* libgui = 0; auto gui_on_render = libgui; return 0; }",
        "device.cu": 'extern "C" __global__ void vec_add(const float*, const float*, float*, int) {}',
    }
    r = verify_split_output(files=files, manifest_arch=["sm_80"])
    assert any(v.rule == "host_runner_omits_gui_module" for v in r.violations)


def test_split_rejects_generated_role_including_project_header():
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\n#include "simulation.hpp"\nstruct AppState { int n; };',
        "core.cpp": 'extern "C" void* core_on_load(void*, void*) { return 0; }\nextern "C" void core_on_update(void*, double) { synthi_gpu_launch(gpu, "vec_add", 1, 256, 0, stream, { &a, &b, &c, &n }); }\nextern "C" const DeviceDescriptor* device_descriptor() { return 0; }\nextern "C" void device_on_load(const unsigned char*, size_t) {}\nextern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }',
        "gui.cpp": 'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) {}',
        "host_runner.cpp": "int main() { void* libgui = 0; auto gui_on_render = libgui; return 0; }",
        "device.cu": 'extern "C" __global__ void vec_add(const float*, const float*, float*, int) {}',
    }
    r = verify_split_output(files=files, manifest_arch=["sm_80"])
    assert any(
        v.rule == "generated_role_includes_project_header"
        and v.offending_symbol == "simulation.hpp"
        for v in r.violations
    )


def test_split_allows_device_role_including_target_source_device_header():
    source_files = {
        "src/Device/kernels/CameraRays.h": (
            "#pragma once\n"
            "constexpr int kCameraSeedOffset = 3;\n"
            "#ifdef __KERNELCC__\n"
            "GLOBAL_KERNEL_SIGNATURE(void) __launch_bounds__(64) CameraRays(HIPRTRenderData render_data)\n"
            "#else\n"
            "GLOBAL_KERNEL_SIGNATURE(void) inline CameraRays(HIPRTRenderData render_data, int x, int y)\n"
            "#endif\n"
            "{ render_data.random_number += kCameraSeedOffset; }\n"
        )
    }
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct AppState { int n; };',
        "core.cpp": (
            'extern "C" void* core_on_load(void*, void*) { return 0; }\n'
            'extern "C" void core_on_update(void*, double) {}\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": 'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) {}',
        "host_runner.cpp": VALID_HOST_RUNNER,
        "device.hip": '#define __KERNELCC__ 1\n#include "src/Device/kernels/CameraRays.h"\n',
    }

    r = verify_split_output(files=files, manifest_arch=["gfx1201"], source_files=source_files)

    disallowed = {
        "generated_role_includes_project_header",
        "source_device_kernel_not_preserved",
        "source_device_kernel_signature_not_preserved",
        "source_device_kernel_body_not_preserved",
        "source_device_constant_declaration_not_preserved",
        "source_device_identifier_not_preserved",
        "source_device_identifier_not_used",
    }
    assert not any(v.rule in disallowed for v in r.violations), r.violations


def test_split_rejects_non_device_role_including_target_source_device_header():
    source_files = {
        "src/Device/kernels/CameraRays.h": (
            "GLOBAL_KERNEL_SIGNATURE(void) CameraRays(HIPRTRenderData render_data) {"
            " render_data.random_number += 1; }"
        )
    }
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\n#include "src/Device/kernels/CameraRays.h"\nstruct AppState { int n; };',
        "core.cpp": (
            'extern "C" void* core_on_load(void*, void*) { return 0; }\n'
            'extern "C" void core_on_update(void*, double) {}\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": 'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) {}',
        "host_runner.cpp": VALID_HOST_RUNNER,
        "device.hip": '#include "src/Device/kernels/CameraRays.h"\n',
    }

    r = verify_split_output(files=files, manifest_arch=["gfx1201"], source_files=source_files)

    assert any(
        v.rule == "generated_role_includes_project_header"
        and v.offending_module == "shared.h"
        for v in r.violations
    )


def test_split_rejects_non_device_role_angle_include_resolving_to_project_file():
    source_files = {
        "thirdparties/imgui/imgui.h": "#pragma once\nnamespace ImGui { void Begin(const char*); }\n"
    }
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct AppState { int n; };',
        "core.cpp": (
            'extern "C" void* core_on_load(void*, void*) { return 0; }\n'
            'extern "C" void core_on_update(void*, double) {}\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": '#include <imgui.h>\nextern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) {}',
        "host_runner.cpp": VALID_HOST_RUNNER,
        "device.hip": "extern \"C\" __global__ void noop() {}",
    }

    r = verify_split_output(
        files=files,
        manifest_arch=["gfx1201"],
        source_files=source_files,
    )

    assert any(
        v.rule == "generated_role_includes_project_header"
        and v.offending_symbol == "imgui.h"
        for v in r.violations
    )


def test_split_rejects_non_device_role_unknown_angle_header_even_without_context():
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct AppState { int n; };',
        "core.cpp": (
            'extern "C" void* core_on_load(void*, void*) { return 0; }\n'
            'extern "C" void core_on_update(void*, double) {}\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": '#include <imgui.h>\nextern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) {}',
        "host_runner.cpp": VALID_HOST_RUNNER,
        "device.hip": "extern \"C\" __global__ void noop() {}",
    }

    r = verify_split_output(files=files, manifest_arch=["gfx1201"], source_files={})

    assert any(
        v.rule == "generated_role_includes_project_header"
        and v.offending_symbol == "imgui.h"
        for v in r.violations
    )


def test_split_allows_standard_and_installed_generated_role_includes():
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\n#include <vector>\nstruct AppState { int n; };',
        "core.cpp": (
            '#include <hip/hip_runtime.h>\n'
            'extern "C" void* core_on_load(void*, void*) { return 0; }\n'
            'extern "C" void core_on_update(void*, double) {}\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": '#include <GLFW/glfw3.h>\n#include <GL/gl.h>\nextern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) {}',
        "host_runner.cpp": VALID_HOST_RUNNER,
        "device.hip": "extern \"C\" __global__ void noop() {}",
    }

    r = verify_split_output(files=files, manifest_arch=["gfx1201"], source_files={})

    assert not any(v.rule == "generated_role_includes_project_header" for v in r.violations)


def test_split_rejects_generated_gpu_sdk_vector_type_redeclaration():
    files = {
        "shared.h": (
            '#include "synthi_gpu_runtime.h"\n'
            "#include <hip/hip_runtime.h>\n"
            "struct float3 { float x, y, z; };\n"
            "struct AppState { float3 p; };"
        ),
        "core.cpp": (
            'extern "C" void* core_on_load(void*, void*) { return 0; }\n'
            'extern "C" void core_on_update(void*, double) {}\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": 'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) {}',
        "host_runner.cpp": VALID_HOST_RUNNER,
        "device.hip": "extern \"C\" __global__ void noop() {}",
    }

    r = verify_split_output(files=files, manifest_arch=["gfx1201"], source_files={})

    assert any(
        v.rule == "generated_role_redeclares_gpu_sdk_type"
        and v.offending_symbol == "float3"
        for v in r.violations
    )


def test_split_rejects_generated_gpu_sdk_vector_helper_redeclaration():
    files = {
        "shared.h": (
            '#include "synthi_gpu_runtime.h"\n'
            "#include <hip/hip_runtime.h>\n"
            "inline float3 make_float3(float x, float y, float z) { return {x, y, z}; }\n"
            "static inline int2 make_int2(int x, int y) { return {x, y}; }\n"
            "struct AppState { float3 p; int2 size; };"
        ),
        "core.cpp": (
            'extern "C" void* core_on_load(void*, void*) { return 0; }\n'
            'extern "C" void core_on_update(void*, double) {}\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": 'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) {}',
        "host_runner.cpp": VALID_HOST_RUNNER,
        "device.hip": "extern \"C\" __global__ void noop() {}",
    }

    r = verify_split_output(files=files, manifest_arch=["gfx1201"], source_files={})

    assert {
        v.offending_symbol
        for v in r.violations
        if v.rule == "generated_role_redeclares_gpu_sdk_type"
    } >= {"make_float3", "make_int2"}


def test_split_rejects_invented_gpu_runtime_accessor():
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct AppState { int n; };',
        "core.cpp": 'extern "C" void* core_on_load(void*, void*) { return 0; }\nextern "C" void core_on_update(void*, double) { auto gpu = synthi_get_gpu_context(); synthi_gpu_launch(gpu, "vec_add", 1, 256, 0, nullptr, { &a, &b, &c, &n }); }\nextern "C" const DeviceDescriptor* device_descriptor() { return 0; }\nextern "C" void device_on_load(const unsigned char*, size_t) {}\nextern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }',
        "gui.cpp": 'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) {}',
        "host_runner.cpp": "int main() { void* libgui = 0; auto gui_on_render = libgui; return 0; }",
        "device.cu": 'extern "C" __global__ void vec_add(const float*, const float*, float*, int) {}',
    }
    r = verify_split_output(files=files, manifest_arch=["sm_80"])
    assert any(
        v.rule == "invented_gpu_runtime_accessor"
        and v.offending_symbol == "synthi_get_gpu_context"
        for v in r.violations
    )


def test_split_rejects_inert_device_kernels_without_host_launch():
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct AppState { int n; };',
        "core.cpp": (
            'extern "C" void* core_on_load(void*, void*) { static AppState s; return &s; }\n'
            'extern "C" void core_on_update(void*, double) { bool launched = false; if (launched) { ++n; } }\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": 'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) {}',
        "host_runner.cpp": "int main() { void* libgui = 0; auto gui_on_render = libgui; return 0; }",
        "device.cu": 'extern "C" __global__ void vec_add(const float*, const float*, float*, int) {}',
    }
    r = verify_split_output(files=files, manifest_arch=["sm_80"])
    assert any(v.rule == "device_kernels_not_launched" for v in r.violations)


def test_split_rejects_constant_false_launch_guard():
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct AppState { bool device_initialized; };',
        "core.cpp": (
            'extern "C" void* core_on_load(void*, void*) { static AppState s; return &s; }\n'
            'extern "C" void core_on_update(void* p, double) { auto* state = (AppState*)p; '
            'if (!state->device_initialized) { bool launched = false; '
            'if (launched) { state->device_initialized = true; } } '
            'else { synthi_gpu_launch(nullptr, "vec_add", 1, 256, 0, nullptr, { &p }); } }\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": 'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) {}',
        "host_runner.cpp": "int main() { void* libgui = 0; auto gui_on_render = libgui; return 0; }",
        "device.cu": 'extern "C" __global__ void vec_add(void*) {}',
    }
    r = verify_split_output(files=files, manifest_arch=["sm_80"])
    assert any(
        v.rule == "constant_false_launch_guard"
        and v.offending_symbol == "launched"
        for v in r.violations
    )


def test_split_rejects_placeholder_gui_render():
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct AppState { int n; };',
        "core.cpp": 'extern "C" void* core_on_load(void*, void*) { return 0; }\nextern "C" void core_on_update(void*, double) { synthi_gpu_launch(nullptr, "vec_add", 1, 256, 0, nullptr, { &a, &b, &c, &n }); }\nextern "C" const DeviceDescriptor* device_descriptor() { return 0; }\nextern "C" void device_on_load(const unsigned char*, size_t) {}\nextern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }',
        "gui.cpp": 'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) { /* rendering logic here */ }',
        "host_runner.cpp": "int main() { void* libgui = 0; auto gui_on_render = libgui; return 0; }",
        "device.cu": 'extern "C" __global__ void vec_add(const float*, const float*, float*, int) {}',
    }
    r = verify_split_output(files=files, manifest_arch=["sm_80"])
    assert any(v.rule == "gui_render_placeholder" for v in r.violations)


def test_split_rejects_sdl_present_and_sparse_point_render():
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct AppState { void* renderer; };',
        "core.cpp": 'extern "C" void* core_on_load(void*, void*) { return 0; }\nextern "C" void core_on_update(void*, double) { synthi_gpu_launch(nullptr, "vec_add", 1, 256, 0, nullptr, { &a, &b, &c, &n }); }\nextern "C" const DeviceDescriptor* device_descriptor() { return 0; }\nextern "C" void device_on_load(const unsigned char*, size_t) {}\nextern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }',
        "gui.cpp": (
            '#include <SDL2/SDL.h>\n'
            'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\n'
            'extern "C" void gui_on_render(void* s) { '
            'auto* r = (SDL_Renderer*)s; '
            'SDL_SetRenderDrawColor(r, 0, 0, 0, 255); '
            'SDL_RenderClear(r); '
            'SDL_SetRenderDrawColor(r, 255, 255, 255, 255); '
            'SDL_RenderDrawPoint(r, 400, 300); '
            'SDL_RenderPresent(r); '
            '}'
        ),
        "host_runner.cpp": "int main() { void* libgui = 0; auto gui_on_render = libgui; return 0; }",
        "device.cu": 'extern "C" __global__ void vec_add(const float*, const float*, float*, int) {}',
    }
    r = verify_split_output(files=files, manifest_arch=["sm_80"])
    rules = {v.rule for v in r.violations}
    assert "gui_calls_sdl_render_present" in rules
    assert "gui_render_too_sparse" in rules


def test_split_rejects_glfw_opengl_render_that_drops_projection():
    files = {
        "shared.h": (
            '#include "synthi_gpu_runtime.h"\n'
            "struct AppState { float x[512]; float y[512]; unsigned int rgba[512]; };"
        ),
        "core.cpp": (
            "extern \"C\" void* core_on_load(void*, void*) { return 0; }\n"
            "extern \"C\" void core_on_update(void*, double) { "
            "synthi_gpu_launch(nullptr, \"step\", 1, 256, 0, nullptr, { &x, &n }); }\n"
            "extern \"C\" const DeviceDescriptor* device_descriptor() { return 0; }\n"
            "extern \"C\" void device_on_load(const unsigned char*, size_t) {}\n"
            "extern \"C\" unsigned long long device_kernel_sig_hash(const char*) { return 1; }"
        ),
        "gui.cpp": (
            "#include <GLFW/glfw3.h>\n#include <GL/gl.h>\n"
            "extern \"C\" void* gui_on_load(void*, void*, void*) { return 0; }\n"
            "extern \"C\" void gui_on_render(void* state_ptr) { "
            "auto* s = (AppState*)state_ptr; "
            "glClear(GL_COLOR_BUFFER_BIT); glBegin(GL_QUADS); "
            "for (int i = 0; i < 512; ++i) { "
            "glVertex2f(s->x[i] - 4, s->y[i] - 4); "
            "glVertex2f(s->x[i] + 4, s->y[i] - 4); "
            "glVertex2f(s->x[i] + 4, s->y[i] + 4); "
            "glVertex2f(s->x[i] - 4, s->y[i] + 4); } glEnd(); }"
        ),
        "host_runner.cpp": "int main() { auto gui_on_render = 0; return 0; }",
        "device.cu": (
            'extern "C" __global__ void step(float* particles) { '
            'int i = blockIdx.x * blockDim.x + threadIdx.x; particles[i] = particles[i] + 1.0f; }'
        ),
    }
    source_files = {
        "src/render/glfw_canvas.cpp": (
            "#include <GLFW/glfw3.h>\n#include <GL/gl.h>\n"
            "void draw() { glMatrixMode(GL_PROJECTION); glLoadIdentity(); "
            "glOrtho(0.0, 800.0, 600.0, 0.0, -1.0, 1.0); glBegin(GL_QUADS); }"
        )
    }
    r = verify_split_output(
        files=files,
        manifest_arch=["sm_80"],
        source_files=source_files,
    )
    assert any(v.rule == "opengl_projection_not_preserved" for v in r.violations)


def test_split_rejects_gui_device_pointer_dereference():
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct Particle { float x; float y; }; struct AppState { Particle* d_particles; int n; };',
        "core.cpp": 'extern "C" void* core_on_load(void*, void*) { return 0; }\nextern "C" void core_on_update(void*, double) { synthi_gpu_launch(nullptr, "step", 1, 256, 0, nullptr, { &d_particles, &n }); }\nextern "C" const DeviceDescriptor* device_descriptor() { return 0; }\nextern "C" void device_on_load(const unsigned char*, size_t) {}\nextern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }',
        "gui.cpp": (
            '#include <SDL2/SDL.h>\n'
            'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\n'
            'extern "C" void gui_on_render(void* state_ptr) { '
            'auto* s = (AppState*)state_ptr; '
            'SDL_Rect r{(int)s->d_particles[0].x, (int)s->d_particles[0].y, 8, 8}; '
            'SDL_RenderFillRect((SDL_Renderer*)0, &r); '
            '}'
        ),
        "host_runner.cpp": "int main() { void* libgui = 0; auto gui_on_render = libgui; return 0; }",
        "device.cu": (
            'extern "C" __global__ void step(float* particles) { '
            'int i = blockIdx.x * blockDim.x + threadIdx.x; particles[i] = particles[i] + 1.0f; }'
        ),
    }
    r = verify_split_output(files=files, manifest_arch=["sm_80"])
    assert any(
        v.rule == "gui_dereferences_device_pointer"
        and v.offending_symbol == "d_particles"
        for v in r.violations
    )


def test_split_rejects_uninitialized_device_buffers():
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct AppState { float* d_particles; int n; };',
        "core.cpp": (
            '#include <hip/hip_runtime.h>\n'
            'extern "C" void* core_on_load(void*, void*) { hipMalloc(&d_particles, 4096); return 0; }\n'
            'extern "C" void core_on_update(void*, double) { synthi_gpu_launch(nullptr, "step", 1, 256, 0, nullptr, { &d_particles, &n }); }\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": 'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) {}',
        "host_runner.cpp": "int main() { void* libgui = 0; auto gui_on_render = libgui; return 0; }",
        "device.cu": 'extern "C" __global__ void step(float*) {}',
    }
    r = verify_split_output(files=files, manifest_arch=["sm_80"])
    assert any(v.rule == "device_buffers_not_initialized" for v in r.violations)


def test_split_allows_source_device_launch_without_pointer_init_requirement():
    source_files = {
        "src/Device/kernels/CameraRays.h": (
            "struct HIPRTRenderData { unsigned int random_number; };\n"
            "GLOBAL_KERNEL_SIGNATURE(void) CameraRays(HIPRTRenderData render_data) "
            "{ render_data.random_number += 1; }\n"
        )
    }
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct AppState { void* d_scene; int n; };',
        "core.cpp": (
            '#include <hip/hip_runtime.h>\n'
            'extern "C" void* core_on_load(void*, void*) { hipMalloc(&d_scene, 4096); return 0; }\n'
            'extern "C" void core_on_update(void*, double) { '
            'HIPRTRenderData render_data{}; '
            'synthi_gpu_launch(nullptr, "CameraRays", 1, 256, 0, nullptr, { &render_data }); }\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": 'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) {}',
        "host_runner.cpp": "int main() { void* libgui = 0; auto gui_on_render = libgui; return 0; }",
        "device.hip": '#include "src/Device/kernels/CameraRays.h"\n',
    }

    r = verify_split_output(
        files=files,
        manifest_arch=["gfx1201"],
        source_files=source_files,
    )

    assert not any(v.rule == "device_buffers_not_initialized" for v in r.violations)


def test_split_allows_output_only_pointer_kernel_without_init():
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct AppState { size_t* d_size; };',
        "core.cpp": (
            '#include <hip/hip_runtime.h>\n'
            'extern "C" void* core_on_load(void*, void*) { static AppState s; hipMalloc(&s.d_size, sizeof(size_t)); return &s; }\n'
            'extern "C" void core_on_update(void* state, double) { auto* s = (AppState*)state; '
            'synthi_gpu_launch(nullptr, "write_size", 1, 1, 0, nullptr, { &s->d_size }); }\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": 'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) {}',
        "host_runner.cpp": "int main() { void* libgui = 0; auto gui_on_render = libgui; return 0; }",
        "device.hip": 'extern "C" __global__ void write_size(size_t* out_buffer) { out_buffer[0] = sizeof(float); }',
    }
    r = verify_split_output(files=files, manifest_arch=["gfx1201"])
    assert not any(v.rule == "device_buffers_not_initialized" for v in r.violations)


def test_split_reports_only_pointer_params_that_need_input_state():
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct AppState { float* d_values; float* d_output; int n; };',
        "core.cpp": (
            '#include <hip/hip_runtime.h>\n'
            'extern "C" void* core_on_load(void*, void*) { static AppState s; '
            'hipMalloc(&s.d_values, 4096); hipMalloc(&s.d_output, 4096); return &s; }\n'
            'extern "C" void core_on_update(void* state, double) { auto* s = (AppState*)state; '
            'synthi_gpu_launch(nullptr, "copy_values", 1, 256, 0, nullptr, { &s->d_values, &s->d_output, &s->n }); }\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": 'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) {}',
        "host_runner.cpp": "int main() { void* libgui = 0; auto gui_on_render = libgui; return 0; }",
        "device.hip": (
            'extern "C" __global__ void copy_values(const float* values, float* output, int n) { '
            'int i = blockIdx.x * blockDim.x + threadIdx.x; if (i < n) output[i] = values[i]; }'
        ),
    }
    r = verify_split_output(files=files, manifest_arch=["gfx1201"])
    init_violations = [v for v in r.violations if v.rule == "device_buffers_not_initialized"]
    assert init_violations
    assert "d_values" in (init_violations[0].offending_symbol or "")
    assert "d_output" not in (init_violations[0].offending_symbol or "")


def test_split_rejects_host_to_device_copy_in_core_on_load():
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct AppState { float* d_particles; float* h_particles; int n; };',
        "core.cpp": (
            '#include <hip/hip_runtime.h>\n'
            'extern "C" void* core_on_load(void*, void*) { '
            'static AppState s; s.n = 1024; s.h_particles = new float[1024]; '
            'hipMalloc(&s.d_particles, 4096); synthi_register(s.d_particles, 4096, "persistent"); '
            'hipMemcpy(s.d_particles, s.h_particles, 4096, hipMemcpyHostToDevice); return &s; }\n'
            'extern "C" void core_on_update(void*, double) { bool ok = synthi_gpu_launch(nullptr, "step", 1, 256, 0, nullptr, { &d_particles, &n }); if (ok) {} }\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": 'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) {}',
        "host_runner.cpp": "int main() { return 0; }",
        "device.cu": 'extern "C" __global__ void step(float*, int) {}',
    }
    r = verify_split_output(files=files, manifest_arch=["sm_80"])
    assert any(v.rule == "host_to_device_copy_in_core_on_load" for v in r.violations)


def test_split_rejects_unguarded_device_to_host_copy_after_launch():
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct AppState { float* d_particles; float* h_particles; int n; };',
        "core.cpp": (
            '#include <hip/hip_runtime.h>\n'
            'extern "C" void* core_on_load(void*, void*) { static AppState s; hipMalloc(&s.d_particles, 4096); return &s; }\n'
            'extern "C" void core_on_update(void*, double) { '
            'synthi_gpu_launch(nullptr, "step", 1, 256, 0, nullptr, { &d_particles, &n }); '
            'hipMemcpy(h_particles, d_particles, 4096, hipMemcpyDeviceToHost); }\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": 'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) {}',
        "host_runner.cpp": "int main() { return 0; }",
        "device.cu": 'extern "C" __global__ void step(float*, int) {}',
    }
    r = verify_split_output(files=files, manifest_arch=["sm_80"])
    assert any(v.rule == "device_to_host_copy_not_launch_guarded" for v in r.violations)


def test_split_rejects_zeroed_host_mirror_used_for_render():
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct AppState { float* d_particles; float* h_particles; int n; void* renderer; };',
        "core.cpp": (
            '#include <hip/hip_runtime.h>\n'
            'extern "C" void* core_on_load(void*, void* renderer) { '
            'static AppState s; s.renderer = renderer; s.n = 1024; '
            'hipMalloc(&s.d_particles, 8192); s.h_particles = new float[2048]; '
            'memset(s.h_particles, 0, 8192); '
            'hipMemcpy(s.d_particles, s.h_particles, 8192, hipMemcpyHostToDevice); '
            'return &s; }\n'
            'extern "C" void core_on_update(void*, double) { synthi_gpu_launch(nullptr, "step", 1, 256, 0, nullptr, { &d_particles, &n }); }\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": (
            '#include <SDL2/SDL.h>\n'
            'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\n'
            'extern "C" void gui_on_render(void* state_ptr) { '
            'auto* s = (AppState*)state_ptr; SDL_Rect r = { '
            '(int)s->h_particles[0], (int)s->h_particles[1], 2, 2 }; '
            'SDL_RenderFillRect((SDL_Renderer*)s->renderer, &r); }'
        ),
        "host_runner.cpp": "int main() { auto gui_on_render = 0; return 0; }",
        "device.cu": 'extern "C" __global__ void step(float*, int) {}',
    }
    r = verify_split_output(files=files, manifest_arch=["sm_80"])
    assert any(v.rule == "host_visible_mirror_zeroed_for_render" for v in r.violations)


def test_split_rejects_uninitialized_render_mirror_used_for_first_frame():
    files = {
        "shared.h": (
            '#include "synthi_gpu_runtime.h"\n'
            "struct Particle { float x, y, vx, vy; };\n"
            "struct AppState { void* renderer; Particle* particles; Particle* d_particles; int num_particles; bool device_initialized; };"
        ),
        "core.cpp": (
            '#include "shared.h"\n#include <hip/hip_runtime.h>\n'
            "static AppState g_state{};\n"
            'extern "C" void* core_on_load(void*, void* renderer) { '
            "g_state.renderer = renderer; g_state.num_particles = 1024; "
            "g_state.particles = new Particle[g_state.num_particles]; "
            "hipMalloc(&g_state.d_particles, sizeof(Particle) * g_state.num_particles); "
            'synthi_register(g_state.d_particles, sizeof(Particle) * g_state.num_particles, "persistent"); '
            "g_state.device_initialized = false; return &g_state; }\n"
            'extern "C" void core_on_update(void*, double) { '
            'bool ok = synthi_gpu_launch(nullptr, "init_particles", 1, 256, 0, nullptr, { &g_state.d_particles, &g_state.num_particles }); '
            "if (ok) g_state.device_initialized = true; }\n"
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": (
            '#include "shared.h"\n#include <SDL2/SDL.h>\n'
            'extern "C" void* gui_on_load(void*, void*, void* core) { return core; }\n'
            'extern "C" void gui_on_render(void* state_ptr) { '
            "auto* s = (AppState*)state_ptr; auto* renderer = (SDL_Renderer*)s->renderer; "
            "SDL_SetRenderDrawColor(renderer, 255, 255, 255, 255); "
            "for (int i = 0; i < s->num_particles; ++i) { "
            "SDL_Rect r{(int)s->particles[i].x, (int)s->particles[i].y, 2, 2}; "
            "SDL_RenderFillRect(renderer, &r); } }"
        ),
        "host_runner.cpp": "int main() { auto gui_on_render = 0; return 0; }",
        "device.hip": 'extern "C" __global__ void init_particles(void*, int*) {}',
    }
    r = verify_split_output(files=files, manifest_arch=["gfx1201"])
    assert any(
        v.rule == "host_visible_mirror_not_initialized_for_render"
        and v.offending_symbol == "particles"
        for v in r.violations
    )


def test_split_accepts_initialized_render_mirror_used_for_first_frame():
    files = {
        "shared.h": (
            '#include "synthi_gpu_runtime.h"\n'
            "struct Particle { float x, y, vx, vy; };\n"
            "struct AppState { void* renderer; Particle* particles; Particle* d_particles; int num_particles; bool device_initialized; };"
        ),
        "core.cpp": (
            '#include "shared.h"\n#include <hip/hip_runtime.h>\n'
            "static AppState g_state{};\n"
            'extern "C" void* core_on_load(void*, void* renderer) { '
            "g_state.renderer = renderer; g_state.num_particles = 1024; "
            "g_state.particles = new Particle[g_state.num_particles]; "
            "for (int i = 0; i < g_state.num_particles; ++i) { "
            "g_state.particles[i].x = (float)((i % 32) * 20 + 12); "
            "g_state.particles[i].y = (float)((i / 32) * 16 + 12); "
            "g_state.particles[i].vx = 0.1f; g_state.particles[i].vy = 0.2f; } "
            "hipMalloc(&g_state.d_particles, sizeof(Particle) * g_state.num_particles); "
            'synthi_register(g_state.d_particles, sizeof(Particle) * g_state.num_particles, "persistent"); '
            "g_state.device_initialized = false; return &g_state; }\n"
            'extern "C" void core_on_update(void*, double) { '
            'bool ok = synthi_gpu_launch(nullptr, "init_particles", 1, 256, 0, nullptr, { &g_state.d_particles, &g_state.num_particles }); '
            "if (ok) g_state.device_initialized = true; }\n"
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": (
            '#include "shared.h"\n#include <SDL2/SDL.h>\n'
            'extern "C" void* gui_on_load(void*, void*, void* core) { return core; }\n'
            'extern "C" void gui_on_render(void* state_ptr) { '
            "auto* s = (AppState*)state_ptr; auto* renderer = (SDL_Renderer*)s->renderer; "
            "SDL_SetRenderDrawColor(renderer, 255, 255, 255, 255); "
            "for (int i = 0; i < s->num_particles; ++i) { "
            "SDL_Rect r{(int)s->particles[i].x, (int)s->particles[i].y, 2, 2}; "
            "SDL_RenderFillRect(renderer, &r); } }"
        ),
        "host_runner.cpp": "int main() { auto gui_on_render = 0; return 0; }",
        "device.hip": 'extern "C" __global__ void init_particles(void*, int*) {}',
    }
    r = verify_split_output(files=files, manifest_arch=["gfx1201"])
    assert not any(v.rule == "host_visible_mirror_not_initialized_for_render" for v in r.violations)


def test_split_rejects_dropped_source_device_kernel_and_constants():
    source_files = {
        "src/gpu/particle_kernels.hip": (
            "#include <hip/hip_runtime.h>\n"
            "namespace scale {\n"
            "constexpr float kResetPadding = 18.0f;\n"
            "constexpr float kHmrScaleDirection = 1.0f;\n"
            "constexpr int kHmrScaleColorBias = 0;\n"
            'extern "C" __global__ void advance_particle_field(float* x, float* y, float* vx, float* vy, unsigned int* rgba, int count) { '
            "int i = blockIdx.x * blockDim.x + threadIdx.x; if (i >= count) return; "
            "vx[i] += kHmrScaleDirection * 0.1f; if (x[i] < kResetPadding) x[i] = kResetPadding; "
            "rgba[i] = (unsigned int)(i + kHmrScaleColorBias); }\n"
            "}\n"
        )
    }
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct Particle { float x, y, vx, vy; };',
        "core.cpp": (
            'extern "C" void* core_on_load(void*, void*) { return 0; }\n'
            'extern "C" void core_on_update(void*, double) { synthi_gpu_launch(nullptr, "update_particles", 1, 256, 0, nullptr, { &p }); }\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": 'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) {}',
        "host_runner.cpp": "int main() { auto gui_on_render = 0; return 0; }",
        "device.hip": (
            '#include "shared.h"\n'
            'extern "C" __global__ void update_particles(Particle* p, int n, float dt) { '
            "int i = blockIdx.x * blockDim.x + threadIdx.x; if (i < n) p[i].x += p[i].vx * dt; }"
        ),
    }
    r = verify_split_output(files=files, manifest_arch=["gfx1201"], source_files=source_files)
    assert any(
        v.rule == "source_device_kernel_not_preserved"
        and v.offending_symbol == "advance_particle_field"
        for v in r.violations
    )
    assert any(
        v.rule == "source_device_identifier_not_preserved"
        and v.offending_symbol == "kHmrScaleDirection"
        for v in r.violations
    )


def test_split_rejects_dropped_macro_wrapped_runtime_kernel_header():
    source_files = {
        "src/Device/kernels/CameraRays.h": """
        GLOBAL_KERNEL_SIGNATURE(void) __launch_bounds__(64)
        CameraRays(HIPRTRenderData render_data) {
          render_data.random_number += 1;
        }
        """
    }
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct AppState { int n; };',
        "core.cpp": (
            'extern "C" void* core_on_load(void*, void*) { return 0; }\n'
            'extern "C" void core_on_update(void*, double) { synthi_gpu_launch(nullptr, "OtherKernel", 1, 64, 0, nullptr, { &n }); }\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": 'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) {}',
        "host_runner.cpp": "int main() { auto gui_on_render = 0; return 0; }",
        "device.hip": 'extern "C" __global__ void OtherKernel(int) {}',
    }

    r = verify_split_output(files=files, manifest_arch=["gfx1201"], source_files=source_files)

    assert any(
        v.rule == "source_device_kernel_not_preserved"
        and v.offending_symbol == "CameraRays"
        for v in r.violations
    )


def test_split_rejects_stubbed_macro_wrapped_runtime_kernel_body():
    source_files = {
        "src/Device/kernels/CameraRays.h": """
        #ifdef __KERNELCC__
        GLOBAL_KERNEL_SIGNATURE(void) __launch_bounds__(64) CameraRays(HIPRTRenderData render_data)
        #else
        GLOBAL_KERNEL_SIGNATURE(void) inline CameraRays(HIPRTRenderData render_data, int x, int y)
        #endif
        {
          render_data.random_number += 1;
        }
        """
    }
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct AppState { int n; };',
        "core.cpp": (
            'extern "C" void* core_on_load(void*, void*) { return 0; }\n'
            'extern "C" void core_on_update(void*, double) {}\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": 'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) {}',
        "host_runner.cpp": VALID_HOST_RUNNER,
        "device.hip": 'extern "C" __global__ void CameraRays(HIPRTRenderData render_data) {}',
    }

    r = verify_split_output(files=files, manifest_arch=["gfx1201"], source_files=source_files)

    assert any(
        v.rule == "source_device_kernel_body_not_preserved"
        and v.offending_symbol == "CameraRays"
        for v in r.violations
    )


def test_split_rejects_macro_kernel_signature_erasure():
    source_files = {
        "src/Device/kernels/CameraRays.h": """
        GLOBAL_KERNEL_SIGNATURE(void) __launch_bounds__(64)
        CameraRays(HIPRTRenderData render_data) {
          render_data.random_number += 1;
        }
        """
    }
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct AppState { int n; };',
        "core.cpp": (
            'extern "C" void* core_on_load(void*, void*) { return 0; }\n'
            'extern "C" void core_on_update(void*, double) {}\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": 'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) {}',
        "host_runner.cpp": VALID_HOST_RUNNER,
        "device.hip": 'extern "C" __global__ void CameraRays(void* data) { data = data; }',
    }

    r = verify_split_output(files=files, manifest_arch=["gfx1201"], source_files=source_files)

    assert any(
        v.rule == "source_device_kernel_signature_not_preserved"
        and v.offending_symbol == "CameraRays"
        for v in r.violations
    )


def test_split_ignores_commented_kernel_examples_in_source_headers():
    source_files = {
        "src/Device/includes/FixIntellisense.h": """
        // extern "C" void __global__ my_function(...)
        /* GLOBAL_KERNEL_SIGNATURE(void) FakeKernel(RenderData data) {} */
        """
    }
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct AppState { int n; };',
        "core.cpp": (
            'extern "C" void* core_on_load(void*, void*) { return 0; }\n'
            'extern "C" void core_on_update(void*, double) {}\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": 'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) {}',
        "host_runner.cpp": VALID_HOST_RUNNER,
        "device.hip": "",
    }

    r = verify_split_output(files=files, manifest_arch=["gfx1201"], source_files=source_files)

    assert not any(v.offending_symbol == "my_function" for v in r.violations)
    assert not any(v.offending_symbol == "FakeKernel" for v in r.violations)


def test_split_ignores_constants_in_non_device_hip_helpers():
    source_files = {
        "src/kernels/flow_kernel_00.hip": (
            "constexpr float kFlowGain = 0.2f;\n"
            "constexpr int kColorBand = 1;\n"
            "struct FlowKernelNote { float gain; int band; };\n"
        ),
        "src/gpu/particle_kernels.hip": (
            "#include <hip/hip_runtime.h>\n"
            "constexpr float kHmrScaleDirection = 1.0f;\n"
            'extern "C" __global__ void advance_particle_field(float* x, int count) { '
            "int i = blockIdx.x * blockDim.x + threadIdx.x; "
            "if (i < count) x[i] += kHmrScaleDirection; }\n"
        ),
    }
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct AppState { float* x; int n; };',
        "core.cpp": (
            'extern "C" void* core_on_load(void*, void*) { return 0; }\n'
            'extern "C" void core_on_update(void*, double) { synthi_gpu_launch(nullptr, "advance_particle_field", 1, 256, 0, nullptr, { &x, &n }); }\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": 'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) {}',
        "host_runner.cpp": "int main() { auto gui_on_render = 0; return 0; }",
        "device.hip": (
            "constexpr float kHmrScaleDirection = 1.0f;\n"
            'extern "C" __global__ void advance_particle_field(float* x, int count) { '
            "int i = blockIdx.x * blockDim.x + threadIdx.x; "
            "if (i < count) x[i] += kHmrScaleDirection; }"
        ),
    }
    r = verify_split_output(files=files, manifest_arch=["gfx1201"], source_files=source_files)
    assert not any(
        v.rule == "source_device_constant_declaration_not_preserved"
        and v.offending_symbol in {"kFlowGain", "kColorBand"}
        for v in r.violations
    )


def test_split_rejects_stubbed_source_device_kernel_and_dangling_constants():
    source_files = {
        "src/gpu/particle_kernels.hip": (
            "#include <hip/hip_runtime.h>\n"
            "constexpr float kHmrScaleDirection = 1.0f;\n"
            "constexpr int kHmrScaleColorBias = 0;\n"
            'extern "C" __global__ void advance_particle_field(float* x, unsigned int* rgba, int count) { '
            "int i = blockIdx.x * blockDim.x + threadIdx.x; if (i >= count) return; "
            "x[i] += kHmrScaleDirection; rgba[i] = (unsigned int)(i + kHmrScaleColorBias); }\n"
        )
    }
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct AppState { float* x; unsigned int* rgba; int n; };',
        "core.cpp": (
            'extern "C" void* core_on_load(void*, void*) { return 0; }\n'
            'extern "C" void core_on_update(void*, double) { synthi_gpu_launch(nullptr, "advance_particle_field", 1, 256, 0, nullptr, { &x, &rgba, &n }); }\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": 'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) {}',
        "host_runner.cpp": "int main() { auto gui_on_render = 0; return 0; }",
        "device.hip": (
            "__constant__ float kHmrScaleDirection;\n"
            "__constant__ float kHmrScaleColorBias;\n"
            'extern "C" __global__ void advance_particle_field(float* x, unsigned int* rgba, int count) {}'
        ),
    }
    r = verify_split_output(files=files, manifest_arch=["gfx1201"], source_files=source_files)
    assert any(v.rule == "source_device_kernel_body_not_preserved" for v in r.violations)
    assert any(
        v.rule == "source_device_constant_declaration_not_preserved"
        and v.offending_symbol == "kHmrScaleColorBias"
        for v in r.violations
    )
    assert any(
        v.rule == "source_device_identifier_not_used"
        and v.offending_symbol == "kHmrScaleDirection"
        for v in r.violations
    )


def test_split_rejects_uninitialized_gui_render_surface():
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct AppState { float* h_x; float* h_y; int n; void* renderer; };',
        "core.cpp": (
            '#include <hip/hip_runtime.h>\n'
            'static AppState g_state{};\n'
            'extern "C" void* core_on_load(void* prev, void* renderer) { '
            'if (prev) { g_state = *reinterpret_cast<AppState*>(prev); } '
            'else { g_state.n = 1024; g_state.h_x = new float[1024]; g_state.h_y = new float[1024]; '
            'for (int i = 0; i < g_state.n; ++i) { g_state.h_x[i] = (float)((i % 80) * 10); g_state.h_y[i] = (float)((i / 80) * 10); } } '
            'return &g_state; }\n'
            'extern "C" void core_on_update(void*, double) { synthi_gpu_launch(nullptr, "step", 1, 256, 0, nullptr, { &d_x, &d_y, &n }); }\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": (
            '#include <SDL2/SDL.h>\n'
            'extern "C" void* gui_on_load(void*, void*, void* core) { return core; }\n'
            'extern "C" void gui_on_render(void* state_ptr) { '
            'auto* s = (AppState*)state_ptr; '
            'SDL_Renderer* renderer = reinterpret_cast<SDL_Renderer*>(s->renderer); '
            'SDL_SetRenderDrawColor(renderer, 0, 0, 0, 255); SDL_RenderClear(renderer); '
            'SDL_SetRenderDrawColor(renderer, 255, 255, 255, 255); '
            'for (int i = 0; i < s->n; ++i) { SDL_Rect r{(int)s->h_x[i], (int)s->h_y[i], 4, 4}; SDL_RenderFillRect(renderer, &r); } }'
        ),
        "host_runner.cpp": "int main() { auto gui_on_render = 0; return 0; }",
        "device.cu": 'extern "C" __global__ void step(float*, float*, int) {}',
    }
    r = verify_split_output(files=files, manifest_arch=["sm_80"])
    assert any(v.rule == "gui_render_surface_not_initialized" for v in r.violations)


def test_split_rejects_core_gui_state_type_mismatch():
    files = {
        "shared.h": (
            '#include "synthi_gpu_runtime.h"\n'
            "namespace draw { struct ParticleBuffers { float* x; float* y; unsigned int* rgba; int n; }; }"
        ),
        "core.cpp": (
            "struct RuntimeState { float x[64]; float y[64]; unsigned int rgba[64]; int n; };\n"
            "static RuntimeState g_state{};\n"
            'extern "C" void* core_on_load(void*, void*) { g_state.n = 64; return &g_state; }\n'
            'extern "C" void core_on_update(void*, double) { synthi_gpu_launch(nullptr, "step", 1, 64, 0, nullptr, { &n }); }\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": (
            '#include "shared.h"\n'
            'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\n'
            'extern "C" void gui_on_render(void* state_ptr) { '
            "auto* s = reinterpret_cast<draw::ParticleBuffers*>(state_ptr); "
            "for (int i = 0; i < s->n; ++i) { (void)s->rgba[i]; } }"
        ),
        "host_runner.cpp": "int main() { auto gui_on_render = 0; return 0; }",
        "device.hip": 'extern "C" __global__ void step(int) {}',
    }
    r = verify_split_output(files=files, manifest_arch=["gfx1201"])
    assert any(v.rule == "generated.core_gui_state_abi_mismatch" for v in r.violations)


def test_split_allows_core_gui_state_type_alias_match():
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nnamespace sim { struct RuntimeState { float x[64]; int n; }; }',
        "core.cpp": (
            '#include "shared.h"\n'
            "static sim::RuntimeState g_state{};\n"
            'extern "C" void* core_on_load(void*, void*) { g_state.n = 64; return static_cast<void*>(&g_state); }\n'
            'extern "C" void core_on_update(void*, double) { synthi_gpu_launch(nullptr, "step", 1, 64, 0, nullptr, { &n }); }\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": (
            '#include "shared.h"\n'
            'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\n'
            'extern "C" void gui_on_render(void* state_ptr) { '
            "auto* s = reinterpret_cast<RuntimeState*>(state_ptr); "
            "for (int i = 0; i < s->n; ++i) { (void)s->x[i]; } }"
        ),
        "host_runner.cpp": "int main() { auto gui_on_render = 0; return 0; }",
        "device.hip": 'extern "C" __global__ void step(int) {}',
    }
    r = verify_split_output(files=files, manifest_arch=["gfx1201"])
    assert not any(v.rule == "generated.core_gui_state_abi_mismatch" for v in r.violations)


def test_split_rejects_private_core_state_type_crossing_gui_boundary():
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct SharedOnly { int n; };',
        "core.cpp": (
            '#include "shared.h"\n'
            "struct AppState { float x[64]; int n; };\n"
            "static AppState g_state{};\n"
            'extern "C" void* core_on_load(void*, void*) { g_state.n = 64; return &g_state; }\n'
            'extern "C" void core_on_update(void*, double) { synthi_gpu_launch(nullptr, "step", 1, 64, 0, nullptr, { &n }); }\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": (
            '#include "shared.h"\n'
            'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\n'
            'extern "C" void gui_on_render(void* state_ptr) { '
            "auto* s = reinterpret_cast<AppState*>(state_ptr); "
            "for (int i = 0; i < s->n; ++i) { (void)s->x[i]; } }"
        ),
        "host_runner.cpp": "int main() { auto gui_on_render = 0; return 0; }",
        "device.hip": 'extern "C" __global__ void step(int) {}',
    }
    r = verify_split_output(files=files, manifest_arch=["gfx1201"])
    assert any(v.rule == "generated.host_state_type_not_shared" for v in r.violations)


def test_split_rejects_unqualified_namespaced_shared_constants():
    files = {
        "shared.h": (
            '#include "synthi_gpu_runtime.h"\n'
            "namespace scale { struct AppState { int n; }; constexpr int kParticleCount = 512; }"
        ),
        "core.cpp": (
            '#include "shared.h"\n'
            "static scale::AppState g_state{};\n"
            'extern "C" void* core_on_load(void*, void*) { g_state.n = kParticleCount; return &g_state; }\n'
            'extern "C" void core_on_update(void*, double) { synthi_gpu_launch(nullptr, "step", 1, 64, 0, nullptr, { &n }); }\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": (
            '#include "shared.h"\n'
            'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\n'
            'extern "C" void gui_on_render(void* state_ptr) { '
            "auto* s = reinterpret_cast<scale::AppState*>(state_ptr); (void)s; }"
        ),
        "host_runner.cpp": "int main() { auto gui_on_render = 0; return 0; }",
        "device.hip": 'extern "C" __global__ void step(int) {}',
    }
    r = verify_split_output(files=files, manifest_arch=["gfx1201"])
    assert any(
        v.rule == "generated.shared_namespace_symbol_unqualified"
        and v.offending_symbol == "scale::kParticleCount"
        for v in r.violations
    )


def test_split_allows_qualified_namespaced_shared_constants():
    files = {
        "shared.h": (
            '#include "synthi_gpu_runtime.h"\n'
            "namespace scale { struct AppState { int n; }; constexpr int kParticleCount = 512; }"
        ),
        "core.cpp": (
            '#include "shared.h"\n'
            "static scale::AppState g_state{};\n"
            'extern "C" void* core_on_load(void*, void*) { g_state.n = scale::kParticleCount; return &g_state; }\n'
            'extern "C" void core_on_update(void*, double) { synthi_gpu_launch(nullptr, "step", 1, 64, 0, nullptr, { &n }); }\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": (
            '#include "shared.h"\n'
            'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\n'
            'extern "C" void gui_on_render(void* state_ptr) { '
            "auto* s = reinterpret_cast<scale::AppState*>(state_ptr); (void)s; }"
        ),
        "host_runner.cpp": "int main() { auto gui_on_render = 0; return 0; }",
        "device.hip": 'extern "C" __global__ void step(int) {}',
    }
    r = verify_split_output(files=files, manifest_arch=["gfx1201"])
    assert not any(v.rule == "generated.shared_namespace_symbol_unqualified" for v in r.violations)


def test_split_rejects_invalid_device_descriptor_initializer():
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct AppState { int n; };',
        "core.cpp": (
            'extern "C" void* core_on_load(void*, void*) { return 0; }\n'
            'extern "C" void core_on_update(void*, double) { synthi_gpu_launch(nullptr, "step", 1, 256, 0, nullptr, { &n }); }\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { static DeviceDescriptor d = {1, "core"}; return &d; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": 'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) {}',
        "host_runner.cpp": "int main() { auto gui_on_render = 0; return 0; }",
        "device.cu": 'extern "C" __global__ void step(int) {}',
    }
    r = verify_split_output(files=files, manifest_arch=["sm_80"])
    assert any(v.rule == "invalid_device_descriptor_initializer" for v in r.violations)


def test_split_allows_device_init_kernel_before_update():
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct AppState { float* d_particles; int n; };',
        "core.cpp": (
            '#include <hip/hip_runtime.h>\n'
            'extern "C" void* core_on_load(void*, void*) { hipMalloc(&d_particles, 4096); int n = 1024; synthi_gpu_launch(nullptr, "init_particles", 4, 256, 0, nullptr, { &d_particles, &n }); return 0; }\n'
            'extern "C" void core_on_update(void*, double) { synthi_gpu_launch(nullptr, "step", 1, 256, 0, nullptr, { &d_particles, &n }); }\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": 'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) {}',
        "host_runner.cpp": "int main() { void* libgui = 0; auto gui_on_render = libgui; return 0; }",
        "device.cu": (
            'extern "C" __global__ void init_particles(float* p, int n) { '
            "int i = blockIdx.x * blockDim.x + threadIdx.x; if (i < n) p[i] = 0.0f; }\n"
            'extern "C" __global__ void step(float*) {}'
        ),
    }
    r = verify_split_output(files=files, manifest_arch=["sm_80"])
    assert not any(v.rule == "device_buffers_not_initialized" for v in r.violations)


def test_split_rejects_init_kernel_that_omits_update_device_buffers():
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct LaunchParams { float dt; };',
        "core.cpp": (
            '#include <hip/hip_runtime.h>\n'
            'extern "C" void* core_on_load(void*, void*) { '
            'hipMalloc(&dx, 4096); hipMalloc(&dy, 4096); hipMalloc(&dvx, 4096); '
            'hipMalloc(&dvy, 4096); hipMalloc(&drgba, 4096); return 0; }\n'
            'extern "C" void core_on_update(void*, double) { '
            'synthi_gpu_launch(nullptr, "init_particles", 4, 256, 0, nullptr, { &dx, &dy, &n }); '
            'synthi_gpu_launch(nullptr, "advance_particle_field", 4, 256, 0, nullptr, { &dx, &dy, &dvx, &dvy, &drgba, &n, &params }); }\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": 'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) {}',
        "host_runner.cpp": "int main() { void* libgui = 0; auto gui_on_render = libgui; return 0; }",
        "device.hip": (
            'extern "C" __global__ void init_particles(float* x, float* y, int count) { '
            "int i = blockIdx.x * blockDim.x + threadIdx.x; if (i < count) { x[i] = 10.0f; y[i] = 10.0f; } }\n"
            'extern "C" __global__ void advance_particle_field(float* x, float* y, float* vx, float* vy, unsigned int* rgba, int count, LaunchParams params) { '
            "int i = blockIdx.x * blockDim.x + threadIdx.x; if (i < count) { vx[i] += params.dt; rgba[i] = 0xffffffffu; } }"
        ),
    }
    r = verify_split_output(files=files, manifest_arch=["gfx1201"])
    assert any(
        v.rule == "device_init_kernel_incomplete" and "dvx" in (v.offending_symbol or "")
        for v in r.violations
    )


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


def test_split_rejects_kernel_launch_abi_argument_count_mismatch():
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct LaunchParams { float dt; float cx; };',
        "core.cpp": (
            'extern "C" void* core_on_load(void*, void*) { return 0; }\n'
            'extern "C" void core_on_update(void*, double) { '
            'float* x = 0; int n = 1; float dt = 0.1f; float cx = 400.0f; '
            'synthi_gpu_launch(gpu, "advance", 1, 256, 0, stream, { &x, &n, &dt, &cx }); }\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": 'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) {}',
        "host_runner.cpp": "int main() { return 0; }",
        "device.cu": 'extern "C" __global__ void advance(float* x, int n, LaunchParams params) {}',
    }
    r = verify_split_output(files=files, manifest_arch=["sm_80"])
    rules = {v.rule for v in r.violations}
    assert "kernel_launch_abi_mismatch" in rules


def test_split_rejects_launch_block_exceeding_kernel_launch_bounds_literal():
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"',
        "core.cpp": (
            'extern "C" void* core_on_load(void*, void*) { return 0; }\n'
            'extern "C" void core_on_update(void*, double) { '
            'int n = 1; synthi_gpu_launch(nullptr, "step", 1, 256, 0, nullptr, { &n }); }\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": 'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) {}',
        "host_runner.cpp": "int main() { return 0; }",
        "device.hip": 'GLOBAL_KERNEL_SIGNATURE(void) __launch_bounds__(64) step(int n) {}',
    }

    r = verify_split_output(files=files, manifest_arch=["gfx1201"])
    rules = {v.rule for v in r.violations}
    assert "kernel_launch_bounds_exceeded" in rules


def test_split_rejects_launch_block_exceeding_kernel_launch_bounds_dim3():
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"',
        "core.cpp": (
            'extern "C" void* core_on_load(void*, void*) { return 0; }\n'
            'extern "C" void core_on_update(void*, double) { '
            'int n = 1; int threads_x = 16; int threads_y = 16; '
            'Dim3 block{ (unsigned int)threads_x, (unsigned int)threads_y, 1 }; '
            'synthi_gpu_launch(nullptr, "step", 1, block, 0, nullptr, { &n }); }\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": 'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) {}',
        "host_runner.cpp": "int main() { return 0; }",
        "device.hip": 'GLOBAL_KERNEL_SIGNATURE(void) __launch_bounds__(64) step(int n) {}',
    }

    r = verify_split_output(files=files, manifest_arch=["gfx1201"])
    rules = {v.rule for v in r.violations}
    assert "kernel_launch_bounds_exceeded" in rules


def test_split_accepts_launch_block_within_kernel_launch_bounds_dim3():
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"',
        "core.cpp": (
            'extern "C" void* core_on_load(void*, void*) { return 0; }\n'
            'extern "C" void core_on_update(void*, double) { '
            'int n = 1; int threads_x = 8; int threads_y = 8; '
            'Dim3 block{ (unsigned int)threads_x, (unsigned int)threads_y, 1 }; '
            'synthi_gpu_launch(nullptr, "step", 1, block, 0, nullptr, { &n }); }\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": 'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) {}',
        "host_runner.cpp": "int main() { return 0; }",
        "device.hip": 'GLOBAL_KERNEL_SIGNATURE(void) __launch_bounds__(64) step(int n) {}',
    }

    r = verify_split_output(files=files, manifest_arch=["gfx1201"])
    rules = {v.rule for v in r.violations}
    assert "kernel_launch_bounds_exceeded" not in rules


def test_split_rejects_launch_block_exceeding_macro_kernel_launch_bounds():
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"',
        "core.cpp": (
            'extern "C" void* core_on_load(void*, void*) { return 0; }\n'
            'extern "C" void core_on_update(void*, double) { '
            'int n = 1; synthi_gpu_launch(nullptr, "step", 1, 128, 0, nullptr, { &n }); }\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": 'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) {}',
        "host_runner.cpp": "int main() { return 0; }",
        "device.hip": '#define STEP_THREADS 64\nGLOBAL_KERNEL_SIGNATURE(void) __launch_bounds__(STEP_THREADS) step(int n) {}',
    }

    r = verify_split_output(files=files, manifest_arch=["gfx1201"])
    rules = {v.rule for v in r.violations}
    assert "kernel_launch_bounds_exceeded" in rules


def test_split_rejects_launch_block_exceeding_constexpr_kernel_launch_bounds():
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"',
        "core.cpp": (
            'extern "C" void* core_on_load(void*, void*) { return 0; }\n'
            'extern "C" void core_on_update(void*, double) { '
            'int n = 1; Dim3 block{ 16, 8, 1 }; '
            'synthi_gpu_launch(nullptr, "step", 1, block, 0, nullptr, { &n }); }\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": 'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) {}',
        "host_runner.cpp": "int main() { return 0; }",
        "device.hip": 'constexpr int step_threads = 32 * 2;\n__global__ __launch_bounds__(step_threads) void step(int n) {}',
    }

    r = verify_split_output(files=files, manifest_arch=["gfx1201"])
    rules = {v.rule for v in r.violations}
    assert "kernel_launch_bounds_exceeded" in rules


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


def test_split_rejects_backend_swap_in_gui():
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"',
        "core.cpp": 'extern "C" void* core_on_load(void*, void*) { return 0; }\nextern "C" void core_on_update(void*, double) { synthi_gpu_launch(gpu, "particle_flow", 1, 256, 0, stream, { &x }); }\nextern "C" const DeviceDescriptor* device_descriptor() { return 0; }\nextern "C" void device_on_load(const unsigned char*, size_t) {}\nextern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }',
        "gui.cpp": '#include <GLFW/glfw3.h>\nextern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void* window) { glfwSwapBuffers((GLFWwindow*)window); }',
        "host_runner.cpp": "int main() { auto gui_on_render = 0; return 0; }",
        "device.hip": 'extern "C" __global__ void particle_flow(float*) {}',
    }
    r = verify_split_output(files=files, manifest_arch=["gfx1201"])
    assert any(
        v.rule == "gui_calls_backend_present" and v.offending_symbol == "glfwSwapBuffers"
        for v in r.violations
    )


def test_split_rejects_gui_creating_render_surface():
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"',
        "core.cpp": 'extern "C" void* core_on_load(void*, void*) { return 0; }\nextern "C" void core_on_update(void*, double) { synthi_gpu_launch(gpu, "particle_flow", 1, 256, 0, stream, { &x }); }\nextern "C" const DeviceDescriptor* device_descriptor() { return 0; }\nextern "C" void device_on_load(const unsigned char*, size_t) {}\nextern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }',
        "gui.cpp": '#include <GLFW/glfw3.h>\nextern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) { glfwCreateWindow(800, 600, "bad", nullptr, nullptr); }',
        "host_runner.cpp": "int main() { auto gui_on_render = 0; return 0; }",
        "device.hip": 'extern "C" __global__ void particle_flow(float*) {}',
    }
    r = verify_split_output(files=files, manifest_arch=["gfx1201"])
    assert any(
        v.rule == "gui_creates_render_surface" and v.offending_symbol == "glfwCreateWindow"
        for v in r.violations
    )


def test_split_rejects_translating_glfw_source_to_sdl():
    source_files = {
        "src/render/glfw_canvas.cpp": '#include <GLFW/glfw3.h>\nvoid draw(GLFWwindow* window) { glClear(GL_COLOR_BUFFER_BIT); }',
        "src/gpu/particles.hip": 'extern "C" __global__ void particle_flow(float*) {}',
    }
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"',
        "core.cpp": 'extern "C" void* core_on_load(void*, void*) { return 0; }\nextern "C" void core_on_update(void*, double) { synthi_gpu_launch(gpu, "particle_flow", 1, 256, 0, stream, { &x }); }\nextern "C" const DeviceDescriptor* device_descriptor() { return 0; }\nextern "C" void device_on_load(const unsigned char*, size_t) {}\nextern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }',
        "gui.cpp": '#include <SDL2/SDL.h>\nextern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) { SDL_RenderClear(nullptr); }',
        "host_runner.cpp": "int main() { auto gui_on_render = 0; return 0; }",
        "device.hip": 'extern "C" __global__ void particle_flow(float*) {}',
    }
    r = verify_split_output(
        files=files,
        manifest_arch=["gfx1201"],
        source_files=source_files,
    )
    assert any(
        v.rule == "render_backend_changed" and v.offending_symbol == "sdl"
        for v in r.violations
    )


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


def test_split_rejects_direct_launch_table_bypass():
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"',
        "core.cpp": (
            "void l() { auto t = synthi_gpu_launch_table(); "
            "synthi_gpu_launch_raw_checked(gpu, \"vec_add\", 0, 0, 0, 0, 0, 0, 0, 0, t.generation); }"
        ),
        "gui.cpp": "",
        "host_runner.cpp": "",
        "device.cu": "__global__ void vec_add(float*) {}",
    }
    r = verify_split_output(files=files, manifest_arch=["sm_80"])
    assert not r.ok
    assert any(v.rule == "launch_indirection_bypassed" for v in r.violations)


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

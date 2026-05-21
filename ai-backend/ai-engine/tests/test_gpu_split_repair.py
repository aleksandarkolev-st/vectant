from agents.gpu_split_repair import repair_split_artifacts
from verifier_gpu import verify_split_output


def test_repair_preserves_source_device_constant_declaration():
    source_files = {
        "src/gpu/effects.hip": (
            "#include <hip/hip_runtime.h>\n"
            "constexpr int kDeviceColorBias = 7;\n"
            'extern "C" __global__ void shade(unsigned int* out, int n) { '
            "int i = blockIdx.x * blockDim.x + threadIdx.x; "
            "if (i < n) out[i] = (unsigned int)(i + kDeviceColorBias); }"
        )
    }
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct AppState { unsigned int* out; int n; };',
        "core.cpp": (
            'extern "C" void* core_on_load(void*, void*) { return 0; }\n'
            'extern "C" void core_on_update(void*, double) { synthi_gpu_launch(nullptr, "shade", 1, 256, 0, nullptr, { &out, &n }); }\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": 'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) {}',
        "host_runner.cpp": "int main() { auto gui_on_render = 0; return 0; }",
        "device.hip": (
            "__constant__ float kDeviceColorBias;\n"
            'extern "C" __global__ void shade(unsigned int* out, int n) { '
            "int i = blockIdx.x * blockDim.x + threadIdx.x; "
            "if (i < n) out[i] = (unsigned int)(i + kDeviceColorBias); }"
        ),
    }
    verification = verify_split_output(
        files=files,
        manifest_arch=["gfx1201"],
        source_files=source_files,
    )
    assert any(v.rule == "source_device_constant_declaration_not_preserved" for v in verification.violations)

    repaired, report = repair_split_artifacts(
        files=files,
        manifest=None,
        source_files=source_files,
        verification=verification,
    )

    assert report["repaired"] is True
    assert "repair.source_device_constants" in report["repairRules"]
    assert "constexpr int kDeviceColorBias = 7;" in repaired["device.hip"]
    after = verify_split_output(
        files=repaired,
        manifest_arch=["gfx1201"],
        source_files=source_files,
    )
    assert not any(v.rule == "source_device_constant_declaration_not_preserved" for v in after.violations)


def test_repair_restores_source_kernel_semantics_from_device_headers():
    source_files = {
        "src/config/device_constants.hpp": "#pragma once\nnamespace scale { constexpr float kResetPadding = 18.0f; }",
        "src/gpu/particle_api.hpp": (
            '#pragma once\n#include "../config/device_constants.hpp"\n'
            "namespace scale { struct LaunchParams { float bounds_x; }; }"
        ),
        "src/gpu/kernels.hip": (
            '#include "particle_api.hpp"\n'
            "namespace scale {\n"
            "constexpr int kHmrScaleColorBias = 2;\n"
            "static __device__ unsigned int color_for(int i) { return (unsigned int)(i + kHmrScaleColorBias); }\n"
            'extern "C" __global__ void advance(float* x, unsigned int* rgba, int n, LaunchParams params) {\n'
            "  int i = blockIdx.x * blockDim.x + threadIdx.x;\n"
            "  if (i >= n) return;\n"
            "  if (x[i] < kResetPadding) x[i] = params.bounds_x - kResetPadding;\n"
            "  rgba[i] = color_for(i);\n"
            "}\n"
            "}\n"
        ),
    }
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct AppState { float* x; unsigned int* rgba; int n; };',
        "core.cpp": (
            'extern "C" void* core_on_load(void*, void*) { return 0; }\n'
            'extern "C" void core_on_update(void*, double) { synthi_gpu_launch(nullptr, "advance", 1, 256, 0, nullptr, { &x, &rgba, &n, &params }); }\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": 'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) {}',
        "host_runner.cpp": "int main() { auto gui_on_render = 0; return 0; }",
        "device.hip": (
            "constexpr int kHmrScaleColorBias = 2;\n"
            "struct LaunchParams { float bounds_x; };\n"
            'extern "C" __global__ void advance(float* x, unsigned int* rgba, int n, LaunchParams params) { '
            "int i = blockIdx.x * blockDim.x + threadIdx.x; if (i < n) rgba[i] = (unsigned int)i; }"
        ),
    }
    verification = verify_split_output(
        files=files,
        manifest_arch=["gfx1201"],
        source_files=source_files,
    )
    assert any(v.rule == "source_device_identifier_not_used" for v in verification.violations)
    assert any(v.rule == "source_device_identifier_not_preserved" for v in verification.violations)

    repaired, report = repair_split_artifacts(
        files=files,
        manifest=None,
        source_files=source_files,
        verification=verification,
    )

    assert report["repaired"] is True
    assert "repair.source_device_semantics" in report["repairRules"]
    assert "Synthi source-device preservation preamble" in repaired["device.hip"]
    assert "constexpr float kResetPadding = 18.0f;" in repaired["device.hip"]
    assert "color_for(i)" in repaired["device.hip"]
    after = verify_split_output(
        files=repaired,
        manifest_arch=["gfx1201"],
        source_files=source_files,
    )
    assert not any(v.rule.startswith("source_device_identifier_not_") for v in after.violations)


def test_repair_completes_init_kernel_for_update_device_buffers():
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct Params { float dt; };',
        "core.cpp": (
            '#include <hip/hip_runtime.h>\n'
            'extern "C" void* core_on_load(void*, void*) { '
            'hipMalloc(&d_x, 4096); hipMalloc(&d_y, 4096); '
            'hipMalloc(&d_velocity, 4096); return 0; }\n'
            'extern "C" void core_on_update(void*, double) { '
            'synthi_gpu_launch(nullptr, "init_buffers", 4, 256, 0, nullptr, { &d_x, &d_y, &count }); '
            'synthi_gpu_launch(nullptr, "step_buffers", 4, 256, 0, nullptr, { &d_x, &d_y, &d_velocity, &count, &params }); }\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": 'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) {}',
        "host_runner.cpp": "int main() { void* libgui = 0; auto gui_on_render = libgui; return 0; }",
        "device.hip": (
            'extern "C" __global__ void init_buffers(float* x, float* y, int count) { '
            "int i = blockIdx.x * blockDim.x + threadIdx.x; if (i < count) { x[i] = 0.0f; y[i] = 0.0f; } }\n"
            'extern "C" __global__ void step_buffers(float* x, float* y, float* velocity, int count, Params params) { '
            "int i = blockIdx.x * blockDim.x + threadIdx.x; if (i < count) { x[i] += velocity[i] * params.dt; } }"
        ),
    }
    verification = verify_split_output(files=files, manifest_arch=["gfx1201"])
    assert any(v.rule == "device_init_kernel_incomplete" for v in verification.violations)

    repaired, report = repair_split_artifacts(
        files=files,
        manifest=None,
        source_files={},
        verification=verification,
    )

    assert report["repaired"] is True
    assert "repair.init_kernel_buffers" in report["repairRules"]
    assert "{ &d_x, &d_y, &count, &d_velocity }" in repaired["core.cpp"]
    assert "void init_buffers(float* x, float* y, int count, float* d_velocity)" in repaired["device.hip"]
    assert "d_velocity[synthi_hmr_i] = 0.0f" in repaired["device.hip"]
    after = verify_split_output(files=repaired, manifest_arch=["gfx1201"])
    assert not any(v.rule == "device_init_kernel_incomplete" for v in after.violations)


def test_repair_reorders_existing_init_signature_buffers_without_count_mismatch():
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct Params { float dt; };',
        "core.cpp": (
            '#include <hip/hip_runtime.h>\n'
            'extern "C" void* core_on_load(void*, void*) { '
            'hipMalloc(&s.dx, 4096); hipMalloc(&s.dy, 4096); '
            'hipMalloc(&s.dvx, 4096); hipMalloc(&s.dvy, 4096); return 0; }\n'
            'extern "C" void core_on_update(void*, double) { '
            'synthi_gpu_launch(nullptr, "init_particles", 4, 256, 0, nullptr, { &s.dx, &s.dy, &s.count }); '
            'synthi_gpu_launch(nullptr, "advance_particle_field", 4, 256, 0, nullptr, { &s.dx, &s.dy, &s.dvx, &s.dvy, &s.count }); }\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": 'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) {}',
        "host_runner.cpp": "int main() { void* libgui = 0; auto gui_on_render = libgui; return 0; }",
        "device.hip": (
            'extern "C" __global__ void init_particles(float* dx, float* dy, float* dvx, float* dvy, int count) { '
            "int i = blockIdx.x * blockDim.x + threadIdx.x; if (i < count) { dx[i] = 0.0f; dy[i] = 0.0f; } }\n"
            'extern "C" __global__ void advance_particle_field(float* dx, float* dy, float* dvx, float* dvy, int count) { '
            "int i = blockIdx.x * blockDim.x + threadIdx.x; if (i < count) { dx[i] += dvx[i]; dy[i] += dvy[i]; } }"
        ),
    }
    verification = verify_split_output(files=files, manifest_arch=["gfx1201"])
    assert any(v.rule == "device_init_kernel_incomplete" for v in verification.violations)

    repaired, report = repair_split_artifacts(
        files=files,
        manifest=None,
        source_files={},
        verification=verification,
    )

    assert report["repaired"] is True
    assert (
        '{ &s.dx, &s.dy, &s.dvx, &s.dvy, &s.count }'
        in repaired["core.cpp"]
    )
    after = verify_split_output(files=repaired, manifest_arch=["gfx1201"])
    rules = {v.rule for v in after.violations}
    assert "device_init_kernel_incomplete" not in rules
    assert "kernel_launch_abi_mismatch" not in rules
    assert "dvx[synthi_hmr_i] = 0.0f" in repaired["device.hip"]
    assert "dvy[synthi_hmr_i] = 0.0f" in repaired["device.hip"]


def test_repair_flattens_device_kernel_signature_to_launch_abi():
    files = {
        "shared.h": (
            '#include "synthi_gpu_runtime.h"\n'
            "struct AppState {\n"
            "  float* dx;\n"
            "  float* dy;\n"
            "  float* dvx;\n"
            "  float* dvy;\n"
            "  unsigned int* drgba;\n"
            "  int count;\n"
            "  float dt;\n"
            "  float flow_scale;\n"
            "  float swirl;\n"
            "};"
        ),
        "core.cpp": (
            'extern "C" void* core_on_load(void*, void*) { static AppState s; return &s; }\n'
            'extern "C" void core_on_update(void* state, double) { '
            "auto* s = static_cast<AppState*>(state); "
            'synthi_gpu_launch(nullptr, "advance_particle_field", 4, 256, 0, nullptr, '
            "{ &s->dx, &s->dy, &s->dvx, &s->dvy, &s->drgba, &s->count, &s->dt, &s->flow_scale, &s->swirl }); }\n"
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": 'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) {}',
        "host_runner.cpp": "int main() { void* libgui = 0; auto gui_on_render = libgui; return 0; }",
        "device.hip": (
            'extern "C" __global__ void advance_particle_field('
            "float* dx, float* dy, float* dvx, float* dvy, unsigned int* drgba, int count, float dt) { "
            "int i = blockIdx.x * blockDim.x + threadIdx.x; "
            "if (i < count) { dx[i] += dvx[i] * dt; dy[i] += dvy[i] * dt; drgba[i] = 0xff00ff00u; } }"
        ),
    }
    verification = verify_split_output(files=files, manifest_arch=["gfx1201"])
    assert any(v.rule == "kernel_launch_abi_mismatch" for v in verification.violations)

    repaired, report = repair_split_artifacts(
        files=files,
        manifest=None,
        source_files={},
        verification=verification,
    )

    assert report["repaired"] is True
    assert "repair.launch_abi_mismatch" in report["repairRules"]
    assert "float flow_scale" in repaired["device.hip"]
    assert "float swirl" in repaired["device.hip"]
    after = verify_split_output(files=repaired, manifest_arch=["gfx1201"])
    assert not any(v.rule == "kernel_launch_abi_mismatch" for v in after.violations)


def test_repair_launch_argument_addresses_for_simple_lvalues():
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct AppState { float* dx; int count; };',
        "core.cpp": (
            'extern "C" void* core_on_load(void*, void*) { static AppState s; return &s; }\n'
            'extern "C" void core_on_update(void* state, double) { '
            "auto* s = static_cast<AppState*>(state); "
            'synthi_gpu_launch(nullptr, "step", 1, 64, 0, nullptr, { s->dx, s->count }); }\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": 'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) {}',
        "host_runner.cpp": "int main() { void* libgui = 0; auto gui_on_render = libgui; return 0; }",
        "device.hip": (
            'extern "C" __global__ void step(float* dx, int count) { '
            "int i = blockIdx.x * blockDim.x + threadIdx.x; if (i < count) dx[i] += 1.0f; }"
        ),
    }
    verification = verify_split_output(files=files, manifest_arch=["gfx1201"])
    assert any(v.rule == "launch_arg_not_address" for v in verification.violations)

    repaired, report = repair_split_artifacts(
        files=files,
        manifest=None,
        source_files={},
        verification=verification,
    )

    assert report["repaired"] is True
    assert "repair.launch_abi_mismatch" in report["repairRules"]
    assert "{ &s->dx, &s->count }" in repaired["core.cpp"]
    after = verify_split_output(files=repaired, manifest_arch=["gfx1201"])
    assert not any(v.rule == "launch_arg_not_address" for v in after.violations)


def test_repair_guards_device_to_host_copy_on_launch_result():
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct Params { float dt; };',
        "core.cpp": (
            '#include <hip/hip_runtime.h>\n'
            'extern "C" void* core_on_load(void*, void*) { return 0; }\n'
            'extern "C" void core_on_update(void*, double) { '
            'synthi_gpu_launch(nullptr, "advance_particle_field", 4, 256, 0, nullptr, { &d_x, &count }); '
            'hipMemcpy(h_x, d_x, 4096, hipMemcpyDeviceToHost); }\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": 'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) {}',
        "host_runner.cpp": "int main() { void* libgui = 0; auto gui_on_render = libgui; return 0; }",
        "device.hip": (
            'extern "C" __global__ void advance_particle_field(float* x, int count) { '
            "int i = blockIdx.x * blockDim.x + threadIdx.x; if (i < count) { x[i] += 1.0f; } }"
        ),
    }
    verification = verify_split_output(files=files, manifest_arch=["gfx1201"])
    assert any(v.rule == "device_to_host_copy_not_launch_guarded" for v in verification.violations)

    repaired, report = repair_split_artifacts(
        files=files,
        manifest=None,
        source_files={},
        verification=verification,
    )

    assert report["repaired"] is True
    assert "repair.device_to_host_copy_guard" in report["repairRules"]
    assert "bool synthi_hmr_launch_ok_1 = synthi_gpu_launch" in repaired["core.cpp"]
    assert "if (synthi_hmr_launch_ok_1) { hipMemcpy" in repaired["core.cpp"]
    after = verify_split_output(files=repaired, manifest_arch=["gfx1201"])
    assert not any(v.rule == "device_to_host_copy_not_launch_guarded" for v in after.violations)

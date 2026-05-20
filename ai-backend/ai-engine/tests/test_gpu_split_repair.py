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

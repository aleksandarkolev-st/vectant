from types import SimpleNamespace

from agents.gpu_split_repair import repair_split_artifacts, sanitize_generated_heal_output
from verifier_gpu import Violation, verify_split_output


def test_heal_sanitizer_removes_missing_project_toolkit_include_and_calls():
    source = (
        "#include <GL/gl.h>\n"
        '#include "imgui/imgui.h"\n'
        '#include "shared.h"\n'
        'extern "C" void gui_on_render(void* state_ptr) {\n'
        "    glBegin(GL_TRIANGLES);\n"
        "    glEnd();\n"
        "    ImGui::NewFrame();\n"
        '    ImGui::Begin("Panel");\n'
        '    ImGui::Text("Frame");\n'
        "    ImGui::End();\n"
        "}\n"
    )
    repaired, changed = sanitize_generated_heal_output(
        module="gui",
        source=source,
        errors='fatal error: "imgui/imgui.h" file not found',
    )

    assert changed is True
    assert '#include "imgui/imgui.h"' not in repaired
    assert "ImGui::" not in repaired
    assert "#include <GL/gl.h>" in repaired
    assert '#include "shared.h"' in repaired
    assert "glBegin(GL_TRIANGLES);" in repaired


def test_repair_materializes_visible_opengl_render_for_glfw_source():
    source_files = {
        "src/main.cpp": (
            "#include <GLFW/glfw3.h>\n"
            "#include <GL/gl.h>\n"
            "void draw_frame() { glClear(GL_COLOR_BUFFER_BIT); }"
        )
    }
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct AppState { int frame; };',
        "core.cpp": (
            'extern "C" void* core_on_load(void*, void*) { static AppState s; return &s; }\n'
            'extern "C" void core_on_update(void*, double) {}\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": (
            'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\n'
            'extern "C" void gui_on_render(void* state_ptr) { (void)state_ptr; }'
        ),
        "host_runner.cpp": "int main() { auto gui_on_render = 0; return 0; }",
        "device.hip": 'extern "C" __global__ void noop() {}',
    }
    verification = verify_split_output(
        files=files,
        manifest_arch=["gfx1201"],
        source_files=source_files,
    )
    assert any(v.rule == "gui_render_no_effect" for v in verification.violations)

    repaired, report = repair_split_artifacts(
        files=files,
        manifest=None,
        source_files=source_files,
        verification=verification,
    )

    assert report["repaired"] is True
    assert "repair.gui_render_effect" in report["repairRules"]
    assert "#include <GL/gl.h>" in repaired["gui.cpp"]
    assert "glBegin(GL_QUADS)" in repaired["gui.cpp"]
    assert "glVertex2f" in repaired["gui.cpp"]
    after = verify_split_output(
        files=repaired,
        manifest_arch=["gfx1201"],
        source_files=source_files,
    )
    assert not any(v.rule == "gui_render_no_effect" for v in after.violations)
    assert not any(v.rule == "gui_render_too_sparse" for v in after.violations)


def test_repair_replaces_project_ui_toolkit_render_with_self_contained_opengl():
    source_files = {
        "src/main.cpp": (
            "#include <GLFW/glfw3.h>\n"
            "void draw_frame() { glClear(GL_COLOR_BUFFER_BIT); }"
        ),
        "thirdparties/imgui/imgui.h": "namespace ImGui { void Begin(const char*); void Text(const char*); void End(); }",
    }
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct AppState { int frame_count; };',
        "core.cpp": (
            'extern "C" void* core_on_load(void*, void*) { static AppState s; return &s; }\n'
            'extern "C" void core_on_update(void*, double) {}\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": (
            '#include <GLFW/glfw3.h>\n'
            'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\n'
            'extern "C" void gui_on_render(void* state_ptr) { '
            "(void)state_ptr; ImGui::Begin(\"Stats\"); ImGui::Text(\"Frame\"); ImGui::End(); }"
        ),
        "host_runner.cpp": "int main() { auto gui_on_render = 0; return 0; }",
        "device.hip": 'extern "C" __global__ void noop() {}',
    }
    verification = verify_split_output(
        files=files,
        manifest_arch=["gfx1201"],
        source_files=source_files,
    )
    assert any(v.rule == "gui_render_no_effect" for v in verification.violations)

    repaired, report = repair_split_artifacts(
        files=files,
        manifest=None,
        source_files=source_files,
        verification=verification,
    )

    assert "repair.gui_render_effect" in report["repairRules"]
    assert "ImGui::" not in repaired["gui.cpp"]
    assert "glBegin(GL_QUADS)" in repaired["gui.cpp"]
    after = verify_split_output(
        files=repaired,
        manifest_arch=["gfx1201"],
        source_files=source_files,
    )
    assert not any(v.rule == "gui_render_no_effect" for v in after.violations)


def test_repair_uses_generated_opengl_context_when_source_context_is_target_scoped():
    source_files = {
        "src/Device/kernels/CameraRays.h": 'extern "C" __global__ void CameraRays() {}',
    }
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct AppState { int width; int height; void* h_output; };',
        "core.cpp": (
            'extern "C" void* core_on_load(void*, void*) { static AppState s; return &s; }\n'
            'extern "C" void core_on_update(void*, double) {}\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": (
            '#include <GL/gl.h>\n'
            '#include "imgui/imgui.h"\n'
            '#include "shared.h"\n'
            'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\n'
            'extern "C" void gui_on_render(void* state_ptr) { '
            "AppState* state = reinterpret_cast<AppState*>(state_ptr); "
            "glBindTexture(GL_TEXTURE_2D, 0); "
            "ImGui::Begin(\"Preview\"); ImGui::Image(state->h_output, ImVec2(state->width, state->height)); ImGui::End(); }"
        ),
        "host_runner.cpp": "int main() { auto gui_on_render = 0; return 0; }",
        "device.hip": 'extern "C" __global__ void CameraRays() {}',
    }
    verification = verify_split_output(
        files=files,
        manifest_arch=["gfx1201"],
        source_files=source_files,
    )
    assert any(v.rule == "gui_render_no_effect" for v in verification.violations)

    repaired, report = repair_split_artifacts(
        files=files,
        manifest=None,
        source_files=source_files,
        verification=verification,
    )

    assert "repair.generated_project_includes" in report["repairRules"]
    assert "repair.gui_render_effect" in report["repairRules"]
    assert "imgui" not in repaired["gui.cpp"]
    assert "ImGui::" not in repaired["gui.cpp"]
    assert "glBegin(GL_QUADS)" in repaired["gui.cpp"]


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


def test_repair_bridges_macro_kernel_device_headers_without_stubbing():
    source_files = {
        "src/Device/includes/FixIntellisense.h": (
            "#pragma once\n"
            "#ifdef __KERNELCC__\n"
            "#define GLOBAL_KERNEL_SIGNATURE(returnType) extern \"C\" returnType __global__\n"
            "#else\n"
            "#define GLOBAL_KERNEL_SIGNATURE(returnType) returnType\n"
            "#endif\n"
        ),
        "src/Device/kernels/CameraRays.h": (
            "#pragma once\n"
            '#include "Device/includes/FixIntellisense.h"\n'
            "constexpr int kCameraSeedOffset = 3;\n"
            "#ifdef __KERNELCC__\n"
            "GLOBAL_KERNEL_SIGNATURE(void) __launch_bounds__(64) CameraRays(HIPRTRenderData render_data)\n"
            "#else\n"
            "GLOBAL_KERNEL_SIGNATURE(void) inline CameraRays(HIPRTRenderData render_data, int x, int y)\n"
            "#endif\n"
            "{ render_data.random_number += kCameraSeedOffset; }\n"
        ),
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
        "host_runner.cpp": "int main() { void* libgui = 0; auto gui_on_render = libgui; return 0; }",
        "device.hip": 'extern "C" __global__ void CameraRays(void* data) {}',
    }
    verification = verify_split_output(
        files=files,
        manifest_arch=["gfx1201"],
        source_files=source_files,
    )
    assert any(v.rule == "source_device_kernel_signature_not_preserved" for v in verification.violations)

    repaired, report = repair_split_artifacts(
        files=files,
        manifest=None,
        source_files=source_files,
        verification=verification,
    )

    assert report["repaired"] is True
    assert "repair.source_device_include_bridge" in report["repairRules"]
    assert '#include "src/Device/kernels/CameraRays.h"' in repaired["device.hip"]
    assert "#include <hip/hip_runtime.h>" in repaired["device.hip"]
    assert "__KERNELCC__" in repaired["device.hip"]
    after = verify_split_output(
        files=repaired,
        manifest_arch=["gfx1201"],
        source_files=source_files,
    )
    assert not any(v.rule.startswith("source_device_kernel_") for v in after.violations)
    assert not any(v.rule.startswith("source_device_identifier_") for v in after.violations)


def test_repair_bridge_derives_device_prelude_and_guarded_option_defaults():
    source_files = {
        "thirdparties/HIPRT-Fork/hiprt/impl/hiprt_device_impl.h": (
            "#pragma once\n#include <hiprt/impl/Math.h>\n#include <hiprt/hiprt_device.h>\n"
        ),
        "src/HostDeviceCommon/KernelOptions/Common.h": (
            "#pragma once\n#define KERNEL_OPTION_TRUE 1\n#define KERNEL_OPTION_FALSE 0\n"
        ),
        "src/HostDeviceCommon/KernelOptions/KernelOptions.h": (
            "#pragma once\n"
            '#include "HostDeviceCommon/KernelOptions/Common.h"\n'
            "#ifndef __KERNELCC__\n"
            "#define __shared__\n"
            "#define __restrict__\n"
            "#define FeatureToggle KERNEL_OPTION_TRUE\n"
            "#define KernelBlockWidthHeight 8\n"
            "#define KernelWorkgroupThreadCount (KernelBlockWidthHeight * KernelBlockWidthHeight)\n"
            "#endif\n"
        ),
        "src/HostDeviceCommon/Math.h": (
            "#pragma once\n"
            "#if defined(__KERNELCC__)\n"
            "#include <hiprt/hiprt_device.h>\n"
            "#endif\n"
        ),
        "src/Device/includes/FixIntellisense.h": (
            "#pragma once\n"
            "#ifdef __KERNELCC__\n"
            "#define GLOBAL_KERNEL_SIGNATURE(returnType) extern \"C\" returnType __global__\n"
            "#else\n"
            "#define GLOBAL_KERNEL_SIGNATURE(returnType) returnType\n"
            "#endif\n"
        ),
        "src/Device/kernels/CameraRays.h": (
            "#pragma once\n"
            '#include "HostDeviceCommon/Math.h"\n'
            '#include "HostDeviceCommon/KernelOptions/KernelOptions.h"\n'
            '#include "Device/includes/FixIntellisense.h"\n'
            "#if RuntimeCompileOption == KERNEL_OPTION_TRUE\n"
            "#define RuntimeCompileOptionBranch 1\n"
            "#else\n"
            "#define RuntimeCompileOptionBranch 0\n"
            "#endif\n"
            "GLOBAL_KERNEL_SIGNATURE(void) CameraRays(int* out)\n"
            "{ if (FeatureToggle == KERNEL_OPTION_TRUE && RuntimeCompileOptionBranch) *out = KernelWorkgroupThreadCount; }\n"
        ),
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
        "host_runner.cpp": "int main() { void* libgui = 0; auto gui_on_render = libgui; return 0; }",
        "device.hip": 'extern "C" __global__ void CameraRays(void* data) {}',
    }
    verification = verify_split_output(
        files=files,
        manifest_arch=["gfx1201"],
        source_files=source_files,
    )
    assert any(v.rule == "source_device_kernel_signature_not_preserved" for v in verification.violations)

    repaired, report = repair_split_artifacts(
        files=files,
        manifest=None,
        source_files=source_files,
        verification=verification,
    )

    device = repaired["device.hip"]
    assert "repair.source_device_include_bridge" in report["repairRules"]
    assert "#include <hiprt/impl/hiprt_device_impl.h>" in device
    assert "// Synthi source-derived device macro defaults" in device
    assert "#ifndef __shared__" not in device
    assert "#define __restrict__" not in device
    assert "#ifndef FeatureToggle\n#define FeatureToggle KERNEL_OPTION_TRUE\n#endif" in device
    assert "#ifndef KernelWorkgroupThreadCount\n#define KernelWorkgroupThreadCount (KernelBlockWidthHeight * KernelBlockWidthHeight)\n#endif" in device
    assert "#ifndef RuntimeCompileOption\n#define RuntimeCompileOption KERNEL_OPTION_FALSE\n#endif" in device
    assert device.index("#ifndef RuntimeCompileOption") < device.index(
        '#include "src/Device/kernels/CameraRays.h"'
    )
    assert device.index("#include <hiprt/impl/hiprt_device_impl.h>") < device.index(
        '#include "src/Device/kernels/CameraRays.h"'
    )


def test_repair_prefers_source_device_bridge_without_verifier_failure():
    source_files = {
        "thirdparty/runtime/impl/device_impl.h": "#pragma once\nnamespace rt { __device__ int dot(int v) { return v; } }\n",
        "src/options/KernelOptions.h": (
            "#pragma once\n"
            "#define MODE_A 7\n"
            "#ifndef __KERNELCC__\n"
            "#define RuntimeMode MODE_A\n"
            "#define WorkgroupSize 64\n"
            "#endif\n"
        ),
        "src/kernels/Step.h": (
            "#pragma once\n"
            '#include "options/KernelOptions.h"\n'
            '#include <runtime/impl/device_impl.h>\n'
            "#define GLOBAL_KERNEL_SIGNATURE(returnType) extern \"C\" returnType __global__\n"
            "GLOBAL_KERNEL_SIGNATURE(void) step(int* out) { out[0] = RuntimeMode + WorkgroupSize; }\n"
        ),
    }
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\n',
        "core.cpp": (
            'extern "C" void* core_on_load(void*, void*) { return 0; }\n'
            'extern "C" void core_on_update(void*, double) {}\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": 'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) {}',
        "host_runner.cpp": "int main() { void* libgui = 0; auto gui_on_render = libgui; return 0; }",
        "device.hip": '#include "src/kernels/Step.h"\n',
    }
    verification = verify_split_output(
        files=files,
        manifest_arch=["gfx1201"],
        source_files=source_files,
    )
    assert not any(v.rule.startswith("source_device_") for v in verification.violations)

    repaired, report = repair_split_artifacts(
        files=files,
        manifest=None,
        source_files=source_files,
        verification=verification,
    )

    device = repaired["device.hip"]
    assert report["repaired"] is True
    assert "repair.source_device_include_bridge" in report["repairRules"]
    assert "#include <runtime/impl/device_impl.h>" in device
    assert "#ifndef RuntimeMode\n#define RuntimeMode MODE_A\n#endif" in device
    assert "#ifndef WorkgroupSize\n#define WorkgroupSize 64\n#endif" in device
    assert device.index("#ifndef RuntimeMode") < device.index('#include "src/kernels/Step.h"')


def test_repair_bridge_includes_source_owned_device_callback_definitions():
    source_files = {
        "thirdparties/HIPRT-Fork/hiprt/impl/hiprt_device_impl.h": (
            "#pragma once\n"
            "HIPRT_DEVICE bool filterFunc(int value);\n"
            "HIPRT_DEVICE bool traverse(int value) { return filterFunc(value); }\n"
        ),
        "src/device_callbacks.h": (
            "#pragma once\n"
            "#include <hiprt/impl/hiprt_device_impl.h>\n"
            "HIPRT_DEVICE bool filterFunc(int value) { return value > 0; }\n"
        ),
        "src/Device/includes/FixIntellisense.h": (
            "#pragma once\n"
            "#ifdef __KERNELCC__\n"
            "#define GLOBAL_KERNEL_SIGNATURE(returnType) extern \"C\" returnType __global__\n"
            "#else\n"
            "#define GLOBAL_KERNEL_SIGNATURE(returnType) returnType\n"
            "#endif\n"
        ),
        "src/Device/kernels/CameraRays.h": (
            "#pragma once\n"
            "#include <hiprt/impl/hiprt_device_impl.h>\n"
            '#include "Device/includes/FixIntellisense.h"\n'
            "GLOBAL_KERNEL_SIGNATURE(void) CameraRays(int* out)\n"
            "{ if (traverse(1)) *out = 1; }\n"
        ),
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
        "host_runner.cpp": "int main() { void* libgui = 0; auto gui_on_render = libgui; return 0; }",
        "device.hip": 'extern "C" __global__ void CameraRays(void* data) {}',
    }

    verification = verify_split_output(
        files=files,
        manifest_arch=["gfx1201"],
        source_files=source_files,
    )
    repaired, report = repair_split_artifacts(
        files=files,
        manifest=None,
        source_files=source_files,
        verification=verification,
    )

    device = repaired["device.hip"]
    assert "repair.source_device_include_bridge" in report["repairRules"]
    assert '#include "src/device_callbacks.h"' in device
    assert "#include <hiprt/impl/hiprt_device_impl.h>" not in device
    assert device.index('#include "src/device_callbacks.h"') < device.index(
        '#include "src/Device/kernels/CameraRays.h"'
    )


def test_repair_bridge_does_not_duplicate_transitively_included_source_constants():
    source_files = {
        "src/HostDeviceCommon/Math.h": (
            "#pragma once\n"
            "__device__ inline int helper() { return 1; }\n"
            "constexpr float kNestedConstant = 2.0f;\n"
        ),
        "src/Device/includes/FixIntellisense.h": (
            "#pragma once\n"
            "#ifdef __KERNELCC__\n"
            "#define GLOBAL_KERNEL_SIGNATURE(returnType) extern \"C\" returnType __global__\n"
            "#else\n"
            "#define GLOBAL_KERNEL_SIGNATURE(returnType) returnType\n"
            "#endif\n"
        ),
        "src/Device/kernels/CameraRays.h": (
            "#pragma once\n"
            '#include "HostDeviceCommon/Math.h"\n'
            '#include "Device/includes/FixIntellisense.h"\n'
            "GLOBAL_KERNEL_SIGNATURE(void) CameraRays(int* out) { *out = (int)kNestedConstant + helper(); }\n"
        ),
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
        "host_runner.cpp": "int main() { void* libgui = 0; auto gui_on_render = libgui; return 0; }",
        "device.hip": 'extern "C" __global__ void CameraRays(void* data) {}',
    }
    verification = verify_split_output(
        files=files,
        manifest_arch=["gfx1201"],
        source_files=source_files,
    )
    repaired, _report = repair_split_artifacts(
        files=files,
        manifest=None,
        source_files=source_files,
        verification=verification,
    )

    device = repaired["device.hip"]
    assert '#include "src/Device/kernels/CameraRays.h"' in device
    assert "kNestedConstant" not in device

    after = verify_split_output(
        files=repaired,
        manifest_arch=["gfx1201"],
        source_files=source_files,
    )
    assert not any(v.rule == "source_device_constant_declaration_not_preserved" for v in after.violations)
    assert not any(v.rule == "source_device_identifier_not_preserved" for v in after.violations)


def test_repair_removes_generated_gpu_sdk_vector_type_redeclarations():
    files = {
        "shared.h": (
            '#include "synthi_gpu_runtime.h"\n'
            "#include <hip/hip_runtime.h>\n"
            "struct float3 { float x, y, z; };\n"
            "struct int2 { int x, y; };\n"
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
        "host_runner.cpp": "int main() { void* libgui = 0; auto gui_on_render = libgui; return 0; }",
        "device.hip": "extern \"C\" __global__ void noop() {}",
    }
    verification = verify_split_output(files=files, manifest_arch=["gfx1201"], source_files={})
    assert any(v.rule == "generated_role_redeclares_gpu_sdk_type" for v in verification.violations)

    repaired, report = repair_split_artifacts(
        files=files,
        manifest=None,
        source_files={},
        verification=verification,
    )

    assert "repair.gpu_sdk_type_redeclarations" in report["repairRules"]
    assert "struct float3" not in repaired["shared.h"]
    assert "struct int2" not in repaired["shared.h"]
    assert "make_float3" not in repaired["shared.h"]
    assert "make_int2" not in repaired["shared.h"]
    assert "float3 p" in repaired["shared.h"]
    assert "int2 size" in repaired["shared.h"]
    after = verify_split_output(files=repaired, manifest_arch=["gfx1201"], source_files={})
    assert not any(v.rule == "generated_role_redeclares_gpu_sdk_type" for v in after.violations)


def test_repair_strips_verifier_rejected_project_includes():
    source_files = {
        "thirdparties/imgui/imgui.h": "namespace ImGui { void Text(const char*); }",
    }
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct AppState { int frame; };',
        "core.cpp": (
            'extern "C" void* core_on_load(void*, void*) { return 0; }\n'
            'extern "C" void core_on_update(void*, double) {}\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": '#include <imgui.h>\nextern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) {}',
        "host_runner.cpp": "int main() { void* core_state = 0; void (*gui_render)(void*) = 0; if (gui_render) gui_render(core_state); return 0; }",
        "device.hip": 'extern "C" __global__ void step(int) {}',
    }
    verification = verify_split_output(
        files=files,
        manifest_arch=["gfx1201"],
        source_files=source_files,
    )
    assert any(v.rule == "generated_role_includes_project_header" for v in verification.violations)

    repaired, report = repair_split_artifacts(
        files=files,
        manifest=None,
        source_files=source_files,
        verification=verification,
    )

    assert report["repaired"] is True
    assert "repair.generated_project_includes" in report["repairRules"]
    assert "imgui.h" not in repaired["gui.cpp"]
    after = verify_split_output(
        files=repaired,
        manifest_arch=["gfx1201"],
        source_files=source_files,
    )
    assert not any(v.rule == "generated_role_includes_project_header" for v in after.violations)


def test_repair_removes_unbacked_launches_when_source_device_headers_are_authority():
    source_files = {
        "src/Device/includes/FixIntellisense.h": (
            "#pragma once\n"
            "#ifdef __KERNELCC__\n"
            "#define GLOBAL_KERNEL_SIGNATURE(returnType) extern \"C\" returnType __global__\n"
            "#else\n"
            "#define GLOBAL_KERNEL_SIGNATURE(returnType) returnType\n"
            "#endif\n"
        ),
        "src/Device/kernels/CameraRays.h": (
            "#pragma once\n"
            '#include "Device/includes/FixIntellisense.h"\n'
            "struct HIPRTRenderData { unsigned int random_number; };\n"
            "GLOBAL_KERNEL_SIGNATURE(void) __launch_bounds__(64) CameraRays(HIPRTRenderData render_data)\n"
            "{ render_data.random_number += 3u; }\n"
        ),
    }
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct AppState { int frame; };',
        "core.cpp": (
            'extern "C" void* core_on_load(void*, void*) { static AppState s; return &s; }\n'
            'extern "C" void core_on_update(void*, double) { '
            'synthi_gpu_launch(nullptr, "init_buffers", 1, 64, 0, nullptr, { &frame }); '
            'bool launched = synthi_gpu_launch(nullptr, "my_function", 1, 64, 0, nullptr, { &frame }); '
            "if (launched) { ++frame; } }\n"
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": (
            'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\n'
            'extern "C" void gui_on_render(void*) {}'
        ),
        "host_runner.cpp": "int main() { void* libgui = 0; auto gui_on_render = libgui; return 0; }",
        "device.hip": 'extern "C" __global__ void CameraRays(void* data) {}',
    }
    verification = verify_split_output(
        files=files,
        manifest_arch=["gfx1201"],
        source_files=source_files,
    )
    assert any(v.rule == "source_device_kernel_signature_not_preserved" for v in verification.violations)
    assert {
        v.offending_symbol
        for v in verification.violations
        if v.rule == "launch_site_unresolved"
    } == {"init_buffers", "my_function"}

    repaired, report = repair_split_artifacts(
        files=files,
        manifest=None,
        source_files=source_files,
        verification=verification,
    )

    assert report["repaired"] is True
    assert "repair.source_device_include_bridge" in report["repairRules"]
    assert "repair.unresolved_generated_launches" in report["repairRules"]
    assert 'synthi_gpu_launch(nullptr, "init_buffers"' not in repaired["core.cpp"]
    assert 'synthi_gpu_launch(nullptr, "my_function"' not in repaired["core.cpp"]
    assert "bool launched = false;" not in repaired["core.cpp"]
    after = verify_split_output(
        files=repaired,
        manifest_arch=["gfx1201"],
        source_files=source_files,
    )
    assert not any(v.rule == "launch_site_unresolved" for v in after.violations)
    assert not any(v.rule.startswith("source_device_kernel_") for v in after.violations)


def test_repair_rechecks_launches_after_source_device_bridge_replaces_fake_kernel():
    source_files = {
        "src/Device/includes/FixIntellisense.h": (
            "#pragma once\n"
            "#ifdef __KERNELCC__\n"
            "#define GLOBAL_KERNEL_SIGNATURE(returnType) extern \"C\" returnType __global__\n"
            "#else\n"
            "#define GLOBAL_KERNEL_SIGNATURE(returnType) returnType\n"
            "#endif\n"
        ),
        "src/Device/kernels/CameraRays.h": (
            "#pragma once\n"
            '#include "Device/includes/FixIntellisense.h"\n'
            "struct HIPRTRenderData { unsigned int random_number; };\n"
            "GLOBAL_KERNEL_SIGNATURE(void) __launch_bounds__(64) CameraRays(HIPRTRenderData render_data)\n"
            "{ render_data.random_number += 3u; }\n"
        ),
    }
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct AppState { int frame; };',
        "core.cpp": (
            'extern "C" void* core_on_load(void*, void*) { static AppState s; return &s; }\n'
            'extern "C" void core_on_update(void*, double) { '
            'synthi_gpu_launch(nullptr, "CameraRays", 1, 64, 0, nullptr, { &frame }); '
            'synthi_gpu_launch(nullptr, "my_function", 1, 64, 0, nullptr, { &frame }); }\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": (
            'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\n'
            'extern "C" void gui_on_render(void*) {}'
        ),
        "host_runner.cpp": "int main() { void* libgui = 0; auto gui_on_render = libgui; return 0; }",
        "device.hip": (
            'extern "C" __global__ void CameraRays(void* data) {}\n'
            'extern "C" __global__ void my_function(int* frame) { *frame += 1; }'
        ),
    }
    verification = verify_split_output(
        files=files,
        manifest_arch=["gfx1201"],
        source_files=source_files,
    )
    assert any(v.rule == "source_device_kernel_signature_not_preserved" for v in verification.violations)
    assert not any(v.rule == "launch_site_unresolved" for v in verification.violations)

    repaired, report = repair_split_artifacts(
        files=files,
        manifest=None,
        source_files=source_files,
        verification=verification,
    )

    assert "repair.source_device_include_bridge" in report["repairRules"]
    assert "repair.unresolved_generated_launches" in report["repairRules"]
    assert "my_function" not in repaired["core.cpp"]
    assert "CameraRays" in repaired["core.cpp"]
    after = verify_split_output(
        files=repaired,
        manifest_arch=["gfx1201"],
        source_files=source_files,
    )
    assert not any(v.rule == "launch_site_unresolved" for v in after.violations)
    assert not any(v.rule.startswith("source_device_kernel_") for v in after.violations)


def test_repair_materializes_missing_source_launch_when_core_has_owned_args():
    source_files = {
        "src/Device/includes/FixIntellisense.h": (
            "#pragma once\n"
            "#define GLOBAL_KERNEL_SIGNATURE(returnType) extern \"C\" returnType __global__\n"
        ),
        "src/Device/kernels/Shade.h": (
            '#include "Device/includes/FixIntellisense.h"\n'
            "struct LaunchArgs { unsigned int* pixels; int width; int height; };\n"
            "GLOBAL_KERNEL_SIGNATURE(void) Shade(LaunchArgs launch_args) { "
            "launch_args.pixels[0] = (unsigned int)launch_args.width; }\n"
        ),
        "src/render.cpp": (
            "void render(auto& kernel, LaunchArgs launch_args, void* stream, int width, int height) { "
            'kernel.set_kernel_function_name("Shade"); '
            "kernel.launch_asynchronous(8, 8, width, height, launch_args, stream); }\n"
        ),
    }
    files = {
        "shared.h": (
            '#include "synthi_gpu_runtime.h"\n'
            "struct LaunchArgs { unsigned int* pixels; int width; int height; };"
        ),
        "core.cpp": (
            'extern "C" void* core_on_load(void*, void*) { static LaunchArgs launch_args{}; return &launch_args; }\n'
            'extern "C" void core_on_update(void* state, double) { '
            "auto* launch_args_ptr = static_cast<LaunchArgs*>(state); "
            "LaunchArgs launch_args = *launch_args_ptr; "
            "void* stream = nullptr; int width = launch_args.width; int height = launch_args.height; }\n"
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": (
            'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\n'
            'extern "C" void gui_on_render(void*) {}'
        ),
        "host_runner.cpp": "int main() { void* libgui = 0; auto gui_on_render = libgui; return 0; }",
        "device.hip": '#include "src/Device/kernels/Shade.h"\n',
    }
    verification = verify_split_output(
        files=files,
        manifest_arch=["gfx1201"],
        source_files=source_files,
    )
    assert any(v.rule == "device_kernels_not_launched" for v in verification.violations)

    repaired, report = repair_split_artifacts(
        files=files,
        manifest=None,
        source_files=source_files,
        verification=verification,
    )

    assert report["repaired"] is True
    assert "repair.source_launch_sites" in report["repairRules"]
    assert (
        'synthi_gpu_launch(nullptr, "Shade", { width, height, 1 }, { 8, 8, 1 }, 0, stream, { &launch_args });'
        in repaired["core.cpp"]
    )
    after = verify_split_output(
        files=repaired,
        manifest_arch=["gfx1201"],
        source_files=source_files,
    )
    assert not any(v.rule == "device_kernels_not_launched" for v in after.violations)
    assert not any(v.rule == "source_launch_args_not_preserved" for v in after.violations)


def test_repair_does_not_invent_missing_source_launch_args():
    source_files = {
        "src/kernels.cu": 'extern "C" __global__ void Shade(int launch_args) {}\n',
        "src/render.cu": 'void render(){ Shade<<<1, 64>>>(launch_args); }\n',
    }
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct AppState { int frame; };',
        "core.cpp": (
            'extern "C" void* core_on_load(void*, void*) { static AppState s; return &s; }\n'
            'extern "C" void core_on_update(void*, double) { int frame = 0; (void)frame; }\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": (
            'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\n'
            'extern "C" void gui_on_render(void*) {}'
        ),
        "host_runner.cpp": "int main() { return 0; }",
        "device.cu": 'extern "C" __global__ void Shade(int launch_args) {}\n',
    }
    verification = verify_split_output(
        files=files,
        manifest_arch=["sm_80"],
        source_files=source_files,
    )
    assert any(v.rule == "device_kernels_not_launched" for v in verification.violations)

    repaired, report = repair_split_artifacts(
        files=files,
        manifest=None,
        source_files=source_files,
        verification=verification,
    )

    assert "repair.source_launch_sites" not in report["repairRules"]
    assert repaired["core.cpp"] == files["core.cpp"]
    missing = report["sourceLaunchSiteRepair"]["missing"]
    assert missing[0]["kernel"] == "Shade"
    assert missing[0]["requiredHostArgumentOwners"] == ["launch_args"]
    assert "launch_args" in missing[0]["missingExpressions"]
    assert "Shade<<<1, 64>>>(launch_args)" in missing[0]["sourceSnippet"]


def test_repair_does_not_treat_string_literal_as_launch_arg_owner():
    source_files = {
        "src/kernels.cu": 'extern "C" __global__ void Shade(int launch_args) {}\n',
        "src/render.cu": 'void render(){ Shade<<<1, 64>>>(launch_args); }\n',
    }
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct AppState { int frame; };',
        "core.cpp": (
            'extern "C" void* core_on_load(void*, void*) { static AppState s; return &s; }\n'
            'extern "C" void core_on_update(void*, double) { '
            'const char* diagnostic = "launch_args"; (void)diagnostic; }\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": (
            'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\n'
            'extern "C" void gui_on_render(void*) {}'
        ),
        "host_runner.cpp": "int main() { return 0; }",
        "device.cu": 'extern "C" __global__ void Shade(int launch_args) {}\n',
    }
    verification = verify_split_output(
        files=files,
        manifest_arch=["sm_80"],
        source_files=source_files,
    )
    assert any(v.rule == "device_kernels_not_launched" for v in verification.violations)

    repaired, report = repair_split_artifacts(
        files=files,
        manifest=None,
        source_files=source_files,
        verification=verification,
    )

    assert "repair.source_launch_sites" not in report["repairRules"]
    assert repaired["core.cpp"] == files["core.cpp"]


def test_repair_reports_missing_source_launch_after_bad_launch_removed():
    source_files = {
        "src/kernels.cu": 'extern "C" __global__ void Shade(int source_payload) {}\n',
        "src/render.cu": 'void render(){ Shade<<<1, 64>>>(source_payload); }\n',
    }
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct AppState { int frame; };',
        "core.cpp": (
            'extern "C" void* core_on_load(void*, void*) { static AppState s; return &s; }\n'
            'extern "C" void core_on_update(void*, double) { '
            'int generated_payload = 2; '
            'bool launched = synthi_gpu_launch(nullptr, "Shade", 1, 64, 0, 0, { &generated_payload }); '
            'if (launched) { generated_payload += 1; } }\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": (
            'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\n'
            'extern "C" void gui_on_render(void*) {}'
        ),
        "host_runner.cpp": "int main() { return 0; }",
        "device.cu": 'extern "C" __global__ void Shade(int source_payload) {}\n',
    }
    verification = SimpleNamespace(
        violations=[
            Violation(
                "source_launch_args_not_preserved",
                "generated launch does not preserve source argument owner",
                offending_symbol="Shade",
            ),
            Violation(
                "device_kernels_not_launched",
                "no source-reachable kernel launch remains after repair",
            ),
        ]
    )

    repaired, report = repair_split_artifacts(
        files=files,
        manifest=None,
        source_files=source_files,
        verification=verification,
    )

    assert "repair.source_launch_args" in report["repairRules"]
    assert "repair.source_launch_sites" not in report["repairRules"]
    assert "synthi_gpu_launch" not in repaired["core.cpp"]
    missing = report["sourceLaunchSiteRepair"]["missing"]
    assert missing[0]["kernel"] == "Shade"
    assert missing[0]["requiredHostArgumentOwners"] == ["source_payload"]
    assert "source_payload" in missing[0]["missingExpressions"]


def test_repair_rewrites_source_launch_args_when_owner_exists():
    source_files = {
        "src/kernels.cu": 'extern "C" __global__ void Shade(int source_payload) {}\n',
        "src/render.cpp": 'void render(){ Shade<<<1, 64>>>(source_payload); }\n',
    }
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct AppState { int frame; };',
        "core.cpp": (
            'extern "C" void* core_on_load(void*, void*) { static AppState s; return &s; }\n'
            'extern "C" void core_on_update(void*, double) { '
            'int source_payload = 1; int generated_payload = 2; '
            'synthi_gpu_launch(nullptr, "Shade", 1, 64, 0, 0, { &generated_payload }); }\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": (
            'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\n'
            'extern "C" void gui_on_render(void*) {}'
        ),
        "host_runner.cpp": "int main() { return 0; }",
        "device.cu": 'extern "C" __global__ void Shade(int source_payload) {}\n',
    }
    verification = verify_split_output(
        files=files,
        manifest_arch=["unit-test-arch"],
        source_files=source_files,
    )
    assert any(v.rule == "source_launch_args_not_preserved" for v in verification.violations)

    repaired, report = repair_split_artifacts(
        files=files,
        manifest=None,
        source_files=source_files,
        verification=verification,
    )

    assert "repair.source_launch_args" in report["repairRules"]
    assert '{ &source_payload }' in repaired["core.cpp"]
    assert '{ &generated_payload }' not in repaired["core.cpp"]
    after = verify_split_output(
        files=repaired,
        manifest_arch=["unit-test-arch"],
        source_files=source_files,
    )
    assert not any(v.rule == "source_launch_args_not_preserved" for v in after.violations)


def test_repair_removes_source_launch_when_owner_missing():
    source_files = {
        "src/kernels.cu": 'extern "C" __global__ void Shade(int source_payload) {}\n',
        "src/render.cpp": 'void render(){ Shade<<<1, 64>>>(source_payload); }\n',
    }
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct AppState { int frame; };',
        "core.cpp": (
            'extern "C" void* core_on_load(void*, void*) { static AppState s; return &s; }\n'
            'extern "C" void core_on_update(void*, double) { '
            'int generated_payload = 2; '
            'bool launched = synthi_gpu_launch(nullptr, "Shade", 1, 64, 0, 0, { &generated_payload }); '
            'if (launched) { generated_payload += 1; } }\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": (
            'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\n'
            'extern "C" void gui_on_render(void*) {}'
        ),
        "host_runner.cpp": "int main() { return 0; }",
        "device.cu": 'extern "C" __global__ void Shade(int source_payload) {}\n',
    }
    verification = verify_split_output(
        files=files,
        manifest_arch=["unit-test-arch"],
        source_files=source_files,
    )
    assert any(v.rule == "source_launch_args_not_preserved" for v in verification.violations)

    repaired, report = repair_split_artifacts(
        files=files,
        manifest=None,
        source_files=source_files,
        verification=verification,
    )

    assert "repair.source_launch_args" in report["repairRules"]
    assert "source_payload" not in repaired["core.cpp"]
    assert "synthi_gpu_launch" not in repaired["core.cpp"]
    assert "if (launched)" not in repaired["core.cpp"]
    after = verify_split_output(
        files=repaired,
        manifest_arch=["unit-test-arch"],
        source_files=source_files,
    )
    assert not any(v.rule == "source_launch_args_not_preserved" for v in after.violations)


def test_repair_removes_guard_block_for_unresolved_launch_assignment():
    source_files = {
        "src/Device/includes/FixIntellisense.h": (
            "#pragma once\n"
            "#define GLOBAL_KERNEL_SIGNATURE(returnType) extern \"C\" returnType __global__\n"
        ),
        "src/Device/kernels/CameraRays.h": (
            '#include "Device/includes/FixIntellisense.h"\n'
            "GLOBAL_KERNEL_SIGNATURE(void) CameraRays(int* frame) { *frame += 1; }\n"
        ),
    }
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct AppState { int frame; };',
        "core.cpp": (
            'extern "C" void* core_on_load(void*, void*) { static AppState s; return &s; }\n'
            'extern "C" void core_on_update(void*, double) { '
            'bool initialized = synthi_gpu_launch(nullptr, "my_function", 1, 64, 0, nullptr, { &frame }); '
            "if (initialized) { ++frame; } "
            'synthi_gpu_launch(nullptr, "CameraRays", 1, 64, 0, nullptr, { &frame }); }\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": (
            'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\n'
            'extern "C" void gui_on_render(void*) {}'
        ),
        "host_runner.cpp": "int main() { void* libgui = 0; auto gui_on_render = libgui; return 0; }",
        "device.hip": (
            'extern "C" __global__ void CameraRays(void* data) {}\n'
            'extern "C" __global__ void my_function(int* frame) { *frame += 1; }'
        ),
    }
    verification = verify_split_output(
        files=files,
        manifest_arch=["gfx1201"],
        source_files=source_files,
    )
    assert any(v.rule == "source_device_kernel_signature_not_preserved" for v in verification.violations)

    repaired, report = repair_split_artifacts(
        files=files,
        manifest=None,
        source_files=source_files,
        verification=verification,
    )

    assert "repair.unresolved_generated_launches" in report["repairRules"]
    assert "my_function" not in repaired["core.cpp"]
    assert "initialized" not in repaired["core.cpp"]
    assert "CameraRays" in repaired["core.cpp"]
    after = verify_split_output(
        files=repaired,
        manifest_arch=["gfx1201"],
        source_files=source_files,
    )
    assert not any(v.rule == "constant_false_launch_guard" for v in after.violations)


def test_repair_shrinks_literal_launch_block_to_declared_launch_bound():
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct AppState { int frame; };',
        "core.cpp": (
            'extern "C" void* core_on_load(void*, void*) { static AppState s; return &s; }\n'
            'extern "C" void core_on_update(void*, double) { '
            'synthi_gpu_launch(nullptr, "step", 1, 256, 0, nullptr, { &frame }); }\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": (
            'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\n'
            'extern "C" void gui_on_render(void*) {}'
        ),
        "host_runner.cpp": "int main() { void* libgui = 0; auto gui_on_render = libgui; return 0; }",
        "device.hip": 'extern "C" __global__ __launch_bounds__(64) void step(int* frame) { *frame += 1; }',
    }
    verification = verify_split_output(
        files=files,
        manifest_arch=["gfx1201"],
        source_files={},
    )
    assert any(v.rule == "kernel_launch_bounds_exceeded" for v in verification.violations)

    repaired, report = repair_split_artifacts(
        files=files,
        manifest=None,
        source_files={},
        verification=verification,
    )

    assert "repair.launch_bounds" in report["repairRules"]
    assert 'synthi_gpu_launch(nullptr, "step", 1, 64,' in repaired["core.cpp"]
    after = verify_split_output(
        files=repaired,
        manifest_arch=["gfx1201"],
        source_files={},
    )
    assert not any(v.rule == "kernel_launch_bounds_exceeded" for v in after.violations)


def test_repair_preserves_dimensional_shape_for_launch_bound_block():
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct AppState { int frame; };',
        "core.cpp": (
            'extern "C" void* core_on_load(void*, void*) { static AppState s; return &s; }\n'
            'extern "C" void core_on_update(void*, double) { '
            "Dim3 block(16, 16, 1); "
            'synthi_gpu_launch(nullptr, "tile", 1, block, 0, nullptr, { &frame }); }\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": (
            'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\n'
            'extern "C" void gui_on_render(void*) {}'
        ),
        "host_runner.cpp": "int main() { void* libgui = 0; auto gui_on_render = libgui; return 0; }",
        "device.hip": 'GLOBAL_KERNEL_SIGNATURE(void) __launch_bounds__(64) tile(int* frame) { *frame += 1; }',
    }
    verification = verify_split_output(
        files=files,
        manifest_arch=["gfx1201"],
        source_files={},
    )
    assert any(v.rule == "kernel_launch_bounds_exceeded" for v in verification.violations)

    repaired, report = repair_split_artifacts(
        files=files,
        manifest=None,
        source_files={},
        verification=verification,
    )

    assert "repair.launch_bounds" in report["repairRules"]
    assert 'synthi_gpu_launch(nullptr, "tile", 1, Dim3(8, 8, 1),' in repaired["core.cpp"]
    after = verify_split_output(
        files=repaired,
        manifest_arch=["gfx1201"],
        source_files={},
    )
    assert not any(v.rule == "kernel_launch_bounds_exceeded" for v in after.violations)


def test_repair_shrinks_braced_launch_block_to_declared_launch_bound():
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct AppState { int frame; };',
        "core.cpp": (
            'extern "C" void* core_on_load(void*, void*) { static AppState s; return &s; }\n'
            'extern "C" void core_on_update(void*, double) { '
            'synthi_gpu_launch(nullptr, "tile", {4, 4, 1}, {16, 16, 1}, 0, nullptr, { &frame }); }\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": (
            'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\n'
            'extern "C" void gui_on_render(void*) {}'
        ),
        "host_runner.cpp": "int main() { void* libgui = 0; auto gui_on_render = libgui; return 0; }",
        "device.hip": 'GLOBAL_KERNEL_SIGNATURE(void) __launch_bounds__(64) tile(int* frame) { *frame += 1; }',
    }
    verification = verify_split_output(
        files=files,
        manifest_arch=["gfx1201"],
        source_files={},
    )
    assert any(v.rule == "kernel_launch_bounds_exceeded" for v in verification.violations)

    repaired, report = repair_split_artifacts(
        files=files,
        manifest=None,
        source_files={},
        verification=verification,
    )

    assert "repair.launch_bounds" in report["repairRules"]
    assert 'synthi_gpu_launch(nullptr, "tile", {4, 4, 1}, {8, 8, 1},' in repaired["core.cpp"]
    after = verify_split_output(
        files=repaired,
        manifest_arch=["gfx1201"],
        source_files={},
    )
    assert not any(v.rule == "kernel_launch_bounds_exceeded" for v in after.violations)


def test_repair_replaces_placeholder_host_runner_with_real_gui_routing():
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct AppState { int frame; };',
        "core.cpp": (
            'extern "C" void* core_on_load(void*, void*) { static AppState s; return &s; }\n'
            'extern "C" void core_on_update(void*, double) {}\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": (
            'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\n'
            'extern "C" void gui_on_render(void*) {}'
        ),
        "host_runner.cpp": "int main() { void* libgui = 0; auto gui_on_render = libgui; return 0; }",
        "device.hip": 'extern "C" __global__ void noop() {}',
    }
    verification = verify_split_output(files=files, manifest_arch=["gfx1201"])
    assert any(v.rule == "host_runner_omits_gui_module" for v in verification.violations)

    repaired, report = repair_split_artifacts(
        files=files,
        manifest=None,
        source_files={},
        verification=verification,
    )

    assert report["repaired"] is True
    assert "repair.host_runner_gui_routing" in report["repairRules"]
    assert 'dlsym(libgui, "gui_on_render")' in repaired["host_runner.cpp"]
    assert "gui_render(core_state);" in repaired["host_runner.cpp"]
    after = verify_split_output(files=repaired, manifest_arch=["gfx1201"])
    assert not any(v.rule == "host_runner_omits_gui_module" for v in after.violations)


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


def test_repair_init_kernel_keeps_state_field_count_expression():
    files = {
        "shared.h": (
            '#include "synthi_gpu_runtime.h"\n'
            "struct AppState { float* dx; float* dy; float* dvx; unsigned int* drgba; int count; };"
        ),
        "core.cpp": (
            '#include <hip/hip_runtime.h>\n'
            'extern "C" void* core_on_load(void*, void*) { '
            'static AppState state; AppState* s = &state; '
            'hipMalloc(&s->dx, 4096); hipMalloc(&s->dy, 4096); '
            'hipMalloc(&s->dvx, 4096); hipMalloc(&s->drgba, 4096); return s; }\n'
            'extern "C" void core_on_update(void* state, double) { '
            "auto* s = static_cast<AppState*>(state); "
            'synthi_gpu_launch(nullptr, "init_particles", 4, 256, 0, nullptr, { &s }); '
            'synthi_gpu_launch(nullptr, "advance_particles", 4, 256, 0, nullptr, '
            '{ &s->dx, &s->dy, &s->dvx, &s->drgba, &s->count }); }\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": 'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) {}',
        "host_runner.cpp": "int main() { void* libgui = 0; auto gui_on_render = libgui; return 0; }",
        "device.hip": (
            'extern "C" __global__ void init_particles(AppState* s) { '
            'int i = blockIdx.x * blockDim.x + threadIdx.x; if (i < s->count) { s->dx[i] = 0.0f; } }\n'
            'extern "C" __global__ void advance_particles(float* dx, float* dy, float* dvx, unsigned int* drgba, int count) { '
            'int i = blockIdx.x * blockDim.x + threadIdx.x; if (i < count) { dx[i] += dvx[i]; drgba[i] = 0u; } }'
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
    assert "if (synthi_hmr_i < s->count)" in repaired["device.hip"]
    assert "if (synthi_hmr_i < s)" not in repaired["device.hip"]
    after = verify_split_output(files=repaired, manifest_arch=["gfx1201"])
    assert not any(v.rule == "device_init_kernel_incomplete" for v in after.violations)


def test_repair_inserts_missing_one_time_init_kernel_before_update():
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct Params { float dt; };',
        "core.cpp": (
            '#include <hip/hip_runtime.h>\n'
            'extern "C" void* core_on_load(void*, void*) { '
            'hipMalloc(&s.dx, 4096); hipMalloc(&s.dy, 4096); '
            'hipMalloc(&s.dvx, 4096); hipMalloc(&s.drgba, 4096); return &s; }\n'
            'extern "C" void core_on_update(void*, double) { '
            'bool ok = synthi_gpu_launch(nullptr, "advance_particle_field", 4, 256, 0, nullptr, '
            '{ &s.dx, &s.dy, &s.dvx, &s.drgba, &s.count, &s.params }); if (ok) {} }\n'
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": 'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) {}',
        "host_runner.cpp": "int main() { void* libgui = 0; auto gui_on_render = libgui; return 0; }",
        "device.hip": (
            'extern "C" __global__ void advance_particle_field('
            'float* dx, float* dy, float* dvx, unsigned int* drgba, int count, Params params) { '
            'int i = blockIdx.x * blockDim.x + threadIdx.x; '
            'if (i < count) { dx[i] += dvx[i] * params.dt; drgba[i] = 0u; } }'
        ),
    }
    verification = verify_split_output(files=files, manifest_arch=["gfx1201"])
    assert any(v.rule == "device_buffers_not_initialized" for v in verification.violations)

    repaired, report = repair_split_artifacts(
        files=files,
        manifest=None,
        source_files={},
        verification=verification,
    )

    assert report["repaired"] is True
    assert "repair.init_kernel_buffers" in report["repairRules"]
    assert "synthi_hmr_device_initialized" in repaired["core.cpp"]
    assert "synthi_hmr_init_buffers" in repaired["core.cpp"]
    assert 'extern "C" __global__ void synthi_hmr_init_buffers' in repaired["device.hip"]
    assert "dvx[synthi_hmr_i] = 0.0f" in repaired["device.hip"]
    assert "drgba[synthi_hmr_i] = 0u" in repaired["device.hip"]
    after = verify_split_output(files=repaired, manifest_arch=["gfx1201"])
    rules = {v.rule for v in after.violations}
    assert "device_buffers_not_initialized" not in rules
    assert "device_init_kernel_incomplete" not in rules


def test_repair_init_kernel_uses_source_included_device_signatures():
    source_files = {
        "src/kernels/CopyValues.h": (
            'extern "C" __global__ void copy_values(const float* values, float* output, int n) { '
            'int i = blockIdx.x * blockDim.x + threadIdx.x; if (i < n) output[i] = values[i]; }'
        )
    }
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
        "device.hip": '#include "src/kernels/CopyValues.h"\n',
    }
    verification = verify_split_output(
        files=files,
        manifest_arch=["gfx1201"],
        source_files=source_files,
    )
    assert any(v.rule == "device_buffers_not_initialized" for v in verification.violations)

    repaired, report = repair_split_artifacts(
        files=files,
        manifest=None,
        source_files=source_files,
        verification=verification,
    )

    assert report["repaired"] is True
    assert "repair.init_kernel_buffers" in report["repairRules"]
    assert '#include "src/kernels/CopyValues.h"' in repaired["device.hip"]
    assert 'extern "C" __global__ void synthi_hmr_init_buffers' in repaired["device.hip"]
    assert "synthi_hmr_device_initialized" in repaired["core.cpp"]
    after = verify_split_output(
        files=repaired,
        manifest_arch=["gfx1201"],
        source_files=source_files,
    )
    assert not any(v.rule == "device_buffers_not_initialized" for v in after.violations)


def test_repair_recomposes_aggregate_launch_param_from_flat_host_args():
    files = {
        "shared.h": (
            '#include "synthi_gpu_runtime.h"\n'
            "struct LaunchParams { float dt; float center_x; float center_y; float bounds_x; float bounds_y; };\n"
            "struct AppState {\n"
            "  float* dx;\n"
            "  float* dy;\n"
            "  float* dvx;\n"
            "  float* dvy;\n"
            "  unsigned int* drgba;\n"
            "  int count;\n"
            "  float dt;\n"
            "  float center_x;\n"
            "  float center_y;\n"
            "  float bounds_x;\n"
            "  float bounds_y;\n"
            "};"
        ),
        "core.cpp": (
            'extern "C" void* core_on_load(void*, void*) { static AppState s; return &s; }\n'
            'extern "C" void core_on_update(void* state, double) { '
            "auto* s = static_cast<AppState*>(state); "
            'synthi_gpu_launch(nullptr, "advance_particle_field", 4, 256, 0, nullptr, '
            "{ &s->dx, &s->dy, &s->dvx, &s->dvy, &s->drgba, &s->count, &s->dt, &s->center_x, &s->center_y, &s->bounds_x, &s->bounds_y }); }\n"
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": 'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) {}',
        "host_runner.cpp": "int main() { void* libgui = 0; auto gui_on_render = libgui; return 0; }",
        "device.hip": (
            'extern "C" __global__ void advance_particle_field('
            "float* dx, float* dy, float* dvx, float* dvy, unsigned int* drgba, int count, LaunchParams params) { "
            "int i = blockIdx.x * blockDim.x + threadIdx.x; "
            "if (i < count) { dx[i] += dvx[i] * params.dt; dy[i] += dvy[i] * params.dt; drgba[i] = 0xff00ff00u; } }"
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
    assert "LaunchParams synthi_hmr_launch_params_1" in repaired["core.cpp"]
    assert "{ &s->dx, &s->dy, &s->dvx, &s->dvy, &s->drgba, &s->count, &synthi_hmr_launch_params_1 }" in repaired["core.cpp"]
    assert "float center_x" not in repaired["device.hip"]
    after = verify_split_output(files=repaired, manifest_arch=["gfx1201"])
    assert not any(v.rule == "kernel_launch_abi_mismatch" for v in after.violations)


def test_repair_truncates_extra_args_for_single_aggregate_kernel_param():
    files = {
        "shared.h": (
            '#include "synthi_gpu_runtime.h"\n'
            "struct RenderData { float* pixels; int width; int height; unsigned int frame; };"
        ),
        "core.cpp": (
            'extern "C" void* core_on_load(void*, void*) { static RenderData render_data; return &render_data; }\n'
            'extern "C" void core_on_update(void* state, double) { RenderData render_data = *(RenderData*)state; '
            'synthi_gpu_launch(nullptr, "MegaKernel", 4, 256, 0, nullptr, '
            "{ &render_data, &render_data.width, &render_data.height, &render_data.frame }); }\n"
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": 'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) {}',
        "host_runner.cpp": "int main() { void* libgui = 0; auto gui_on_render = libgui; return 0; }",
        "device.hip": (
            'extern "C" __global__ void MegaKernel(RenderData render_data) { '
            'render_data.pixels[threadIdx.x] = 1.0f; }'
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
    assert "{ &render_data }" in repaired["core.cpp"]
    assert "&render_data.width" not in repaired["core.cpp"]
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


def test_repair_inserts_shared_bytes_for_legacy_launch_boundary():
    files = {
        "shared.h": '#include "synthi_gpu_runtime.h"\nstruct AppState { float* dx; int count; };',
        "core.cpp": (
            'extern "C" void* core_on_load(void*, void*) { static AppState s; return &s; }\n'
            'extern "C" void core_on_update(void* state, double) { '
            "auto* s = static_cast<AppState*>(state); "
            'synthi_gpu_launch(nullptr, "step", 1, 64, nullptr, { &s->dx, &s->count }); }\n'
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
    assert any(v.rule == "invalid_synthi_launch_signature" for v in verification.violations)

    repaired, report = repair_split_artifacts(
        files=files,
        manifest=None,
        source_files={},
        verification=verification,
    )

    assert report["repaired"] is True
    assert "repair.launch_boundary_arity" in report["repairRules"]
    assert 'synthi_gpu_launch(nullptr, "step", 1, 64, 0, nullptr, { &s->dx, &s->count })' in repaired["core.cpp"]
    after = verify_split_output(files=repaired, manifest_arch=["gfx1201"])
    assert not any(v.rule == "invalid_synthi_launch_signature" for v in after.violations)


def test_repair_materializes_inline_launch_initializer_argument():
    files = {
        "shared.h": (
            '#include "synthi_gpu_runtime.h"\n'
            "struct LaunchParams { float dt; float center_x; float center_y; };\n"
            "struct AppState { float* dx; int count; float dt; float center_x; float center_y; };"
        ),
        "core.cpp": (
            'extern "C" void* core_on_load(void*, void*) { static AppState s; return &s; }\n'
            'extern "C" void core_on_update(void* state, double) { '
            "auto* s = static_cast<AppState*>(state); "
            'synthi_gpu_launch(nullptr, "step", 1, 64, 0, nullptr, '
            "{ &s->dx, &s->count, LaunchParams{ s->dt, s->center_x, s->center_y } }); }\n"
            'extern "C" const DeviceDescriptor* device_descriptor() { return 0; }\n'
            'extern "C" void device_on_load(const unsigned char*, size_t) {}\n'
            'extern "C" unsigned long long device_kernel_sig_hash(const char*) { return 1; }'
        ),
        "gui.cpp": 'extern "C" void* gui_on_load(void*, void*, void*) { return 0; }\nextern "C" void gui_on_render(void*) {}',
        "host_runner.cpp": "int main() { void* libgui = 0; auto gui_on_render = libgui; return 0; }",
        "device.hip": (
            'extern "C" __global__ void step(float* dx, int count, LaunchParams params) { '
            "int i = blockIdx.x * blockDim.x + threadIdx.x; if (i < count) dx[i] += params.dt; }"
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
    assert "auto synthi_hmr_launch_arg_1 = LaunchParams{ s->dt, s->center_x, s->center_y };" in repaired["core.cpp"]
    assert "{ &s->dx, &s->count, &synthi_hmr_launch_arg_1 }" in repaired["core.cpp"]
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

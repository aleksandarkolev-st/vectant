from agents.gpu_source_context import build_project_source_context, stable_hash


def test_source_context_records_included_and_dropped_reasons():
    files = {
        "src/app/main.cpp": "int main(){ launch<<<1,1>>>(); }",
        "src/gpu/flow.hip": "__global__ void launch() {}",
        "src/render/glfw_view.cpp": "#include <GLFW/glfw3.h>\nvoid draw(){}",
        "docs/readme.md": "notes",
        ".synthi/generated/gpu/device.hip": "__global__ void generated() {}",
    }

    prompt, report = build_project_source_context(files, focus="src/app/main.cpp")

    included_reasons = {item["path"]: item["includeReason"] for item in report["included"]}
    dropped_reasons = {item["path"]: item["dropReason"] for item in report["dropped"]}

    assert included_reasons["src/app/main.cpp"] == "entry_translation_unit"
    assert included_reasons["src/gpu/flow.hip"] == "device_translation_unit"
    assert included_reasons["src/render/glfw_view.cpp"] == "render_backend"
    assert dropped_reasons["docs/readme.md"] == "docs_tests_examples"
    assert dropped_reasons[".synthi/generated/gpu/device.hip"] == "generated_or_build_output"
    assert "INCLUDE_REASON: device_translation_unit" in prompt
    assert report["deterministicContextComplete"] is True


def test_source_context_treats_macro_wrapped_runtime_kernels_as_gpu_context():
    files = {
        "CMakeLists.txt": """
        find_package(OpenGL REQUIRED)
        add_executable(HIPRTPathTracer src/main.cpp src/Device/GPUKernel.cpp src/Device/kernels/CameraRays.h)
        target_link_libraries(HIPRTPathTracer PRIVATE glfw GLEW::GLEW OpenGL::GL)
        """,
        "src/main.cpp": """
        #include <GLFW/glfw3.h>
        #include <imgui.h>
        int main(){ glfwInit(); ImGui::CreateContext(); return 0; }
        """,
        "src/Device/GPUKernel.cpp": """
        void GPUKernel::launch(void* fn, void** args) {
          oroModuleLaunchKernel(fn, 1, 1, 1, 64, 1, 1, 0, stream, args, nullptr);
        }
        """,
        "src/Device/kernels/CameraRays.h": """
        GLOBAL_KERNEL_SIGNATURE(void) __launch_bounds__(64)
        CameraRays(HIPRTRenderData render_data) {
          const int x = threadIdx.x + blockIdx.x * blockDim.x;
          render_data.accum[x] = make_float4(0.25f);
        }
        """,
    }

    prompt, report = build_project_source_context(files, focus="src/main.cpp")
    included_reasons = {item["path"]: item["includeReason"] for item in report["included"]}

    assert included_reasons["src/Device/GPUKernel.cpp"] == "kernel_declaration"
    assert included_reasons["src/Device/kernels/CameraRays.h"] == "kernel_declaration"
    assert "GLOBAL_KERNEL_SIGNATURE" in prompt
    assert "oroModuleLaunchKernel" in prompt
    assert "glfw_opengl" in report["graphicsBackend"]["detected"]
    assert "imgui_glfw" in report["graphicsBackend"]["detected"]


def test_source_context_does_not_let_large_raw_metadata_evict_kernel_headers():
    files = {
        "CMakeLists.txt": "add_executable(HIPRTPathTracer src/main.cpp src/Device/kernels/CameraRays.h)",
        "src/main.cpp": "int main(){ return 0; }",
        "src/Device/kernels/CameraRays.h": """
        GLOBAL_KERNEL_SIGNATURE(void) __launch_bounds__(64)
        CameraRays(HIPRTRenderData render_data) {
          render_data.random_number += 1;
        }
        """,
        "compile_commands.json": "[" + (" " * 6000) + "]",
        ".cmake/api/v1/reply/codemodel-v2-release.json": """
        {
          "kind": "codemodel",
          "configurations": [
            {
              "name": "Release",
              "targets": [
                {"name": "HIPRTPathTracer", "id": "HIPRTPathTracer::@real", "jsonFile": "target-HIPRTPathTracer-Release.json"}
              ]
            }
          ]
        }
        """,
        ".cmake/api/v1/reply/target-HIPRTPathTracer-Release.json": """
        {
          "name": "HIPRTPathTracer",
          "id": "HIPRTPathTracer::@real",
          "type": "EXECUTABLE",
          "sources": [
            {"path": "src/main.cpp"},
            {"path": "src/Device/kernels/CameraRays.h"}
          ]
        }
        """,
        ".cmake/api/v1/reply/target-large-helper-Release.json": "{" + '"padding":"' + ("x" * 12000) + '"}',
    }

    prompt, report = build_project_source_context(
        files,
        focus="src/main.cpp",
        max_chars=9000,
        per_file_max_chars=4000,
    )
    included_paths = {item["path"] for item in report["included"]}
    dropped = {item["path"]: item.get("dropReason") for item in report["dropped"]}

    assert "src/Device/kernels/CameraRays.h" in included_paths
    assert "GLOBAL_KERNEL_SIGNATURE" in prompt
    assert dropped["compile_commands.json"] == "prompt_budget_exclusion"
    included_order = [item["path"] for item in report["included"]]
    if ".cmake/api/v1/reply/target-large-helper-Release.json" in included_order:
        assert included_order.index("src/Device/kernels/CameraRays.h") < included_order.index(
            ".cmake/api/v1/reply/target-large-helper-Release.json"
        )
    assert report["deterministicContextComplete"] is True


def test_source_context_does_not_promote_commented_kernel_examples():
    files = {
        "src/main.cpp": "int main(){ return 0; }",
        "src/Device/includes/FixIntellisense.h": """
        // extern "C" void __global__ my_function(...)
        /* GLOBAL_KERNEL_SIGNATURE(void) FakeKernel(RenderData data) {} */
        """,
    }

    _prompt, report = build_project_source_context(files, focus="src/main.cpp")
    reasons = {item["path"]: item["includeReason"] for item in report["included"]}
    device_tus = {item["path"] for item in report["deviceTuTopology"]["deviceTranslationUnits"]}

    assert reasons["src/Device/includes/FixIntellisense.h"] != "kernel_declaration"
    assert "src/Device/includes/FixIntellisense.h" not in device_tus


def test_source_context_selects_compile_command_for_focus():
    files = {
        "src/app/main.cpp": "int main(){ return 0; }",
        "compile_commands.json": """
        [
          {
            "directory": "/repo/build",
            "file": "/repo/src/app/main.cpp",
            "arguments": ["clang++", "-Iinclude", "-DUSE_GPU=1", "-c", "src/app/main.cpp"]
          }
        ]
        """,
    }

    _prompt, report = build_project_source_context(files, focus="src/app/main.cpp")
    selected = report["buildMetadata"]["selectedCompileCommand"]

    assert report["buildMetadata"]["compileCommandsStatus"] == "selected"
    assert report["buildMetadata"]["compileDbHash"]
    assert selected["status"] == "selected"
    assert selected["compiler"] == "clang++"
    assert selected["file"].endswith("src/app/main.cpp")
    assert selected["effectiveFlagsHash"]


def test_source_context_marks_critical_budget_drop():
    files = {
        "src/app/main.cpp": "int main(){ return 0; }",
        "src/gpu/flow.hip": "__global__ void flow() { int x = 1; }",
    }

    _prompt, report = build_project_source_context(
        files,
        focus="src/app/main.cpp",
        max_chars=80,
        per_file_max_chars=1000,
    )

    assert report["deterministicContextComplete"] is False
    assert report["criticalDropped"]
    assert report["criticalDropped"][0]["dropReason"] == "prompt_budget_exclusion"


def test_source_context_reports_multi_device_tu_topology():
    files = {
        "src/app/main.cpp": "int main(){ return 0; }",
        "src/gpu/a.hip": "__global__ void a() {}",
        "src/gpu/b.hip": "__device__ int b(){ return 1; }",
    }

    _prompt, report = build_project_source_context(files, focus="src/app/main.cpp")
    topology = report["deviceTuTopology"]

    assert topology["multiDeviceTu"] is True
    assert topology["deviceTranslationUnitCount"] == 2
    assert topology["supportStatus"] == "multi_device_tu_requires_topology_verification"
    assert "multi_device_tu_requires_topology_verification" in topology["reasonCodes"]


def test_source_context_resolves_cmake_file_api_target_for_focus():
    files = {
        "CMakeLists.txt": "add_executable(gpu_app src/app/main.cpp src/gpu/flow.hip)",
        "src/app/main.cpp": "int main(){ return 0; }",
        "src/gpu/flow.hip": "__global__ void flow() {}",
        ".cmake/api/v1/reply/codemodel-v2-debug.json": """
        {
          "kind": "codemodel",
          "configurations": [
            {
              "name": "Debug",
              "targets": [
                {"name": "gpu_app", "id": "gpu_app::@123", "jsonFile": "target-gpu_app-Debug.json"},
                {"name": "helper_lib", "id": "helper::@123", "jsonFile": "target-helper-Debug.json"}
              ]
            }
          ]
        }
        """,
        ".cmake/api/v1/reply/target-gpu_app-Debug.json": """
        {
          "name": "gpu_app",
          "id": "gpu_app::@123",
          "type": "EXECUTABLE",
          "sources": [
            {"path": "src/app/main.cpp"},
            {"path": "src/gpu/flow.hip"}
          ]
        }
        """,
        ".cmake/api/v1/reply/target-helper-Debug.json": """
        {
          "name": "helper_lib",
          "id": "helper::@123",
          "type": "STATIC_LIBRARY",
          "sources": [
            {"path": "src/lib/helper.cpp"}
          ]
        }
        """,
    }

    prompt, report = build_project_source_context(files, focus="src/app/main.cpp")
    metadata = report["buildMetadata"]
    cmake = metadata["cmakeFileApi"]
    resolution = metadata["targetResolution"]

    assert metadata["cmakeFileApiStatus"] == "available"
    assert metadata["cmakeCodemodelHash"]
    assert cmake["targetCount"] == 2
    assert resolution["status"] == "selected"
    assert resolution["method"] == "single_executable_target_containing_focus"
    assert resolution["selectedTarget"]["name"] == "gpu_app"
    assert resolution["selectedTarget"]["sourceFiles"] == [
        "src/app/main.cpp",
        "src/gpu/flow.hip",
    ]
    assert "Resolved CMake target: gpu_app" in prompt


def test_source_context_reports_ambiguous_cmake_file_api_target():
    files = {
        "CMakeLists.txt": "add_executable(a src/app/main.cpp)\nadd_executable(b src/app/main.cpp)",
        "src/app/main.cpp": "int main(){ return 0; }",
        ".cmake/api/v1/reply/codemodel-v2-debug.json": """
        {
          "kind": "codemodel",
          "configurations": [
            {
              "name": "Debug",
              "targets": [
                {"name": "gpu_app_a", "id": "a::@123", "jsonFile": "target-a-Debug.json"},
                {"name": "gpu_app_b", "id": "b::@123", "jsonFile": "target-b-Debug.json"}
              ]
            }
          ]
        }
        """,
        ".cmake/api/v1/reply/target-a-Debug.json": """
        {"name": "gpu_app_a", "id": "a::@123", "type": "EXECUTABLE", "sources": [{"path": "src/app/main.cpp"}]}
        """,
        ".cmake/api/v1/reply/target-b-Debug.json": """
        {"name": "gpu_app_b", "id": "b::@123", "type": "EXECUTABLE", "sources": [{"path": "src/app/main.cpp"}]}
        """,
    }

    prompt, report = build_project_source_context(files, focus="src/app/main.cpp")
    resolution = report["buildMetadata"]["targetResolution"]

    assert resolution["status"] == "ambiguous"
    assert resolution["method"] == "ambiguous_executable_targets_containing_focus"
    assert "target_resolution_ambiguous" in resolution["reasonCodes"]
    assert "CMake target resolution is ambiguous" in prompt


def test_source_context_detects_framework_backends_without_forcing_link_hints():
    files = {
        "src/app/main.cpp": """
        #include <raylib.h>
        #include <SFML/Graphics.hpp>
        #include "imgui.h"
        #include <SDL2/SDL.h>
        int main(){ InitWindow(800, 600, "x"); ImGui::NewFrame(); return 0; }
        """,
        "src/gpu/flow.hip": "__global__ void flow() {}",
    }

    prompt, report = build_project_source_context(files, focus="src/app/main.cpp")
    backend = report["graphicsBackend"]

    assert backend["schemaVersion"] == "synthi.gpu.graphics_backend.v1"
    assert "raylib" in backend["detected"]
    assert "sfml" in backend["detected"]
    assert "imgui" in backend["detected"]
    assert "imgui_sdl2" in backend["detected"]
    assert backend["supportStatus"] == "candidate"
    assert "unsupported.graphics_backend_vulkan" not in backend["reasonCodes"]
    assert "Graphics backend:" in prompt


def test_source_context_reports_vulkan_as_explicit_unsupported_fallback():
    files = {
        "CMakeLists.txt": """
        find_package(Vulkan REQUIRED)
        add_executable(vk_app src/app/main.cpp src/gpu/flow.hip)
        target_link_libraries(vk_app PRIVATE Vulkan::Vulkan)
        """,
        "src/app/main.cpp": """
        #include <vulkan/vulkan.h>
        int main(){ VkInstance instance = VK_NULL_HANDLE; return instance == VK_NULL_HANDLE ? 0 : 1; }
        """,
        "src/gpu/flow.hip": "__global__ void flow() {}",
    }

    prompt, report = build_project_source_context(files, focus="src/app/main.cpp")
    backend = report["graphicsBackend"]

    assert backend["primary"] == "vulkan"
    assert backend["supportStatus"] == "unsupported"
    assert "unsupported.graphics_backend_vulkan" in backend["reasonCodes"]
    assert "unsupported_project_shape" in backend["reasonCodes"]
    assert "do not claim hot reload support" in prompt


def test_graphics_backend_detection_is_scoped_to_selected_cmake_target():
    files = {
        "CMakeLists.txt": """
        add_subdirectory(HIP-Basic/saxpy)
        add_subdirectory(HIP-Basic/vulkan_interop)
        """,
        "HIP-Basic/saxpy/main.hip": """
        #include <hip/hip_runtime.h>
        __global__ void saxpy_kernel(float* y, const float* x) { y[threadIdx.x] = x[threadIdx.x]; }
        int main(){ return 0; }
        """,
        "HIP-Basic/vulkan_interop/main.hip": """
        #include <vulkan/vulkan.h>
        int main(){ VkInstance instance = VK_NULL_HANDLE; return instance == VK_NULL_HANDLE ? 0 : 1; }
        """,
        "compile_commands.json": """
        [
          {
            "directory": "/repo/HIP-Basic/saxpy/build",
            "file": "/repo/HIP-Basic/saxpy/main.hip",
            "arguments": ["hipcc", "--offload-arch=gfx1201", "-c", "/repo/HIP-Basic/saxpy/main.hip"]
          }
        ]
        """,
        ".cmake/api/v1/reply/codemodel-v2-release.json": """
        {
          "kind": "codemodel",
          "configurations": [
            {
              "name": "Release",
              "targets": [
                {"name": "hip_saxpy", "id": "hip_saxpy::@real", "jsonFile": "target-hip_saxpy-Release.json"},
                {"name": "vulkan_interop", "id": "vulkan_interop::@real", "jsonFile": "target-vulkan_interop-Release.json"}
              ]
            }
          ]
        }
        """,
        ".cmake/api/v1/reply/target-hip_saxpy-Release.json": """
        {"name": "hip_saxpy", "id": "hip_saxpy::@real", "type": "EXECUTABLE", "sources": [{"path": "HIP-Basic/saxpy/main.hip"}]}
        """,
        ".cmake/api/v1/reply/target-vulkan_interop-Release.json": """
        {"name": "vulkan_interop", "id": "vulkan_interop::@real", "type": "EXECUTABLE", "sources": [{"path": "HIP-Basic/vulkan_interop/main.hip"}]}
        """,
    }

    _prompt, report = build_project_source_context(files, focus="HIP-Basic/saxpy/main.hip")
    backend = report["graphicsBackend"]

    assert report["buildMetadata"]["targetResolution"]["selectedTarget"]["name"] == "hip_saxpy"
    assert backend["scope"] == "selected_target_sources"
    assert backend["primary"] is None
    assert backend["supportStatus"] == "unknown"
    assert "unsupported.graphics_backend_vulkan" not in backend["reasonCodes"]
    assert all("vulkan_interop" not in item["path"] for item in backend["evidence"])


def test_graphics_backend_detection_ignores_vendored_vulkan_sources_for_primary_backend():
    files = {
        "CMakeLists.txt": """
        add_executable(path_tracer src/main.cpp src/OpenGL/Display.cpp thirdparties/hiprt/src/vk_device.cpp)
        """,
        "src/main.cpp": """
        #include <GLFW/glfw3.h>
        #include <imgui.h>
        int main(){ glfwInit(); ImGui::CreateContext(); return 0; }
        """,
        "src/OpenGL/Display.cpp": """
        #include <GL/glew.h>
        void draw(){ glClear(GL_COLOR_BUFFER_BIT); }
        """,
        "thirdparties/hiprt/src/vk_device.cpp": """
        #include <vulkan/vulkan.h>
        void vendor_probe(){ VkInstance instance = VK_NULL_HANDLE; }
        """,
        ".cmake/api/v1/reply/codemodel-v2-release.json": """
        {
          "kind": "codemodel",
          "configurations": [
            {
              "name": "Release",
              "targets": [
                {"name": "path_tracer", "id": "path_tracer::@real", "jsonFile": "target-path_tracer-Release.json"}
              ]
            }
          ]
        }
        """,
        ".cmake/api/v1/reply/target-path_tracer-Release.json": """
        {
          "name": "path_tracer",
          "id": "path_tracer::@real",
          "type": "EXECUTABLE",
          "sources": [
            {"path": "src/main.cpp"},
            {"path": "src/OpenGL/Display.cpp"},
            {"path": "thirdparties/hiprt/src/vk_device.cpp"}
          ]
        }
        """,
    }

    _prompt, report = build_project_source_context(files, focus="src/main.cpp")
    backend = report["graphicsBackend"]
    dropped_reasons = {item["path"]: item["dropReason"] for item in report["dropped"]}

    assert dropped_reasons["thirdparties/hiprt/src/vk_device.cpp"] == "vendor_dependency"
    assert backend["primary"] == "imgui_glfw"
    assert "glfw_opengl" in backend["detected"]
    assert "vulkan" not in backend["detected"]
    assert "unsupported.graphics_backend_vulkan" not in backend["reasonCodes"]


def test_selected_target_context_drops_unrelated_device_translation_units():
    files = {
        "HIP-Basic/saxpy/main.hip": """
        #include <hip/hip_runtime.h>
        __global__ void saxpy_kernel(float* y, const float* x) { y[threadIdx.x] = x[threadIdx.x]; }
        int main(){ return 0; }
        """,
        "HIP-Basic/matrix_multiplication/main.hip": """
        #include <hip/hip_runtime.h>
        __global__ void matrix_kernel(float* out) { out[threadIdx.x] = 1.0f; }
        int main(){ return 0; }
        """,
        "Common/example_utils.hpp": "#pragma once\ninline int ceiling_div(int a, int b){ return (a + b - 1) / b; }\n",
        "compile_commands.json": """
        [
          {
            "directory": "/repo/HIP-Basic/saxpy/build",
            "file": "/repo/HIP-Basic/saxpy/main.hip",
            "arguments": ["hipcc", "--offload-arch=gfx1201", "-c", "/repo/HIP-Basic/saxpy/main.hip"]
          }
        ]
        """,
        ".cmake/api/v1/reply/codemodel-v2-release.json": """
        {
          "kind": "codemodel",
          "configurations": [
            {
              "name": "Release",
              "targets": [
                {"name": "hip_saxpy", "id": "hip_saxpy::@real", "jsonFile": "target-hip_saxpy-Release.json"},
                {"name": "matrix_multiplication", "id": "matrix_multiplication::@real", "jsonFile": "target-matrix_multiplication-Release.json"}
              ]
            }
          ]
        }
        """,
        ".cmake/api/v1/reply/target-hip_saxpy-Release.json": """
        {"name": "hip_saxpy", "id": "hip_saxpy::@real", "type": "EXECUTABLE", "sources": [{"path": "HIP-Basic/saxpy/main.hip"}]}
        """,
        ".cmake/api/v1/reply/target-matrix_multiplication-Release.json": """
        {"name": "matrix_multiplication", "id": "matrix_multiplication::@real", "type": "EXECUTABLE", "sources": [{"path": "HIP-Basic/matrix_multiplication/main.hip"}]}
        """,
    }

    _prompt, report = build_project_source_context(files, focus="HIP-Basic/saxpy/main.hip")
    included_paths = {item["path"] for item in report["included"]}
    dropped = {item["path"]: item.get("dropReason") for item in report["dropped"]}

    assert "HIP-Basic/saxpy/main.hip" in included_paths
    assert dropped["HIP-Basic/matrix_multiplication/main.hip"] == "unrelated_target_device_source"
    assert report["deviceTuTopology"]["deviceTranslationUnitCount"] == 1
    assert report["deviceTuTopology"]["deviceTranslationUnits"][0]["path"] == "HIP-Basic/saxpy/main.hip"


def test_large_repo_context_selects_target_and_records_omissions():
    files = {
        "CMakeLists.txt": "add_executable(gpu_app src/app/main.cpp src/gpu/flow.hip)",
        "src/app/main.cpp": "int main(){ return 0; }",
        "src/gpu/flow.hip": "__global__ void flow() {}",
        "src/render/glfw_view.cpp": "#include <GLFW/glfw3.h>\nvoid draw(){}",
        "compile_commands.json": """
        [
          {
            "directory": "/repo/build",
            "file": "/repo/src/app/main.cpp",
            "arguments": ["clang++", "-Isrc", "-DAPP=1", "-c", "src/app/main.cpp"]
          },
          {
            "directory": "/repo/build",
            "file": "/repo/src/gpu/flow.hip",
            "arguments": ["hipcc", "-Isrc", "--offload-arch=gfx1201", "-c", "src/gpu/flow.hip"]
          }
        ]
        """,
        ".cmake/api/v1/reply/codemodel-v2-debug.json": """
        {
          "kind": "codemodel",
          "configurations": [
            {
              "name": "Debug",
              "targets": [
                {"name": "gpu_app", "id": "gpu_app::@123", "jsonFile": "target-gpu_app-Debug.json"},
                {"name": "tooling_app", "id": "tooling::@123", "jsonFile": "target-tooling-Debug.json"}
              ]
            }
          ]
        }
        """,
        ".cmake/api/v1/reply/target-gpu_app-Debug.json": """
        {
          "name": "gpu_app",
          "id": "gpu_app::@123",
          "type": "EXECUTABLE",
          "sources": [
            {"path": "src/app/main.cpp"},
            {"path": "src/gpu/flow.hip"},
            {"path": "src/render/glfw_view.cpp"}
          ]
        }
        """,
        ".cmake/api/v1/reply/target-tooling-Debug.json": """
        {
          "name": "tooling_app",
          "id": "tooling::@123",
          "type": "EXECUTABLE",
          "sources": [{"path": "tools/main.cpp"}]
        }
        """,
    }
    for index in range(5000):
        files[f"docs/generated/note_{index:04}.md"] = f"large repo omission {index}\n"

    _prompt, report = build_project_source_context(files, focus="src/app/main.cpp")
    target = report["buildMetadata"]["targetResolution"]
    dropped_reasons = {item["dropReason"] for item in report["dropped"]}

    assert report["workspaceFileCount"] == len(files)
    assert target["status"] == "selected"
    assert target["selectedTarget"]["name"] == "gpu_app"
    assert report["deterministicContextComplete"] is True
    assert "docs_tests_examples" in dropped_reasons
    assert report["buildMetadata"]["compileCommandsStatus"] == "selected"


def test_source_context_ingests_compiler_template_evidence():
    command = [
        "hipcc",
        "-Iinclude",
        "--offload-arch=gfx1201",
        "-c",
        "src/gpu/reduce.hip",
    ]
    flags_hash = stable_hash(command[1:])
    files = {
        "src/app/main.cpp": "int main(){ return 0; }",
        "src/gpu/reduce.hip": """
        template <typename T, int BLOCK_SIZE>
        __device__ T BlockReduce(T value) { return value; }
        __global__ void reduce_kernel(float* values) {
            values[0] = BlockReduce<float, 128>(values[0]);
            values[1] = BlockReduce<float, 256>(values[1]);
        }
        """,
        "compile_commands.json": f"""
        [
          {{
            "directory": "/repo/build",
            "file": "/repo/src/gpu/reduce.hip",
            "arguments": {command!r}
          }}
        ]
        """.replace("'", '"'),
        ".synthi/template-evidence.json": f"""
        {{
          "schemaVersion": "synthi.gpu.template_evidence.v1",
          "status": "fresh",
          "producer": "clang-libtooling+vendor-artifacts",
          "compileCommandHash": "{stable_hash(command)}",
          "effectiveFlagsHash": "{flags_hash}",
          "gpuArch": "gfx1201",
          "bounded": true,
          "entries": [
            {{
              "templateName": "BlockReduce<T, BLOCK_SIZE>",
              "templateArgs": ["float", "128"],
              "owningTU": "src/gpu/reduce.hip",
              "instantiationSite": "src/gpu/reduce.hip:5",
              "reachableFromKernel": "reduce_kernel(float*)",
              "sourceHeaders": ["src/gpu/reduce.hip"],
              "generatedRole": "device.reduce",
              "abiFingerprint": "abi-128",
              "layoutFingerprint": "layout-128",
              "artifactFingerprint": "artifact-128"
            }},
            {{
              "templateName": "BlockReduce<T, BLOCK_SIZE>",
              "templateArgs": ["float", "256"],
              "owningTU": "src/gpu/reduce.hip",
              "instantiationSite": "src/gpu/reduce.hip:6",
              "reachableFromKernel": "reduce_kernel(float*)",
              "sourceHeaders": ["src/gpu/reduce.hip"],
              "generatedRole": "device.reduce",
              "abiFingerprint": "abi-256",
              "layoutFingerprint": "layout-256",
              "artifactFingerprint": "artifact-256"
            }}
          ]
        }}
        """,
    }

    prompt, report = build_project_source_context(files, focus="src/gpu/reduce.hip")
    metadata = report["buildMetadata"]
    evidence = metadata["templateEvidence"]

    assert metadata["templateEvidenceStatus"] == "fresh"
    assert metadata["templateEvidenceCandidateCount"] == 1
    assert metadata["templateEvidenceInvalidationReasons"] == []
    assert evidence["producer"] == "clang-libtooling+vendor-artifacts"
    assert evidence["effectiveFlagsHash"] == flags_hash
    assert evidence["bounded"] is True
    assert [entry["templateArgs"][1] for entry in evidence["entries"]] == ["128", "256"]
    assert "Template evidence: status=fresh" in prompt


def test_template_evidence_can_match_device_tu_compile_command_for_selected_target():
    main_command = [
        "clang++",
        "-Iinclude",
        "-DSCALE_ENTRY=1",
        "-c",
        "src/app/main.cpp",
    ]
    device_command = [
        "hipcc",
        "-Isrc",
        "--offload-arch=gfx1201",
        "-c",
        "src/gpu/reduce.hip",
    ]
    device_flags_hash = stable_hash(device_command[1:])
    files = {
        "CMakeLists.txt": "add_executable(gpu_app src/app/main.cpp src/gpu/reduce.hip)",
        "src/app/main.cpp": "int main(){ return 0; }",
        "src/gpu/reduce.hip": """
        template <typename T, int BLOCK_SIZE>
        __device__ T BlockReduce(T value) { return value; }
        __global__ void reduce_kernel(float* values) {
            values[0] = BlockReduce<float, 128>(values[0]);
            values[1] = BlockReduce<float, 256>(values[1]);
        }
        """,
        "compile_commands.json": f"""
        [
          {{
            "directory": "/repo/build",
            "file": "/repo/src/app/main.cpp",
            "arguments": {main_command!r}
          }},
          {{
            "directory": "/repo/build",
            "file": "/repo/src/gpu/reduce.hip",
            "arguments": {device_command!r}
          }}
        ]
        """.replace("'", '"'),
        ".cmake/api/v1/reply/codemodel-v2-debug.json": """
        {
          "kind": "codemodel",
          "configurations": [
            {
              "name": "Debug",
              "targets": [
                {"name": "gpu_app", "id": "gpu_app::@123", "jsonFile": "target-gpu_app-Debug.json"}
              ]
            }
          ]
        }
        """,
        ".cmake/api/v1/reply/target-gpu_app-Debug.json": """
        {
          "name": "gpu_app",
          "id": "gpu_app::@123",
          "type": "EXECUTABLE",
          "sources": [
            {"path": "src/app/main.cpp"},
            {"path": "src/gpu/reduce.hip"}
          ]
        }
        """,
        ".cmake/api/v1/reply/synthi-template-evidence.json": f"""
        {{
          "templateEvidence": {{
            "schemaVersion": "synthi.gpu.template_evidence.v1",
            "status": "fresh",
            "producer": "clang-libtooling+vendor-artifacts",
            "compileCommandHash": "{stable_hash(device_command)}",
            "effectiveFlagsHash": "{device_flags_hash}",
            "gpuArch": "gfx1201",
            "bounded": true,
            "entries": [
              {{
                "templateName": "BlockReduce<T, BLOCK_SIZE>",
                "templateArgs": ["float", "128"],
                "owningTU": "src/gpu/reduce.hip",
                "instantiationSite": "src/gpu/reduce.hip:5",
                "reachableFromKernel": "reduce_kernel(float*)",
                "sourceHeaders": ["src/gpu/reduce.hip"],
                "generatedRole": "device.reduce",
                "abiFingerprint": "abi-128",
                "layoutFingerprint": "layout-128",
                "artifactFingerprint": "artifact-128"
              }},
              {{
                "templateName": "BlockReduce<T, BLOCK_SIZE>",
                "templateArgs": ["float", "256"],
                "owningTU": "src/gpu/reduce.hip",
                "instantiationSite": "src/gpu/reduce.hip:6",
                "reachableFromKernel": "reduce_kernel(float*)",
                "sourceHeaders": ["src/gpu/reduce.hip"],
                "generatedRole": "device.reduce",
                "abiFingerprint": "abi-256",
                "layoutFingerprint": "layout-256",
                "artifactFingerprint": "artifact-256"
              }}
            ]
          }}
        }}
        """,
    }

    _prompt, report = build_project_source_context(files, focus="src/app/main.cpp")
    metadata = report["buildMetadata"]
    evidence = metadata["templateEvidence"]

    assert metadata["selectedCompileCommand"]["file"].endswith("src/app/main.cpp")
    assert metadata["templateEvidenceStatus"] == "fresh"
    assert metadata["templateEvidenceInvalidationReasons"] == []
    assert evidence["effectiveFlagsHash"] == device_flags_hash
    assert [entry["templateArgs"][1] for entry in evidence["entries"]] == ["128", "256"]
    assert any(
        item["file"].endswith("src/gpu/reduce.hip")
        and item["effectiveFlagsHash"] == device_flags_hash
        for item in metadata["templateEvidenceCompileCommands"]
    )

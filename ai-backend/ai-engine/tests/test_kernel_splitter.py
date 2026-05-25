"""Unit tests for agents/kernel_splitter.py — parser + prompt build.

We don't exercise `run_kernel_splitter` here because it hits an LLM
provider; the parser + verifier composition is exhaustively tested
through `parse_kernel_split_response` + `verify_split_output`.
"""

import asyncio
import json

import pytest

import agents.kernel_splitter as kernel_splitter
from agents.gpu_detect import GpuDetectionResult, GpuDetectionEvidence
from agents.kernel_splitter import (
    KernelSplitProviderError,
    KernelSplitterError,
    KernelSplitterUnsupportedProjectError,
    build_split_retry_prompt,
    _project_source_context,
    _source_files_scoped_to_context,
    _source_device_preservation_contract,
    _source_device_kernel_symbol_set,
    _source_launch_graph_contract,
    _verifier_acceptance_gate_contract,
    _kernel_hashes_for_generated_split,
    _stamp_core_device_kernel_sig_hashes,
    build_prompt,
    parse_kernel_split_response,
    run_kernel_splitter,
    split_failure_verification,
    split_provider_failure_verification,
    split_agentic_report,
    split_attempt_record,
)
from agents.gpu_source_context import build_project_source_context
from llm.prompts import GPU_SPLIT_PROMPT, build_split_mode_prompt
from verifier_gpu import SplitVerificationResult, Violation


SAMPLE_RAW = '''
<JSON>
{
  "shared.h": "#include \\"synthi_gpu_runtime.h\\"\\nstruct AppState { int n; };",
  "core.cpp": "void launch_va() { synthi_gpu_launch(gpu, \\"vec_add\\", 1, 256, 0, stream, { &a, &b, &c, &n }); }",
  "gui.cpp": "void draw() {}",
  "host_runner.cpp": "int main() { return 0; }",
  "device.cu": "__global__ void vec_add(const float* a, const float* b, float* c, int n) {}"
}
</JSON>
<synthi_arch_cache>
# Architecture overview
This project is a CUDA vector-add demo.

<synthi_kernel_hashes>{ "vec_add": "0x1234abcd5678ef01" }</synthi_kernel_hashes>
<synthi_launch_graph>[
  { "site": "core.cpp:1", "kernel": "vec_add", "grid": "1", "block": "256",
    "shared": 0, "stream": "0",
    "params": ["const float*","const float*","float*","int"] }
]</synthi_launch_graph>
<synthi_build_manifest>{
  "compiler": "g++",
  "std": "c++26",
  "common_flags": ["-shared","-fPIC"],
  "core_link_flags": [],
  "gui_link_flags": ["-lSDL2"],
  "shared_link_flags": [],
  "runner_link_flags": ["-lSDL2","-ldl","-lcudart","-lcuda"],
  "files": ["shared.h","core.cpp","gui.cpp","host_runner.cpp","device.cu"],
  "system_packages": [],
  "hot_reload_mode": "swap",
  "confidence": { "overall": "high", "runner_synthesis": "high",
                  "link_flags": "high", "notes": "CUDA vector add" },
  "gpu": {
    "vendor": "cuda",
    "device_compiler": "nvcc",
    "arch": ["sm_80"],
    "device_flags": ["-O3","-lineinfo"],
    "runtime_libs": ["cudart","cuda"],
    "snapshot_mode": "auto",
    "fatbin_strategy": "sidecar_module"
  }
}</synthi_build_manifest>
</synthi_arch_cache>
'''


def test_parses_clean_response():
    parsed = parse_kernel_split_response(SAMPLE_RAW)
    assert "device.cu" in parsed["files"]
    assert "vec_add" in parsed["files"]["device.cu"]
    assert parsed["manifest"]["gpu"]["vendor"] == "cuda"
    assert parsed["manifest"]["files"][-1] == "device.cu"
    assert parsed["kernel_hashes"] == {"vec_add": "0x1234abcd5678ef01"}
    assert isinstance(parsed["launch_graph"], list)
    assert parsed["launch_graph"][0]["kernel"] == "vec_add"
    assert "<synthi_build_manifest>" not in parsed["architecture_md"]
    assert "<synthi_kernel_hashes>" not in parsed["architecture_md"]


def test_rejects_missing_json_block():
    raw = "<synthi_arch_cache>nothing here</synthi_arch_cache>"
    with pytest.raises(KernelSplitterError, match="<JSON>"):
        parse_kernel_split_response(raw)


def test_rejects_bad_json():
    raw = '<JSON>{ "shared.h": "x", }</JSON>'  # trailing comma
    with pytest.raises(KernelSplitterError, match="not valid JSON"):
        parse_kernel_split_response(raw)


def test_rejects_non_dict_top_level():
    raw = "<JSON>[1, 2]</JSON>"
    with pytest.raises(KernelSplitterError, match="did not parse to a dict"):
        parse_kernel_split_response(raw)


def test_missing_optional_blocks_are_empty():
    # Some bare responses only emit the file JSON. The parser must
    # degrade gracefully — manifest=None, kernel_hashes={}, launch=[].
    raw = '<JSON>{"shared.h":"x","core.cpp":"y","gui.cpp":"z","host_runner.cpp":"r","device.cu":"d"}</JSON>'
    parsed = parse_kernel_split_response(raw)
    assert parsed["manifest"] is None
    assert parsed["kernel_hashes"] == {}
    assert parsed["launch_graph"] == []
    assert parsed["architecture_md"] == ""


def test_kernel_hashes_are_recomputed_from_included_source_device_headers():
    files = {
        "device.hip": '#define __KERNELCC__ 1\n#include "src/Device/kernels/CameraRays.h"\n'
    }
    source_files = {
        "src/Device/kernels/CameraRays.h": (
            "GLOBAL_KERNEL_SIGNATURE(void) __launch_bounds__(64) "
            "CameraRays(HIPRTRenderData render_data) { render_data.random_number += 1; }"
        )
    }

    hashes = _kernel_hashes_for_generated_split(
        files=files,
        manifest={"module_files": {"device": "device.hip"}},
        source_files=source_files,
    )

    assert set(hashes) == {"CameraRays"}
    assert hashes["CameraRays"].startswith("0x")


def test_core_device_kernel_sig_hash_export_is_deterministically_stamped():
    files = {
        "core.cpp": (
            'extern "C" unsigned long long device_kernel_sig_hash(const char* name) { '
            'if (name) return 0x1234abcd5678ef01ULL; return 0ULL; }'
        ),
        "device.hip": '#include "src/Device/kernels/CameraRays.h"\n',
    }
    source_files = {
        "src/Device/kernels/CameraRays.h": (
            "GLOBAL_KERNEL_SIGNATURE(void) __launch_bounds__(64) "
            "CameraRays(HIPRTRenderData render_data) { render_data.random_number += 1; }"
        )
    }
    hashes = _kernel_hashes_for_generated_split(
        files=files,
        manifest={"module_files": {"device": "device.hip", "core": "core.cpp"}},
        source_files=source_files,
    )

    stamped = _stamp_core_device_kernel_sig_hashes(
        files=files,
        manifest={"module_files": {"core": "core.cpp"}},
        kernel_hashes=hashes,
    )

    assert "0x1234abcd5678ef01ULL" not in stamped["core.cpp"]
    assert f'{hashes["CameraRays"]}ULL' in stamped["core.cpp"]
    assert 'synthi_kernel_name_eq(name, "CameraRays")' in stamped["core.cpp"]


def test_device_preservation_contract_uses_selected_context_scope():
    files = {
        "HIP-Basic/saxpy/main.hip": """
        #include <hip/hip_runtime.h>
        __global__ void saxpy_kernel(float* y, const float* x) { y[threadIdx.x] = x[threadIdx.x]; }
        int main(){ return 0; }
        """,
        "Applications/fdtd/main.hip": """
        #include <hip/hip_runtime.h>
        __global__ void apply_source_kernel(float* ez) { ez[threadIdx.x] = 1.0f; }
        int main(){ return 0; }
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
                {"name": "fdtd", "id": "fdtd::@real", "jsonFile": "target-fdtd-Release.json"}
              ]
            }
          ]
        }
        """,
        ".cmake/api/v1/reply/target-hip_saxpy-Release.json": """
        {"name": "hip_saxpy", "id": "hip_saxpy::@real", "type": "EXECUTABLE", "sources": [{"path": "HIP-Basic/saxpy/main.hip"}]}
        """,
        ".cmake/api/v1/reply/target-fdtd-Release.json": """
        {"name": "fdtd", "id": "fdtd::@real", "type": "EXECUTABLE", "sources": [{"path": "Applications/fdtd/main.hip"}]}
        """,
    }

    _prompt, report = build_project_source_context(files, focus="HIP-Basic/saxpy/main.hip")
    scoped = _source_files_scoped_to_context(files, report)
    contract = _source_device_preservation_contract(
        scoped,
        roots=[unit["path"] for unit in report["deviceTuTopology"]["deviceTranslationUnits"]],
    )

    assert "HIP-Basic/saxpy/main.hip" in scoped
    assert "Applications/fdtd/main.hip" not in scoped
    assert "saxpy_kernel" in contract
    assert "apply_source_kernel" not in contract


def test_context_scope_keeps_source_declared_device_compiler_prelude():
    files = {
        "src/Device/kernels/CameraRays.h": (
            '#include "HostDeviceCommon/RenderData.h"\n'
            "GLOBAL_KERNEL_SIGNATURE(void) CameraRays(int* out) { *out = 1; }\n"
        ),
        "src/HostDeviceCommon/RenderData.h": "#include <hiprt/hiprt_device.h>\n",
        "src/llvm-compile-kernel.h": (
            "#include <hiprt/hiprt_device.h>\n"
            "#include <hiprt/impl/hiprt_device_impl.h>\n"
        ),
        "thirdparties/HIPRT-Fork/hiprt/impl/hiprt_device_impl.h": (
            "#include <hiprt/hiprt_device.h>\n"
        ),
    }
    report = {
        "included": [{"path": "src/Device/kernels/CameraRays.h"}],
        "deviceTuTopology": {"deviceTranslationUnits": []},
    }

    scoped = _source_files_scoped_to_context(files, report)

    assert "src/llvm-compile-kernel.h" in scoped
    assert "thirdparties/HIPRT-Fork/hiprt/impl/hiprt_device_impl.h" in scoped


def test_normalizes_nested_file_objects():
    raw = '''
<JSON>{
  "core": { "core.cpp": "extern \\"C\\" void* core_on_load(void*, void*) { return 0; }\\nextern \\"C\\" void core_on_update(void*, double) {}" },
  "gui.cpp": { "file_content": "extern \\"C\\" void* gui_on_load(void*, void*, void*) { return 0; }\\nextern \\"C\\" void gui_on_render(void*) {}" },
  "shared": { "filename": "shared.h", "content": "#include \\"synthi_gpu_runtime.h\\"" },
  "host_runner.cpp": "int main(){return 0;}",
  "device": { "filename": "device.hip", "content": "__global__ void particle_flow(float* x) {}" }
}</JSON>
'''
    parsed = parse_kernel_split_response(raw)
    assert parsed["files"]["core.cpp"].startswith('extern "C"')
    assert parsed["files"]["gui.cpp"].startswith('extern "C"')
    assert parsed["files"]["shared.h"] == '#include "synthi_gpu_runtime.h"'
    assert parsed["files"]["device.hip"].startswith("__global__")


def test_normalizes_json_string_file_content_object():
    raw = '''
<JSON>{
  "shared.h": "#include \\"synthi_gpu_runtime.h\\"",
  "core.cpp": "extern \\"C\\" void* core_on_load(void*, void*) { return 0; }\\nextern \\"C\\" void core_on_update(void*, double) {}",
  "gui.cpp": "{\\"file_content\\":\\"extern \\\\\\"C\\\\\\" void* gui_on_load(void*, void*, void*) { return 0; }\\\\nextern \\\\\\"C\\\\\\" void gui_on_render(void*) {}\\"}",
  "host_runner.cpp": "int main(){return 0;}",
  "device.hip": "__global__ void particle_flow(float* x) {}"
}</JSON>
'''
    parsed = parse_kernel_split_response(raw)
    assert parsed["files"]["gui.cpp"].startswith('extern "C"')


def test_normalizes_json_like_file_content_with_literal_newlines():
    raw = '''
<JSON>{
  "shared.h": "#include \\"synthi_gpu_runtime.h\\"",
  "core.cpp": "{\\n\\"file_content\\": \\"#include \\\\\\"shared.h\\\\\\"\\nextern \\\\\\"C\\\\\\" void* core_on_load(void*, void*) { return 0; }\\nextern \\\\\\"C\\\\\\" void core_on_update(void*, double) {}\\"\\n}",
  "gui.cpp": "extern \\"C\\" void* gui_on_load(void*, void*, void*) { return 0; }\\nextern \\"C\\" void gui_on_render(void*) {}",
  "host_runner.cpp": "int main(){return 0;}",
  "device.hip": "__global__ void particle_flow(float* x) {}"
}</JSON>
'''
    parsed = parse_kernel_split_response(raw)
    assert parsed["files"]["core.cpp"].startswith('#include "shared.h"')
    assert 'extern "C" void core_on_update' in parsed["files"]["core.cpp"]


def test_normalizes_embedded_file_map_inside_role_content():
    raw = r'''
<JSON>{
  "core": {
    "filename": "core.cpp",
    "content": "{\"shared.h\":\"#pragma once\\n#include \\\"synthi_gpu_runtime.h\\\"\",\"core.cpp\":\"#include \\\"shared.h\\\"\\nextern \\\"C\\\" void core_on_update(void*, double) {}\"}"
  },
  "gui.cpp": "extern \"C\" void gui_on_render(void*) {}",
  "host_runner.cpp": "int main(){return 0;}",
  "device.hip": "__global__ void particle_flow(float* x) {}"
}</JSON>
'''
    parsed = parse_kernel_split_response(raw)
    assert parsed["files"]["shared.h"].startswith("#pragma once")
    assert parsed["files"]["core.cpp"].startswith('#include "shared.h"')
    assert "extern \"C\" void core_on_update" in parsed["files"]["core.cpp"]


def test_does_not_compile_embedded_file_map_as_role_source():
    embedded = json.dumps({"shared.h": "#pragma once\n"})
    raw = f'''
<JSON>{{
  "core": {{"filename": "core.cpp", "content": {json.dumps(embedded)}}},
  "gui.cpp": "extern \\"C\\" void gui_on_render(void*) {{}}",
  "host_runner.cpp": "int main(){{return 0;}}",
  "device.hip": "__global__ void particle_flow(float* x) {{}}"
}}</JSON>
'''
    parsed = parse_kernel_split_response(raw)
    assert parsed["files"]["shared.h"].startswith("#pragma once")
    assert "core.cpp" not in parsed["files"]


def test_build_prompt_substitutes_user_code():
    code = "__global__ void k(){}"
    p = build_prompt(code)
    assert code in p
    assert "{USER_CODE}" not in p
    assert "synthi_gpu_launch" in p
    assert '#include "synthi_gpu_runtime.h"' in p
    assert "raw `kernel<<<grid, block, shared, stream>>>(args...)`" in p


def test_build_prompt_attaches_detection_hint():
    detection = GpuDetectionResult(
        is_gpu=True, vendor_hint="cuda", per_file={"k.cu": GpuDetectionEvidence(qualifier_hits=1)}
    )
    p = build_prompt("__global__ void k(){}", detection=detection)
    assert "DETECTION HINT" in p
    assert "cuda" in p


def test_build_prompt_attaches_runtime_target_hint(monkeypatch):
    monkeypatch.setenv("SYNTHI_GPU_VENDOR_HINT", "rocm")
    monkeypatch.setenv("SYNTHI_GPU_ARCH_HINT", "gfx1201")
    p = build_prompt("__global__ void k(){}")
    assert "RUNTIME GPU TARGET" in p
    assert "vendor=rocm" in p
    assert "arch=gfx1201" in p


def test_split_attempt_record_hashes_prompt_and_reports_verifier_codes():
    verification = SplitVerificationResult(
        ok=False,
        violations=[
            Violation(
                rule="split_missing_device_file",
                message="device role missing",
                offending_module="device",
            )
        ],
    )

    attempt = split_attempt_record(
        attempt=2,
        max_attempts=3,
        model="gemini-test",
        prompt="secret prompt text",
        source_files=["src\\main.cpp", "src/gpu/k.hip"],
        verification=verification,
        repair_prompt=True,
    )

    assert attempt["phase"] == "repair_verify"
    assert attempt["repairScope"] == "generated_artifacts_only"
    assert attempt["sourceFiles"] == ["src/gpu/k.hip", "src/main.cpp"]
    assert len(attempt["promptHash"]) == 64
    assert "secret prompt text" not in str(attempt)
    assert attempt["verifiers"][0]["status"] == "fail"
    assert attempt["verifiers"][0]["reasonCodes"] == ["split_missing_device_file"]
    assert attempt["verifiers"][1]["status"] == "pending_worker"

    report = split_agentic_report(attempts=[attempt], accepted=False, max_attempts=3)
    assert report["mode"] == "full_split"
    assert report["attemptCount"] == 1
    assert report["boundedRetries"] is True
    assert report["persistedAfterVerification"] is False


def test_split_failure_verification_is_reason_coded():
    verification = split_failure_verification(
        "split_response_unparseable",
        "Response missing <JSON> block",
    )

    assert verification.ok is False
    assert verification.violations[0].rule == "split_response_unparseable"
    assert "missing <JSON>" in verification.violations[0].message


def test_split_provider_timeout_is_reason_coded():
    verification = split_provider_failure_verification(
        KernelSplitProviderError(TimeoutError())
    )

    assert verification.ok is False
    assert verification.violations[0].rule == "ai_provider_timeout"
    assert "TimeoutError" in verification.violations[0].message


def test_run_kernel_splitter_rejects_vulkan_before_ai_provider():
    class Provider:
        called = False

        async def ask_llm(self, *_args, **_kwargs):
            self.called = True
            raise AssertionError("provider should not be called for unsupported Vulkan")

    provider = Provider()
    detection = GpuDetectionResult(
        is_gpu=True,
        vendor_hint="rocm",
        per_file={
            "src/gpu/flow.hip": GpuDetectionEvidence(qualifier_hits=1),
        },
    )
    files = [
        {
            "name": "src/app/main.cpp",
            "content": '#include <vulkan/vulkan.h>\nint main(){ VkInstance x{}; return 0; }',
        },
        {
            "name": "src/gpu/flow.hip",
            "content": "__global__ void flow() {}",
        },
    ]

    with pytest.raises(KernelSplitterUnsupportedProjectError) as exc:
        asyncio.run(
            run_kernel_splitter(
                provider=provider,
                user_code=files[0]["content"],
                lang="cpp",
                detection=detection,
                files=files,
                focus="src/app/main.cpp",
            )
        )

    assert provider.called is False
    assert exc.value.reason_code == "unsupported.graphics_backend_vulkan"
    assert exc.value.source_context_report["graphicsBackend"]["primary"] == "vulkan"


def test_run_kernel_splitter_rejects_ambiguous_cmake_target_before_ai_provider():
    class Provider:
        called = False

        async def ask_llm(self, *_args, **_kwargs):
            self.called = True
            raise AssertionError("provider should not be called for ambiguous CMake targets")

    provider = Provider()
    detection = GpuDetectionResult(
        is_gpu=True,
        vendor_hint="rocm",
        per_file={
            "src/gpu/flow.hip": GpuDetectionEvidence(qualifier_hits=1),
        },
    )
    files = [
        {"name": "CMakeLists.txt", "content": "add_executable(a src/app/main.cpp)\nadd_executable(b src/app/main.cpp)"},
        {"name": "src/app/main.cpp", "content": "int main(){ return 0; }"},
        {"name": "src/gpu/flow.hip", "content": "__global__ void flow() {}"},
        {
            "name": ".cmake/api/v1/reply/codemodel-v2-debug.json",
            "content": """
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
        },
        {
            "name": ".cmake/api/v1/reply/target-a-Debug.json",
            "content": '{"name":"gpu_app_a","id":"a::@123","type":"EXECUTABLE","sources":[{"path":"src/app/main.cpp"},{"path":"src/gpu/flow.hip"}]}',
        },
        {
            "name": ".cmake/api/v1/reply/target-b-Debug.json",
            "content": '{"name":"gpu_app_b","id":"b::@123","type":"EXECUTABLE","sources":[{"path":"src/app/main.cpp"},{"path":"src/gpu/flow.hip"}]}',
        },
    ]

    with pytest.raises(KernelSplitterUnsupportedProjectError) as exc:
        asyncio.run(
            run_kernel_splitter(
                provider=provider,
                user_code=files[1]["content"],
                lang="cpp",
                detection=detection,
                files=files,
                focus="src/app/main.cpp",
            )
        )

    assert provider.called is False
    assert exc.value.reason_code == "target_resolution_ambiguous"
    resolution = exc.value.source_context_report["buildMetadata"]["targetResolution"]
    assert resolution["status"] == "ambiguous"
    assert resolution["method"] == "ambiguous_executable_targets_containing_focus"


def test_build_split_retry_prompt_preserves_previous_rejections():
    prompt = build_split_retry_prompt(
        "original prompt",
        [
            "- device_init_kernel_incomplete: missing d_x",
            "- split_response_unparseable: missing <JSON>",
        ],
    )

    assert "original prompt" in prompt
    assert "deterministic verifiers" in prompt
    assert "device_init_kernel_incomplete" in prompt
    assert "split_response_unparseable" in prompt
    assert "Verifier-specific repair checklist" in prompt
    assert "init/seed kernel launch and signature" in prompt


def test_build_split_retry_prompt_guides_launch_guard_and_buffer_repairs():
    prompt = build_split_retry_prompt(
        "original prompt",
        [
            "- constant_false_launch_guard: core_on_update initializes launch guard 'initialized' to false.",
            "- device_buffers_not_initialized: d_buffer_a via TestCopyKernelRestrict.",
        ],
    )

    assert "Never initialize a local launch guard with `false`" in prompt
    assert "assigned from the actual `synthi_gpu_launch(...)` result" in prompt
    assert "Preserved device kernels are mapping artifacts" in prompt
    assert "not permission to launch every kernel" in prompt


def test_build_split_retry_prompt_lists_rejected_project_headers():
    prompt = build_split_retry_prompt(
        "original prompt",
        [
            "- generated_role_includes_project_header: Generated role file includes project header 'src/gpu/api.hpp'.",
            "- generated_role_includes_project_header: Generated role file includes project header 'src/render/window.hpp'.",
        ],
    )

    assert "src/gpu/api.hpp" in prompt
    assert "src/render/window.hpp" in prompt
    assert "Do not emit any `#include` for them" in prompt


def test_build_split_retry_prompt_guides_placeholder_render_repairs():
    prompt = build_split_retry_prompt(
        "original prompt",
        [
            "- gui_render_placeholder: The gui role contains placeholder render text 'rendering logic'.",
        ],
    )

    assert "visible non-black pixels" in prompt
    assert "placeholder render" in prompt


def test_build_split_retry_prompt_guides_backend_preservation_repairs():
    prompt = build_split_retry_prompt(
        "original prompt",
        [
            "- render_backend_changed: The generated split introduced SDL rendering even though the source project used GLFW/OpenGL.",
        ],
    )

    assert "Preserve the source render backend exactly" in prompt
    assert "do not translate to another backend" in prompt


def test_build_split_retry_prompt_guides_host_runner_gui_routing():
    prompt = build_split_retry_prompt(
        "original prompt",
        [
            "- host_runner_omits_gui_module: The host_runner role must resolve and invoke gui_on_render.",
        ],
    )

    assert "gui_render(core_state)" in prompt
    assert "dlsym(libgui" in prompt


def test_build_split_retry_prompt_guides_unresolved_launch_repairs():
    prompt = build_split_retry_prompt(
        "original prompt",
        [
            "- launch_site_unresolved: Host file core.cpp launches 'my_function' via synthi_gpu_launch(...) but no matching __global__ symbol is declared in the device role.",
        ],
    )

    assert "Do not invent placeholder host launches" in prompt
    assert "actual __global__ symbol" in prompt
    assert "fake kernel" in prompt
    assert "prompt leakage" in prompt
    assert "source context" in prompt


def test_build_split_retry_prompt_guides_source_launch_arg_repairs():
    prompt = build_split_retry_prompt(
        "original prompt",
        [
            "- source_launch_args_not_preserved: Generated core launches a source-reachable kernel 'shade_pixels' but does not preserve the source launch argument ownership.",
        ],
    )

    assert "source-reachable kernel" in prompt
    assert "same launch argument object names and order" in prompt
    assert "remove that runtime launch" in prompt


def test_verifier_acceptance_gate_contract_highlights_generic_split_gates():
    contract = _verifier_acceptance_gate_contract()

    assert "GPU SPLIT VERIFIER ACCEPTANCE GATES" in contract
    assert "original workspace/project headers" in contract
    assert "gui_on_render" in contract
    assert "gui_render(core_state)" in contract
    assert "placeholder comments" in contract
    assert "must not invent kernel names" in contract
    assert "Example identifiers are not source facts" in contract
    assert "do not launch every preserved kernel" in contract
    assert "local constants such as `bool initialized = false" in contract


def test_gpu_split_prompt_marks_examples_as_non_authoritative():
    assert "structural template" in GPU_SPLIT_PROMPT
    assert "inside examples are not project facts" in GPU_SPLIT_PROMPT
    assert "source launch graph lists project kernels" in GPU_SPLIT_PROMPT


def test_source_launch_graph_contract_reports_runtime_kernel_object_launches():
    contract = _source_launch_graph_contract(
        {
            "render_pass.cpp": (
                'void setup(){ kernel.set_kernel_function_name("shade_pixels"); }\n'
                'void draw(){ kernel.launch_asynchronous(BlockW, BlockH, w, h, args, stream); }'
            )
        }
    )

    assert "SOURCE LAUNCH GRAPH" in contract
    assert "shade_pixels" in contract
    assert "runtime_kernel_object" in contract
    assert "BlockW, BlockH, 1" in contract
    assert "unrelated preserved kernel" in contract


def test_source_launch_graph_contract_uses_selected_target_context_scope():
    files = {
        "src/app/main.cpp": (
            'void setup(){ kernel.set_kernel_function_name("draw_pixels"); }\n'
            "void draw(){ kernel.launch_asynchronous(8, 8, width, height, launch_args, stream); }\n"
        ),
        "src/tools/probe.cpp": (
            'void setup(){ probe.set_kernel_function_name("debug_kernel"); }\n'
            "void run(){ probe.launch_asynchronous(1, 1, 1, 1, scratch_args, stream); }\n"
        ),
        "compile_commands.json": """
        [
          {
            "directory": "/repo/build",
            "file": "/repo/src/app/main.cpp",
            "arguments": ["clang++", "-Isrc", "-c", "/repo/src/app/main.cpp"]
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
                {"name": "app", "id": "app::@real", "jsonFile": "target-app-Release.json"},
                {"name": "probe", "id": "probe::@real", "jsonFile": "target-probe-Release.json"}
              ]
            }
          ]
        }
        """,
        ".cmake/api/v1/reply/target-app-Release.json": """
        {"name": "app", "id": "app::@real", "type": "EXECUTABLE", "sources": [{"path": "src/app/main.cpp"}]}
        """,
        ".cmake/api/v1/reply/target-probe-Release.json": """
        {"name": "probe", "id": "probe::@real", "type": "EXECUTABLE", "sources": [{"path": "src/tools/probe.cpp"}]}
        """,
    }
    _prompt, report = build_project_source_context(files, focus="src/app/main.cpp")
    scoped = _source_files_scoped_to_context(files, report)
    contract = _source_launch_graph_contract(scoped)

    assert "draw_pixels" in contract
    assert "debug_kernel" not in contract


def test_source_launch_graph_contract_filters_to_preserved_device_kernels():
    files = {
        "src/app/main.cpp": (
            'void setup(){ first.set_kernel_function_name("kept_kernel"); }\n'
            "void draw(){ first.launch_asynchronous(8, 8, width, height, launch_args, stream); }\n"
            'void setup_debug(){ second.set_kernel_function_name("debug_kernel"); }\n'
            "void debug(){ second.launch_asynchronous(1, 1, 1, 1, debug_args, stream); }\n"
        ),
        "src/gpu/kernels.h": (
            "GLOBAL_KERNEL_SIGNATURE(void) kept_kernel(float* out) { out[0] = 1.0f; }\n"
        ),
    }
    allowed = _source_device_kernel_symbol_set(files, roots=["src/gpu/kernels.h"])
    contract = _source_launch_graph_contract(files, allowed_kernels=allowed)

    assert "kept_kernel" in contract
    assert "debug_kernel" not in contract
    assert "source-device preservation set" in contract


def test_build_prompt_attaches_extra_instructions():
    p = build_prompt("x", extra_instructions="don't change kernel names")
    assert "EXTRA INSTRUCTIONS" in p
    assert "don't change kernel names" in p


def test_split_mode_prompt_preserves_split_response_format():
    prompt = build_split_mode_prompt("int main(){}", "cpp", "split contract")

    assert "split contract" in prompt
    assert "<JSON>...</JSON>" in prompt
    assert "<synthi_arch_cache>...</synthi_arch_cache>" in prompt
    assert "ONLY the JSON object" not in prompt


def test_project_source_context_includes_multi_file_sources():
    context = _project_source_context(
        {
            "src/app/main.cpp": "int main(){return 0;}",
            "src/gpu/particle_kernels.hip": "__global__ void advance_particle_field(float* x){}",
            "src/field/flow_profile_00.hpp": "#pragma once\nconstexpr float kPull = 0.2f;",
            "src/field/flow_table_00.h": "#pragma once\nstatic const int kBand = 1;",
            "src/field/flow_module_00.cpp": "float force(float x){return x;}",
            "docs/notes/field-note-000.md": "# not source context",
        },
        focus="src/app/main.cpp",
    )
    assert "FULL ORDINARY PROJECT SOURCE CONTEXT" in context
    assert "// FILE: src/app/main.cpp" in context
    assert "// FILE: src/gpu/particle_kernels.hip" in context
    assert "// FILE: src/field/flow_profile_00.hpp" in context
    assert "// FILE: src/field/flow_table_00.h" in context
    assert "// FILE: src/field/flow_module_00.cpp" in context
    assert "docs/notes/field-note-000.md" not in context


def test_project_source_context_prioritizes_macro_wrapped_gpu_kernels():
    context = _project_source_context(
        {
            "src/main.cpp": "#include <GLFW/glfw3.h>\nint main(){ return 0; }",
            "src/Device/GPUKernel.cpp": "void launch(){ oroModuleLaunchKernel(fn, 1, 1, 1, 64, 1, 1, 0, stream, args, 0); }",
            "src/Device/kernels/CameraRays.h": """
            GLOBAL_KERNEL_SIGNATURE(void) __launch_bounds__(64)
            CameraRays(HIPRTRenderData render_data) {
                render_data.accum[threadIdx.x] = make_float4(1.0f);
            }
            """,
            "src/Util/Unrelated.cpp": "int helper(){ return 1; }",
        },
        focus="src/main.cpp",
    )

    assert "// FILE: src/Device/kernels/CameraRays.h" in context
    assert "// FILE: src/Device/GPUKernel.cpp" in context
    assert "GLOBAL_KERNEL_SIGNATURE" in context
    assert "oroModuleLaunchKernel" in context


def test_source_device_preservation_contract_follows_device_headers():
    contract = _source_device_preservation_contract(
        {
            "src/gpu/kernels.hip": '#include "particle_api.hpp"\nextern "C" __global__ void k(float* x) { x[0] += kGain; }',
            "src/gpu/particle_api.hpp": '#pragma once\n#include "../config/device_constants.hpp"\nstruct LaunchParams { int n; };',
            "src/config/device_constants.hpp": "#pragma once\nconstexpr float kGain = 1.0f;",
            "src/app/main.cpp": "int main() { return 0; }",
        }
    )

    assert "src/gpu/kernels.hip" in contract
    assert "src/gpu/particle_api.hpp" in contract
    assert "src/config/device_constants.hpp" in contract
    assert "kGain" in contract
    assert "For core/gui/shared/host_runner, do not include original project headers" in contract
    assert "For the device role only" in contract


def test_source_device_preservation_contract_includes_runtime_compiled_kernel_headers():
    contract = _source_device_preservation_contract(
        {
            "src/Device/kernels/CameraRays.h": """
            #include "CameraCommon.h"
            GLOBAL_KERNEL_SIGNATURE(void) __launch_bounds__(64)
            CameraRays(HIPRTRenderData render_data) {
                render_data.accum[threadIdx.x] = kCameraGain;
            }
            """,
            "src/Device/kernels/CameraCommon.h": "#pragma once\nconstexpr float kCameraGain = 0.5f;",
        }
    )

    assert "src/Device/kernels/CameraRays.h" in contract
    assert "src/Device/kernels/CameraCommon.h" in contract
    assert "Required original kernels: CameraRays." in contract
    assert "device-role preservation and HMR mapping only" in contract
    assert "not a request to synthesize host launches" in contract
    assert "kCameraGain" in contract


def test_source_device_preservation_contract_ignores_commented_kernel_examples():
    contract = _source_device_preservation_contract(
        {
            "src/Device/includes/FixIntellisense.h": """
            // extern "C" void __global__ my_function(...)
            /* GLOBAL_KERNEL_SIGNATURE(void) FakeKernel(RenderData data) {} */
            #define GLOBAL_KERNEL_SIGNATURE(returnType) extern "C" returnType __global__
            """,
            "src/Device/kernels/CameraRays.h": """
            #include "../includes/FixIntellisense.h"
            // constexpr float kFakeConstant = 99.0f;
            constexpr float kCameraGain = 0.5f;
            GLOBAL_KERNEL_SIGNATURE(void) CameraRays(float* out) {
                out[threadIdx.x] = kCameraGain;
            }
            """,
        }
    )

    assert "Required original kernels: CameraRays." in contract
    assert "my_function" not in contract
    assert "FakeKernel" not in contract
    assert "kFakeConstant" not in contract
    assert "kCameraGain" in contract


def test_source_device_preservation_contract_omits_lower_priority_headers_with_reason(monkeypatch):
    monkeypatch.setattr(kernel_splitter, "_DEVICE_PRESERVATION_TOTAL_MAX_CHARS", 900)
    monkeypatch.setattr(kernel_splitter, "_DEVICE_PRESERVATION_PER_FILE_MAX_CHARS", 400)
    files = {
        "src/Device/kernels/Root.h": (
            '#include "Support0.h"\n'
            "GLOBAL_KERNEL_SIGNATURE(void) RootKernel(float* out) { out[threadIdx.x] = kRoot; }"
        ),
        "src/Device/kernels/Support0.h": '#include "Support1.h"\nconstexpr float kRoot = 1.0f;\n',
    }
    for index in range(1, 12):
        files[f"src/Device/kernels/Support{index}.h"] = (
            f'#include "Support{index + 1}.h"\n'
            f"constexpr float kSupport{index} = {index}.0f;\n"
            + ("float padding_value = 1.0f;\n" * 20)
        )

    contract = _source_device_preservation_contract(files, roots=["src/Device/kernels/Root.h"])

    assert "src/Device/kernels/Root.h" in contract
    assert "Omitted lower-priority device-reachable files" in contract
    assert "prompt-budget exclusion after device-anchor ranking" in contract


def test_scoped_source_context_does_not_pull_every_gpu_marker_without_roots():
    source_files = {
        "src/main.cpp": "int main(){ return 0; }",
        "src/Device/kernels/Selected.h": "GLOBAL_KERNEL_SIGNATURE(void) Selected(float* out) { out[0] = 1.0f; }",
        "src/Device/kernels/Unrelated.h": "GLOBAL_KERNEL_SIGNATURE(void) Unrelated(float* out) { out[0] = 2.0f; }",
    }
    report = {
        "included": [
            {"path": "src/main.cpp"},
            {"path": "src/Device/kernels/Selected.h"},
        ],
        "deviceTuTopology": {"deviceTranslationUnits": []},
    }

    scoped = _source_files_scoped_to_context(source_files, report)

    assert "src/Device/kernels/Selected.h" in scoped
    assert "src/Device/kernels/Unrelated.h" not in scoped

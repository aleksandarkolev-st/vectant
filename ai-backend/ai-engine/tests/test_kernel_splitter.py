"""Unit tests for agents/kernel_splitter.py — parser + prompt build.

We don't exercise `run_kernel_splitter` here because it hits an LLM
provider; the parser + verifier composition is exhaustively tested
through `parse_kernel_split_response` + `verify_split_output`.
"""

import pytest
import asyncio

from agents.gpu_detect import GpuDetectionResult, GpuDetectionEvidence
from agents.kernel_splitter import (
    KernelSplitProviderError,
    KernelSplitterError,
    KernelSplitterUnsupportedProjectError,
    build_split_retry_prompt,
    _project_source_context,
    _source_device_preservation_contract,
    build_prompt,
    parse_kernel_split_response,
    run_kernel_splitter,
    split_failure_verification,
    split_provider_failure_verification,
    split_agentic_report,
    split_attempt_record,
)
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


def test_build_prompt_attaches_extra_instructions():
    p = build_prompt("x", extra_instructions="don't change kernel names")
    assert "EXTRA INSTRUCTIONS" in p
    assert "don't change kernel names" in p


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
    assert "Do not include these original project headers" in contract

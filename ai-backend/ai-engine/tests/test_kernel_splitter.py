"""Unit tests for agents/kernel_splitter.py — parser + prompt build.

We don't exercise `run_kernel_splitter` here because it hits an LLM
provider; the parser + verifier composition is exhaustively tested
through `parse_kernel_split_response` + `verify_split_output`.
"""

import pytest

from agents.gpu_detect import GpuDetectionResult, GpuDetectionEvidence
from agents.kernel_splitter import (
    KernelSplitterError,
    build_prompt,
    parse_kernel_split_response,
)


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


def test_build_prompt_attaches_extra_instructions():
    p = build_prompt("x", extra_instructions="don't change kernel names")
    assert "EXTRA INSTRUCTIONS" in p
    assert "don't change kernel names" in p

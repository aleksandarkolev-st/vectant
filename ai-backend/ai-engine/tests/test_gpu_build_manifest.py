"""Unit tests for the GPU sub-block in BuildManifest.

Spec: docs/GPU_HMR_ULTRAPLAN.md §5.1. The tests assert that:

  - existing host-only manifests still validate (the GPU extension is
    fully opt-in — `gpu: Optional[...] = None`),
  - a well-formed CUDA manifest validates,
  - a well-formed ROCm manifest validates,
  - the validator rejects every documented misconfiguration (wrong
    vendor, wrong compiler, vendor↔compiler mismatch, embedded
    fatbin strategy, empty arch list).
"""

import json
import pytest

from build_manifest import (
    BuildManifest,
    ManifestRejection,
    normalize_gpu_split_manifest,
    parse_manifest,
    validate_manifest_v1,
)


HOST_ONLY_MANIFEST = {
    "compiler": "g++",
    "std": "c++26",
    "common_flags": ["-shared", "-fPIC"],
    "core_link_flags": [],
    "gui_link_flags": ["-lSDL2"],
    "shared_link_flags": [],
    "runner_link_flags": ["-lSDL2", "-ldl"],
    "files": ["shared.h", "core.cpp", "gui.cpp", "host_runner.cpp"],
    "system_packages": [],
    "hot_reload_mode": "swap",
    "confidence": {
        "overall": "high",
        "runner_synthesis": "high",
        "link_flags": "high",
        "notes": "",
    },
}


def _with_gpu(**overrides):
    base = dict(HOST_ONLY_MANIFEST)
    gpu = {
        "vendor": "cuda",
        "device_compiler": "nvcc",
        "arch": ["sm_80"],
        "device_flags": ["-O3", "-lineinfo"],
        "runtime_libs": ["cudart"],
        "snapshot_mode": "auto",
        "fatbin_strategy": "sidecar_module",
    }
    gpu.update(overrides)
    base["gpu"] = gpu
    return base


def test_host_only_manifest_still_validates():
    m = parse_manifest(HOST_ONLY_MANIFEST)
    assert m.gpu is None
    assert m.files == ["shared.h", "core.cpp", "gui.cpp", "host_runner.cpp"]
    validate_manifest_v1(m)  # no raise


def test_module_files_accept_dynamic_role_paths():
    raw = dict(HOST_ONLY_MANIFEST)
    raw["files"] = [
        "include/flow_shared_x.h",
        "src/flow_core_x.cpp",
        "src/flow_gui_x.cpp",
        "run/flow_runner_x.cpp",
        "gpu/flow_device_x.hip",
        "include/flow_palette_x.h",
    ]
    raw["module_files"] = {
        "shared": "include/flow_shared_x.h",
        "core": "src/flow_core_x.cpp",
        "gui": "src/flow_gui_x.cpp",
        "host_runner": "run/flow_runner_x.cpp",
        "device": "gpu/flow_device_x.hip",
    }
    m = parse_manifest(raw)
    assert m.module_files.core == "src/flow_core_x.cpp"
    assert m.module_files.device == "gpu/flow_device_x.hip"
    validate_manifest_v1(m)


def test_cuda_manifest_validates():
    m = parse_manifest(_with_gpu(vendor="cuda", device_compiler="nvcc"))
    assert m.gpu is not None
    assert m.gpu.vendor == "cuda"
    assert m.gpu.arch == ["sm_80"]
    validate_manifest_v1(m)


def test_rocm_manifest_validates():
    m = parse_manifest(
        _with_gpu(
            vendor="rocm",
            device_compiler="hipcc",
            arch=["gfx90a"],
            runtime_libs=["amdhip64"],
        )
    )
    assert m.gpu is not None
    assert m.gpu.vendor == "rocm"
    validate_manifest_v1(m)


def test_clang_cuda_is_valid_for_cuda():
    m = parse_manifest(_with_gpu(vendor="cuda", device_compiler="clang-cuda"))
    validate_manifest_v1(m)


def test_rejects_cuda_with_hipcc():
    m = parse_manifest(_with_gpu(vendor="cuda", device_compiler="hipcc"))
    with pytest.raises(ManifestRejection, match="vendor=cuda"):
        validate_manifest_v1(m)


def test_rejects_rocm_with_nvcc():
    m = parse_manifest(_with_gpu(vendor="rocm", device_compiler="nvcc", arch=["gfx90a"]))
    with pytest.raises(ManifestRejection, match="vendor=rocm"):
        validate_manifest_v1(m)


def test_rejects_empty_arch():
    m = parse_manifest(_with_gpu(arch=[]))
    with pytest.raises(ManifestRejection, match="arch must not be empty"):
        validate_manifest_v1(m)


def test_rejects_unsupported_fatbin_strategy():
    # The schema only allows "sidecar_module", but a forward-compat or
    # malformed manifest could pass "embedded". Pydantic should reject
    # at schema level OR our validator should reject — assert one path
    # surfaces an error so the user gets a clean message.
    raw = _with_gpu()
    raw["gpu"]["fatbin_strategy"] = "embedded"
    with pytest.raises((ManifestRejection, Exception)):
        m = parse_manifest(raw)
        validate_manifest_v1(m)


def test_gpu_field_round_trips_through_json():
    raw = _with_gpu()
    payload = json.dumps(raw)
    m = parse_manifest(payload)
    assert m.gpu is not None
    assert m.gpu.device_compiler == "nvcc"


def test_normalizes_ai_gpu_manifest_defaults_for_rocm():
    raw = {
        "compiler": "hipcc",
        "files": ["shared.h", "core.cpp", "gui.cpp", "host_runner.cpp", "device.hip"],
        "gpu": {
            "vendor": "rocm",
            "device_flags": [
                "-O3",
                "-lineinfo",
                "--use_fast_math",
                "--generate-code=arch=compute_80,code=sm_80",
            ],
        },
    }
    normalized = normalize_gpu_split_manifest(
        raw,
        split_files={
            "shared.h": "",
            "core.cpp": "",
            "gui.cpp": "#include <SDL2/SDL.h>",
            "host_runner.cpp": "",
            "device.hip": "",
        },
        vendor_hint="rocm",
        arch_hint="gfx1201",
    )
    parsed = parse_manifest(normalized)
    validate_manifest_v1(parsed)
    assert parsed.compiler == "clang++"
    assert parsed.gpu is not None
    assert parsed.gpu.vendor == "rocm"
    assert parsed.gpu.device_compiler == "hipcc"
    assert parsed.gpu.arch == ["gfx1201"]
    assert parsed.confidence.overall == "high"
    assert "-I/opt/rocm/include" in parsed.common_flags
    assert "-lamdhip64" in parsed.core_link_flags
    assert "-lSDL2" in parsed.gui_link_flags
    assert "-ldl" in parsed.runner_link_flags
    assert "--use_fast_math" not in parsed.gpu.device_flags
    assert "--generate-code=arch=compute_80,code=sm_80" not in parsed.gpu.device_flags
    assert "-O3" in parsed.gpu.device_flags
    assert "-lineinfo" in parsed.gpu.device_flags


def test_normalizes_glfw_opengl_gpu_manifest_link_flags():
    normalized = normalize_gpu_split_manifest(
        {"gpu": {"vendor": "rocm"}, "gui_link_flags": [], "runner_link_flags": []},
        split_files={
            "shared.h": "",
            "core.cpp": "",
            "gui.cpp": """
                #include <GLFW/glfw3.h>
                #include <GL/gl.h>
                void render(GLFWwindow* window) {
                    glClear(GL_COLOR_BUFFER_BIT);
                    glBegin(GL_POINTS);
                    glVertex2f(0.0f, 0.0f);
                    glEnd();
                }
            """,
            "host_runner.cpp": """
                #include <GLFW/glfw3.h>
                #pragma comment(lib, "glfw")
                int main() {
                    glfwInit();
                    return 0;
                }
            """,
            "device.hip": "",
        },
        vendor_hint="rocm",
        arch_hint="gfx1201",
    )
    parsed = parse_manifest(normalized)
    validate_manifest_v1(parsed)
    assert "-lglfw" in parsed.gui_link_flags
    assert "-lglfw" in parsed.runner_link_flags
    assert "-lGL" in parsed.gui_link_flags
    assert "-lGL" in parsed.runner_link_flags


def test_normalizes_ai_gpu_manifest_defaults_for_cuda_dynamic_paths():
    normalized = normalize_gpu_split_manifest(
        {"gpu": {"vendor": "cuda"}},
        split_files={
            "include/flow_shared_x.h": "",
            "src/flow_core_x.cpp": "",
            "src/flow_gui_x.cpp": "",
            "run/flow_runner_x.cpp": "",
            "gpu/flow_device_x.cu": "",
        },
        vendor_hint="cuda",
        arch_hint="sm_120",
    )
    parsed = parse_manifest(normalized)
    validate_manifest_v1(parsed)
    assert parsed.gpu is not None
    assert parsed.gpu.arch == ["sm_120"]
    assert parsed.module_files.device == "gpu/flow_device_x.cu"
    assert parsed.module_files.host_runner == "run/flow_runner_x.cpp"
    assert "-I/usr/local/cuda/include" in parsed.common_flags
    assert "-lcudart" in parsed.runner_link_flags


def test_runtime_arch_hint_overrides_ai_gpu_arch_guess():
    normalized = normalize_gpu_split_manifest(
        {"gpu": {"vendor": "rocm", "arch": ["gfx90a"]}},
        split_files={
            "shared.h": "",
            "core.cpp": "",
            "gui.cpp": "",
            "host_runner.cpp": "",
            "device.hip": "",
        },
        vendor_hint="rocm",
        arch_hint="gfx1201",
    )
    parsed = parse_manifest(normalized)
    validate_manifest_v1(parsed)
    assert parsed.gpu is not None
    assert parsed.gpu.arch == ["gfx1201"]

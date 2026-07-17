"""Unit tests for agents/gpu_detect.py.

Spec: docs/GPU_HMR_ULTRAPLAN.md §5.6 item 1. The agent is the entry
point for the GPU pipeline so its precision/recall directly determines
which projects even reach the Kernel Splitter. We test:

  - true negatives: ordinary C++ projects with `__global__` in comments,
    string literals, or in identifier prefixes don't trip the detector,
  - true positives: CUDA `<<<...>>>` launches, `__global__` qualifiers,
    `cudaMalloc` calls,
  - vendor hint resolution: includes win, API hits break ties, both
    sides → ambiguous, bare qualifier → ambiguous.
"""

from agents.gpu_detect import detect_file, detect_project


# ─────────────────────────────────────────────────────────────────────────────
# True negatives
# ─────────────────────────────────────────────────────────────────────────────


def test_pure_cpp_is_not_gpu():
    src = """
    #include <iostream>
    int main() {
        std::cout << "hello" << std::endl;
        return 0;
    }
    """
    ev = detect_file(src)
    assert not ev.is_gpu_evidence


def test_global_in_comment_is_ignored():
    src = """
    // we used to have __global__ kernels here
    int main() { return 0; }
    """
    ev = detect_file(src)
    assert ev.qualifier_hits == 0


def test_global_in_string_literal_is_ignored():
    src = """
    const char* doc = "use __global__ for kernels and <<<grid, block>>> to launch";
    int main() { return 0; }
    """
    ev = detect_file(src)
    assert ev.qualifier_hits == 0
    assert ev.launch_chevron_hits == 0


def test_block_comment_strip():
    src = """
    /* old API:
       __global__ void foo() {}
       cudaMalloc(&p, 1024);
     */
    int main() { return 0; }
    """
    ev = detect_file(src)
    assert ev.qualifier_hits == 0
    assert ev.cuda_api_hits == 0


def test_identifier_prefix_no_match():
    src = """
    struct Stats { int my__global___count; };
    void cudaMallocAtRuntime_metric() {}  // ends in different ident
    """
    ev = detect_file(src)
    assert ev.qualifier_hits == 0


# ─────────────────────────────────────────────────────────────────────────────
# True positives
# ─────────────────────────────────────────────────────────────────────────────


def test_global_qualifier_detected():
    src = """
    __global__ void vec_add(const float* a, const float* b, float* c, int n) {
        int i = blockIdx.x * blockDim.x + threadIdx.x;
        if (i < n) c[i] = a[i] + b[i];
    }
    """
    ev = detect_file(src)
    assert ev.qualifier_hits >= 1


def test_launch_chevron_detected():
    src = """
    void launch(int n, const float* a, const float* b, float* c) {
        vec_add<<<(n + 255) / 256, 256>>>(a, b, c, n);
    }
    """
    ev = detect_file(src)
    assert ev.launch_chevron_hits == 1


def test_cuda_api_detected():
    src = """
    void alloc(float** p) {
        cudaMalloc((void**)p, 1024 * sizeof(float));
    }
    """
    ev = detect_file(src)
    assert ev.cuda_api_hits == 1


def test_hip_api_detected():
    src = """
    void alloc(float** p) {
        hipMalloc((void**)p, 1024 * sizeof(float));
    }
    """
    ev = detect_file(src)
    assert ev.hip_api_hits == 1


def test_cuda_include_detected():
    src = """
    #include <cuda_runtime.h>
    int main() { return 0; }
    """
    ev = detect_file(src)
    assert ev.cuda_include_hits == 1


def test_hip_include_detected():
    src = """
    #include <hip/hip_runtime.h>
    int main() { return 0; }
    """
    ev = detect_file(src)
    assert ev.hip_include_hits == 1


def test_opencl_kernel_detected():
    src = """
    __kernel void update(__global float* output) {
        output[get_global_id(0)] = 1.0f;
    }
    """
    ev = detect_file(src)
    assert ev.opencl_hits >= 3


def test_portable_shader_and_runtime_markers_are_detected():
    cases = {
        "shader.wgsl": (
            "@compute @workgroup_size(8) fn main() {}",
            "webgpu_wgsl",
        ),
        "shader.comp": (
            "#version 450\nlayout(local_size_x=8) in; void main() { uint x = gl_GlobalInvocationID.x; }",
            "glsl",
        ),
        "shader.hlsl": (
            "[numthreads(8,1,1)] void main(uint3 id: SV_DispatchThreadID) {}",
            "hlsl",
        ),
        "queue.cpp": (
            "#include <sycl/sycl.hpp>\nvoid run() { sycl::queue queue; }",
            "sycl",
        ),
        "vulkan.cpp": (
            "void build() { vkCreateShaderModule(device, &info, nullptr, &module); }",
            "vulkan",
        ),
        "webgpu.ts": (
            "const module = device.createShaderModule({ code });",
            "webgpu",
        ),
    }
    for path, (source, backend_hint) in cases.items():
        result = detect_project({path: source})
        assert result.is_gpu is True
        assert backend_hint in result.backend_hints


def test_portable_gpu_markers_in_comments_and_strings_are_ignored():
    source = """
    // __kernel void old_kernel(__global float* output) {}
    const char* shader = "@compute get_global_id(0) vkCmdDispatch()";
    int main() { return 0; }
    """
    assert detect_project({"main.cpp": source}).is_gpu is False


# ─────────────────────────────────────────────────────────────────────────────
# Project-level + vendor hint
# ─────────────────────────────────────────────────────────────────────────────


def test_project_host_only_returns_false():
    files = {
        "main.cpp": "int main() { return 0; }",
        "util.h": "void noop();",
    }
    r = detect_project(files)
    assert r.is_gpu is False
    assert r.vendor_hint is None


def test_project_cuda_via_include():
    files = {
        "device.cu": "#include <cuda_runtime.h>\n__global__ void k() {}",
    }
    r = detect_project(files)
    assert r.is_gpu is True
    assert r.vendor_hint == "cuda"


def test_project_rocm_via_include():
    files = {
        "device.hip": "#include <hip/hip_runtime.h>\n__global__ void k() {}",
    }
    r = detect_project(files)
    assert r.is_gpu is True
    assert r.vendor_hint == "rocm"


def test_project_ambiguous_when_both_vendors_present():
    files = {
        "kernel.cu": "#include <cuda_runtime.h>\n__global__ void k() {}",
        "other.hip": "#include <hip/hip_runtime.h>\n__global__ void k2() {}",
    }
    r = detect_project(files)
    assert r.is_gpu is True
    assert r.vendor_hint == "ambiguous"


def test_project_bare_qualifier_only_is_ambiguous():
    files = {
        "device.cu": "__global__ void k() {}",
    }
    r = detect_project(files)
    assert r.is_gpu is True
    assert r.vendor_hint == "ambiguous"


def test_project_cuda_via_api_only():
    files = {
        "device.cu": "void prep() { cudaMalloc(0, 16); cudaFree(0); }",
    }
    r = detect_project(files)
    assert r.is_gpu is True
    assert r.vendor_hint == "cuda"


def test_to_dict_shape():
    files = {
        "device.cu": "#include <cuda_runtime.h>\n__global__ void k() {}",
        "main.cpp": "int main() { return 0; }",
    }
    r = detect_project(files).to_dict()
    assert r["is_gpu"] is True
    assert r["vendor_hint"] == "cuda"
    assert r["backend_hints"] == ["cuda", "cuda_or_hip"]
    assert "device.cu" in r["per_file"]
    # main.cpp had no evidence, so it's excluded from per_file in the
    # serialized form (keeps the response shape tight for the prompt).
    assert "main.cpp" not in r["per_file"]


def test_opencl_project_is_vendor_neutral_and_backend_typed():
    result = detect_project({
        "kernel.cl": "__kernel void k(__global float* output) { output[get_global_id(0)] = 1.0f; }",
    })
    assert result.is_gpu is True
    assert result.vendor_hint == "ambiguous"
    assert result.backend_hints == ("opencl",)
    assert result.to_dict()["backend_hints"] == ["opencl"]

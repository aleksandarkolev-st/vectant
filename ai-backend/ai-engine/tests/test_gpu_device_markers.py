from agents.abi_stamper import mask_comments_for_parsing
from agents.gpu_device_markers import has_gpu_device_marker
from agents.gpu_split_repair import _source_device_files as repair_source_device_files
from verifier_gpu import _source_device_files as verifier_source_device_files


def test_gpu_device_marker_detects_project_defined_device_macros():
    masked = mask_comments_for_parsing(
        """
        // PROJECT_DEVICE_API void ignored();
        PROJECT_DEVICE_API bool filter_value(int value);
        GENERIC_GPU_DEVICE inline int helper(int value) { return value + 1; }
        """
    )

    assert has_gpu_device_marker(masked)
    assert "ignored" not in masked


def test_gpu_device_marker_rejects_host_words_and_platform_constants():
    source = """
    int membership = 1;
    int shipping_cost = 2;
    int gpu_count = 3;
    constexpr int GPU_COUNT = 4;
    constexpr int CUDA_VERSION = 12000;
    constexpr int HIP_VERSION = 700200000;
    constexpr int OPENCL_TARGET_VERSION = 300;
    constexpr int SHADER_COUNT = 5;
    constexpr int DEVICE_COUNT = 6;
    constexpr int KERNEL_VERSION = 7;
    const char* text = "PROJECT_DEVICE_API void fake_kernel();";
    #define __host__
    __host__ int host_only(int value) { return value; }
    """

    assert not has_gpu_device_marker(mask_comments_for_parsing(source))


def test_gpu_device_marker_requires_macro_declaration_or_concrete_definition():
    source = """
    #define PROJECT_DEVICE_API __device__
    #define PROJECT_GPU_API PROJECT_DEVICE_API
    #define DEVICE_COUNT 4
    #define KERNEL_VERSION 7
    PROJECT_GPU_API
    int transform(int value);
    """

    assert has_gpu_device_marker(mask_comments_for_parsing(source))


def test_source_device_file_detection_uses_generic_device_macro():
    source_files = {
        "units/device-callbacks.payload": (
            '#include "support/opaque-dependency.data"\n'
            "PROJECT_DEVICE_API bool filter_value(int value);\n"
            "GENERIC_GPU_DEVICE inline int helper(int value) { return value + 1; }\n"
        ),
        "support/opaque-dependency.data": "struct DeviceRecord { int value; };\n",
        "units/host-only.payload": "inline int host_helper(int value) { return value; }\n",
    }

    repair_scope = repair_source_device_files(source_files)
    verifier_scope = verifier_source_device_files(source_files)

    assert "units/device-callbacks.payload" in repair_scope
    assert "units/device-callbacks.payload" in verifier_scope
    assert "support/opaque-dependency.data" in repair_scope
    assert "support/opaque-dependency.data" in verifier_scope
    assert "units/host-only.payload" not in repair_scope
    assert "units/host-only.payload" not in verifier_scope


def test_gpu_device_marker_detects_portable_backend_syntax():
    sources = [
        "__kernel void k(__global float* out) { out[get_global_id(0)] = 1.0f; }",
        "@compute @workgroup_size(8) fn main() {}",
        "layout(local_size_x=8) in; void main() { uint x = gl_GlobalInvocationID.x; }",
        "[numthreads(8,1,1)] void main(uint3 id: SV_DispatchThreadID) {}",
        "void run() { sycl::queue queue; }",
        "void build() { vkCreateShaderModule(device, &info, 0, &module); }",
        "const module = device.createShaderModule({ code });",
    ]
    for source in sources:
        assert has_gpu_device_marker(mask_comments_for_parsing(source))

from agents.abi_stamper import constant_layout_hash, normalize_param_list, stamp_device_source


DEVICE_SOURCE = """
__constant__ float alpha[1];
__global__ void vec_add(const float* a, const float* b, float* c, int n) {}
"""


def test_param_normalization_drops_names():
    assert normalize_param_list("const float* a, float * out, int n") == "const float*,float*,int"


def test_stamp_changes_when_signature_changes():
    before = stamp_device_source(DEVICE_SOURCE)
    after = stamp_device_source(
        DEVICE_SOURCE.replace("int n)", "int n, float scale)")
    )
    assert before["vec_add"] != after["vec_add"]


def test_constant_layout_hash_changes_on_constant_edit():
    before = constant_layout_hash(DEVICE_SOURCE)
    after = constant_layout_hash(DEVICE_SOURCE.replace("float alpha[1]", "float2 alpha[1]"))
    assert before != after


def test_constant_layout_hash_includes_device_globals():
    before = constant_layout_hash("__device__ int counter;\n__global__ void k() {}")
    after = constant_layout_hash("__device__ long counter;\n__global__ void k() {}")
    assert before != after

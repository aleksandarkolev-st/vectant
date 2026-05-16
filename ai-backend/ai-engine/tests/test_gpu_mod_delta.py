import json

from agents.gpu_mod_delta import (
    GpuDiffPatchRequest,
    build_gpu_diff_patch_prompt,
    classify_mod_delta,
    parse_gpu_diff_response,
)


BASE = {
    "core.cpp": "void step(){ synthi_gpu_launch(gpu, \"vec_add\", 1, 256, 0, stream, { &a, &b, &c, &n }); }",
    "device.cu": "__global__ void vec_add(const float* a, const float* b, float* c, int n){ c[0]=a[0]+b[0]; }",
}


def test_device_body_change_is_device_only():
    changed = dict(BASE)
    changed["device.cu"] = BASE["device.cu"].replace("+", "*")
    result = classify_mod_delta(BASE, changed)
    assert result.reload_plan == "device_only"


def test_signature_change_is_abi_breaking():
    changed = dict(BASE)
    changed["device.cu"] = BASE["device.cu"].replace("int n)", "int n, float scale)")
    result = classify_mod_delta(BASE, changed)
    assert result.reload_plan == "abi_breaking"


def test_host_and_device_body_change_is_mixed():
    changed = dict(BASE)
    changed["core.cpp"] = BASE["core.cpp"].replace("256", "128")
    changed["device.cu"] = BASE["device.cu"].replace("+", "*")
    result = classify_mod_delta(BASE, changed)
    assert result.reload_plan == "mixed"


def test_parse_gpu_diff_response_normalizes_device_file_module():
    raw = json.dumps(
        {
            "reload_plan": "device_only",
            "edits": [
                {
                    "module": "device.cu",
                    "operation": "replace",
                    "anchor": "a+b",
                    "content": "a*b",
                }
            ],
        }
    )
    parsed = parse_gpu_diff_response(raw)
    assert parsed["edits"][0]["module"] == "device"


def test_gpu_prompt_contains_runtime_boundary_rule():
    prompt = build_gpu_diff_patch_prompt(GpuDiffPatchRequest(diff="@@"))
    assert "synthi_gpu_launch" in prompt
    assert "reload_plan" in prompt

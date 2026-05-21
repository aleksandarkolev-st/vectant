import json

from agents.gpu_mod_delta import (
    GpuDiffPatchRequest,
    build_gpu_diff_patch_retry_prompt,
    build_gpu_diff_patch_prompt,
    classify_mod_delta,
    gpu_diff_patch_anchor_failures,
    gpu_diff_patch_content_failures,
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


def test_gpu_prompt_requires_generated_role_anchors():
    prompt = build_gpu_diff_patch_prompt(GpuDiffPatchRequest(diff="@@"))
    assert "CURRENT generated role files" in prompt
    assert "original user source" in prompt


def test_gpu_delta_anchor_verifier_rejects_user_source_only_anchor():
    req = GpuDiffPatchRequest(
        diff="- vx[i] += force;\n+ vx[i] -= force;",
        device_content="extern \"C\" __global__ void step(float* vx) { vx[i] += generated_force; }",
    )
    failures = gpu_diff_patch_anchor_failures(
        req,
        [
            {
                "module": "device",
                "operation": "replace",
                "anchor": "vx[i] += force;",
                "content": "vx[i] -= force;",
            }
        ],
    )
    assert failures
    assert failures[0]["reason"] == "anchor_missing"


def test_gpu_delta_anchor_verifier_accepts_generated_device_anchor():
    req = GpuDiffPatchRequest(
        diff="- vx[i] += force;\n+ vx[i] -= force;",
        device_content="extern \"C\" __global__ void step(float* vx) { vx[i] += generated_force; }",
    )
    failures = gpu_diff_patch_anchor_failures(
        req,
        [
            {
                "module": "device",
                "operation": "replace",
                "anchor": "vx[i] += generated_force;",
                "content": "vx[i] -= generated_force;",
            }
        ],
    )
    assert failures == []


def test_gpu_delta_retry_prompt_explains_anchor_rejection():
    prompt = build_gpu_diff_patch_retry_prompt(
        "base prompt",
        [
            {
                "index": 0,
                "module": "device",
                "reason": "anchor_missing",
                "anchor": "vx[i] += force;",
                "match_count": 0,
            }
        ],
    )
    assert "DETERMINISTIC VERIFIER REJECTION" in prompt
    assert "CURRENT generated device role" in prompt
    assert "vx[i] += force;" in prompt


def test_gpu_delta_content_verifier_rejects_project_header_include():
    req = GpuDiffPatchRequest(
        diff="@@",
        compile_manifest={
            "module_files": {
                "shared": ".synthi/generated/gpu/shared.h",
                "core": ".synthi/generated/gpu/core.cpp",
                "gui": ".synthi/generated/gpu/gui.cpp",
                "host_runner": ".synthi/generated/gpu/host_runner.cpp",
                "device": ".synthi/generated/gpu/device.hip",
            }
        },
    )
    failures = gpu_diff_patch_content_failures(
        req,
        [
            {
                "module": "core",
                "operation": "insert_after",
                "anchor": "#include <hip/hip_runtime.h>",
                "content": '\n#include "Device/includes/AdaptiveSampling.h"\n',
            }
        ],
    )
    assert failures
    assert failures[0]["reason"] == "generated_role_includes_project_header"


def test_gpu_delta_content_verifier_allows_generated_role_include():
    req = GpuDiffPatchRequest(diff="@@")
    failures = gpu_diff_patch_content_failures(
        req,
        [
            {
                "module": "core",
                "operation": "insert_after",
                "anchor": "#include <stdint.h>",
                "content": '\n#include "shared.h"\n#include "synthi_gpu_runtime.h"\n',
            }
        ],
    )
    assert failures == []

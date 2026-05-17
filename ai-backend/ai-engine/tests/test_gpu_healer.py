import json

import pytest

from agents.gpu_healer import GpuHealRequest, build_gpu_heal_prompt, parse_gpu_heal_response


def test_build_heal_prompt_selects_runtime_prompt_and_restart_flag():
    req = GpuHealRequest(
        tier="runtime",
        error={"kind": "cudaErrorIllegalAddress", "raw": "illegal address"},
        kernel_sig_hashes={"vec_add": "0x1"},
    )
    prompt, triage = build_gpu_heal_prompt(req)
    assert "Tier: runtime" in prompt
    assert "cudaErrorIllegalAddress" in prompt
    assert triage["requires_restart"]


def test_parse_heal_response_rejects_wrapper_kernel():
    req = GpuHealRequest(
        tier="runtime",
        kernel_sig_hashes={"vec_add": "0x1"},
        existing_device_source="__global__ void vec_add(float* out, int n) { out[0] = 1; }",
        host_launch_sites={"vec_add": "synthi_gpu_launch(gpu, \"vec_add\", 1, 1, 0, stream, { &out, &n });"},
    )
    raw = json.dumps(
        {
            "edits": [
                {
                    "module": "device",
                    "operation": "insert_after",
                    "anchor": "}",
                    "content": "__global__ void vec_add_safe(float* out, int n) {}",
                }
            ]
        }
    )
    with pytest.raises(Exception):
        parse_gpu_heal_response(raw, req)


def test_parse_heal_response_accepts_in_place_device_edit():
    req = GpuHealRequest(
        tier="runtime",
        kernel_sig_hashes={"vec_add": "0x1"},
        existing_device_source="__global__ void vec_add(float* out, int n) { out[0] = 1; }",
    )
    raw = json.dumps(
        {
            "edits": [
                {
                    "module": "device",
                    "operation": "replace",
                    "anchor": "out[0] = 1;",
                    "content": "if (n > 0) out[0] = 1;",
                }
            ]
        }
    )
    parsed = parse_gpu_heal_response(raw, req)
    assert parsed["edits"][0]["module"] == "device"

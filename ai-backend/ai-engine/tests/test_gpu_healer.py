import json

import pytest

from agents.gpu_healer import GpuHealRequest, build_gpu_heal_prompt, parse_gpu_heal_response


MODULE_FILES = {
    "shared": "generated/contracts/state.payload",
    "core": "generated/runtime/update.payload",
    "gui": "generated/presentation/frame.payload",
    "host_runner": "generated/process/entry.payload",
    "device": "generated/accelerator/kernels.payload",
}
PROJECT_FILES = list(MODULE_FILES.values())


def heal_request(**overrides):
    values = {
        "project_files": PROJECT_FILES,
        "module_files": MODULE_FILES,
    }
    values.update(overrides)
    return GpuHealRequest(**values)


def test_build_heal_prompt_selects_runtime_prompt_and_restart_flag():
    req = heal_request(
        tier="runtime",
        error={"kind": "cudaErrorIllegalAddress", "raw": "illegal address"},
        kernel_sig_hashes={"vec_add": "0x1"},
    )
    prompt, triage = build_gpu_heal_prompt(req)
    assert "Tier: runtime" in prompt
    assert "cudaErrorIllegalAddress" in prompt
    assert "generated/accelerator/kernels.payload" in prompt
    assert triage["requires_restart"]


def test_parse_heal_response_rejects_wrapper_kernel():
    req = heal_request(
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
    req = heal_request(
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


def test_heal_request_requires_complete_explicit_module_roles():
    with pytest.raises(Exception):
        GpuHealRequest(
            project_files=PROJECT_FILES,
            module_files={"device": MODULE_FILES["device"]},
        )


def test_heal_request_rejects_unknown_module_role_declaration():
    module_files = dict(MODULE_FILES)
    module_files["shadow"] = "generated/unknown/role.payload"

    with pytest.raises(Exception):
        heal_request(module_files=module_files)


def test_build_heal_prompt_rejects_unsubmitted_role_path_before_model_call():
    module_files = dict(MODULE_FILES)
    module_files["device"] = "generated/accelerator/unsubmitted.payload"
    req = heal_request(module_files=module_files)

    with pytest.raises(Exception) as exc_info:
        build_gpu_heal_prompt(req)

    assert "heal_module_role_not_in_project_files" in str(exc_info.value)

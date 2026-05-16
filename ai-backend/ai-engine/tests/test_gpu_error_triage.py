from agents.gpu_error_triage import triage_gpu_error


def test_hard_compile_error_routes_to_compile_prompt():
    result = triage_gpu_error({"exit_code": 1, "stderr": "nvcc error: identifier x is undefined"})
    assert result.tier == "compile_hard"
    assert result.prompt_name == "GPU_HEAL_COMPILE_PROMPT"


def test_ptxas_spill_routes_to_perf_prompt():
    result = triage_gpu_error({"diagnostics": {"records": [{"registers": 64, "spill_stores": 24}]}})
    assert result.tier == "compile_soft"
    assert result.reason == "ptxas-spill"


def test_illegal_address_runtime_requires_restart():
    result = triage_gpu_error({"runtime_error": {"kind": "cudaErrorIllegalAddress"}})
    assert result.tier == "runtime"
    assert result.prompt_name == "GPU_HEAL_RUNTIME_PROMPT"
    assert result.requires_restart

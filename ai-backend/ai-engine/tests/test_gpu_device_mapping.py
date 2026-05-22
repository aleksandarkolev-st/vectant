from agents.gpu_device_mapping import build_device_mapping_report, extract_kernel_regions


def test_extract_kernel_regions_records_body_spans():
    source = '__global__ void flow(float* x, int n) {\n  x[0] += 1.0f;\n}\n'

    regions = extract_kernel_regions(source)

    assert set(regions) == {"flow"}
    body = source[regions["flow"].body_start : regions["flow"].body_end]
    assert "x[0] += 1.0f;" in body
    assert regions["flow"].signature_hash.startswith("0x")


def test_build_device_mapping_report_maps_user_kernel_to_internal_role():
    source = {
        "src/gpu/flow.hip": """
__constant__ float gain[1];
__global__ void flow(float* x, int n) {
  x[0] += gain[0];
}
"""
    }
    generated = {
        ".synthi/generated/gpu/device.hip": """
extern "C" __global__ void flow(float* x, int n) {
  x[0] += gain[0];
}
"""
    }
    manifest = {
        "module_files": {"device": ".synthi/generated/gpu/device.hip"},
        "files": [".synthi/generated/gpu/device.hip"],
    }

    report = build_device_mapping_report(
        source_files=source,
        generated_files=generated,
        manifest=manifest,
    )

    assert report["schemaVersion"] == "synthi.gpu.device_mapping.v1"
    assert report["mappingStatus"] == "mapped"
    assert report["generatedDevicePath"] == ".synthi/generated/gpu/device.hip"
    assert report["deviceMappings"][0]["sourcePath"] == "src/gpu/flow.hip"
    assert report["deviceMappings"][0]["generatedPath"] == ".synthi/generated/gpu/device.hip"
    assert report["sourceBaselineContents"]["src/gpu/flow.hip"].lstrip().startswith("__constant__")
    assert report["kernelSignatureHashes"]["flow"].startswith("0x")
    assert "generated:device" in report["constantGlobalLayoutHashes"]


def test_build_device_mapping_report_records_unmapped_kernel():
    report = build_device_mapping_report(
        source_files={"src/gpu/flow.hip": "__global__ void missing(float* x) {}"},
        generated_files={".synthi/generated/gpu/device.hip": "__global__ void other(float* x) {}"},
        manifest={"module_files": {"device": ".synthi/generated/gpu/device.hip"}},
    )

    assert report["mappingStatus"] == "missing"
    assert report["deviceMappings"] == []
    assert report["unmappedKernels"][0]["reason"] == "generated_kernel_missing"


def test_build_device_mapping_report_records_device_reachable_header_baselines():
    source = {
        "src/gpu/flow.hip": """
#include "flow.cuh"
__global__ void flow(float* x, int n) {
  x[0] += helper_gain<float>();
}
""",
        "src/gpu/flow.cuh": """
#pragma once
#include "../math/gain.hpp"
template <typename T>
__device__ T helper_gain() { return static_cast<T>(scale::kGain); }
""",
        "src/math/gain.hpp": """
#pragma once
namespace scale { constexpr float kGain = 2.0f; }
""",
        "src/unused/not_reachable.hpp": "constexpr int kUnused = 1;",
    }
    generated = {
        ".synthi/generated/gpu/device.hip": """
extern "C" __global__ void flow(float* x, int n) {
  x[0] += helper_gain<float>();
}
"""
    }

    report = build_device_mapping_report(
        source_files=source,
        generated_files=generated,
        manifest={"module_files": {"device": ".synthi/generated/gpu/device.hip"}},
    )

    assert report["sourceBaselineContents"]["src/gpu/flow.hip"].lstrip().startswith("#include")
    assert "src/gpu/flow.cuh" in report["sourceBaselineContents"]
    assert "src/math/gain.hpp" in report["sourceBaselineContents"]
    assert "src/unused/not_reachable.hpp" not in report["sourceBaselineContents"]
    assert report["deviceIncludeGraph"]["status"] == "bounded"
    assert report["deviceIncludeGraph"]["reachableHeaders"] == [
        "src/gpu/flow.cuh",
        "src/math/gain.hpp",
    ]


def test_build_device_mapping_report_records_missing_device_include():
    report = build_device_mapping_report(
        source_files={
            "src/gpu/flow.hip": '#include "missing.cuh"\n__global__ void flow(float* x) {}'
        },
        generated_files={".synthi/generated/gpu/device.hip": "__global__ void flow(float* x) {}"},
        manifest={"module_files": {"device": ".synthi/generated/gpu/device.hip"}},
    )

    assert report["deviceIncludeGraph"]["status"] == "missing_includes"
    assert report["deviceIncludeGraph"]["missingIncludes"] == [
        {"source": "src/gpu/flow.hip", "include": "missing.cuh"}
    ]
    assert report["deviceIncludeGraph"]["reasonCodes"] == ["include_not_found"]

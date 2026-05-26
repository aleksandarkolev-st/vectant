from agents.gpu_device_mapping import build_device_mapping_report, extract_kernel_regions


def test_extract_kernel_regions_records_body_spans():
    source = '__global__ void flow(float* x, int n) {\n  x[0] += 1.0f;\n}\n'

    regions = extract_kernel_regions(source)

    assert set(regions) == {"flow"}
    body = source[regions["flow"].body_start : regions["flow"].body_end]
    assert "x[0] += 1.0f;" in body
    assert regions["flow"].signature_hash.startswith("0x")
    assert regions["flow"].qualified_name == "flow"
    assert regions["flow"].namespace_path == ""
    assert regions["flow"].source_span_hash


def test_extract_kernel_regions_records_namespace_identity():
    source = """
namespace gpu::kernels {
constexpr const char* debug_brace = "}";
__global__ void shade(float* x) {
  x[0] += 1.0f;
}
}
"""

    regions = extract_kernel_regions(source)

    assert set(regions) == {"shade"}
    assert regions["shade"].qualified_name == "gpu::kernels::shade"
    assert regions["shade"].namespace_path == "gpu::kernels"
    assert regions["shade"].source_span.startswith(str(source.index("__global__")))


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
    assert report["deviceMappings"][0]["qualifiedSourceName"] == "flow"
    assert report["deviceMappings"][0]["sourceSpanHash"]
    assert report["sourceBaselineContents"]["src/gpu/flow.hip"].lstrip().startswith("__constant__")
    assert report["kernelSignatureHashes"]["flow"].startswith("0x")
    assert "generated:device" in report["constantGlobalLayoutHashes"]


def test_build_device_mapping_report_records_namespace_symbol_identity():
    source = {
        "src/gpu/shade.hip": """
namespace gpu::kernels {
__global__ void shade(float* x) {
  x[0] += 1.0f;
}
}
"""
    }
    generated = {
        ".synthi/generated/gpu/device.hip": """
namespace gpu::kernels {
extern "C" __global__ void shade(float* x) {
  x[0] += 1.0f;
}
}
"""
    }

    report = build_device_mapping_report(
        source_files=source,
        generated_files=generated,
        manifest={"module_files": {"device": ".synthi/generated/gpu/device.hip"}},
    )

    mapping = report["deviceMappings"][0]
    assert mapping["symbol"] == "shade"
    assert mapping["qualifiedSourceName"] == "gpu::kernels::shade"
    assert mapping["namespacePath"] == "gpu::kernels"
    assert mapping["sourceSpan"]
    assert mapping["sourceSpanHash"]


def test_build_device_mapping_report_rejects_duplicate_source_symbol_identity():
    source = {
        "src/gpu/shade.hip": """
namespace primary {
__global__ void shade(float* x) { x[0] += 1.0f; }
}
namespace secondary {
__global__ void shade(float* x) { x[0] += 2.0f; }
}
"""
    }
    generated = {
        ".synthi/generated/gpu/device.hip": """
namespace primary {
extern "C" __global__ void shade(float* x) { x[0] += 1.0f; }
}
namespace secondary {
extern "C" __global__ void shade(float* x) { x[0] += 2.0f; }
}
"""
    }

    report = build_device_mapping_report(
        source_files=source,
        generated_files=generated,
        manifest={"module_files": {"device": ".synthi/generated/gpu/device.hip"}},
    )

    assert report["deviceMappings"] == []
    assert {item["reason"] for item in report["unmappedKernels"]} == {
        "ambiguous_source_symbol_identity"
    }
    assert {
        item["qualifiedSourceName"] for item in report["unmappedKernels"]
    } == {"primary::shade", "secondary::shade"}


def test_build_device_mapping_report_rejects_duplicate_generated_symbol_identity():
    source = {
        "src/gpu/shade.hip": """
__global__ void shade(float* x) { x[0] += 1.0f; }
"""
    }
    generated = {
        ".synthi/generated/gpu/device.hip": """
namespace primary {
extern "C" __global__ void shade(float* x) { x[0] += 1.0f; }
}
namespace secondary {
extern "C" __global__ void shade(float* x) { x[0] += 1.0f; }
}
"""
    }

    report = build_device_mapping_report(
        source_files=source,
        generated_files=generated,
        manifest={"module_files": {"device": ".synthi/generated/gpu/device.hip"}},
    )

    assert report["deviceMappings"] == []
    assert report["unmappedKernels"] == [
        {
            "sourcePath": "src/gpu/shade.hip",
            "symbol": "shade",
            "qualifiedSourceName": "shade",
            "reason": "ambiguous_generated_symbol_identity",
        }
    ]


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


def test_build_device_mapping_report_treats_runtime_kernel_headers_as_device_sources():
    source = {
        "src/Device/kernels/CameraRays.h": """
#include "CameraCommon.h"
GLOBAL_KERNEL_SIGNATURE(void) __launch_bounds__(64)
CameraRays(HIPRTRenderData render_data) {
  render_data.random_number += kCameraGain;
}
""",
        "src/Device/kernels/CameraCommon.h": "#pragma once\nconstexpr int kCameraGain = 1;\n",
    }
    generated = {
        ".synthi/generated/gpu/device.hip": """
extern "C" __global__ void CameraRays(HIPRTRenderData render_data) {
  render_data.random_number += kCameraGain;
}
"""
    }

    report = build_device_mapping_report(
        source_files=source,
        generated_files=generated,
        manifest={"module_files": {"device": ".synthi/generated/gpu/device.hip"}},
    )

    assert report["sourceBaselineContents"]["src/Device/kernels/CameraRays.h"].lstrip().startswith("#include")
    assert "src/Device/kernels/CameraCommon.h" in report["sourceBaselineContents"]
    assert report["deviceMappings"][0]["sourcePath"] == "src/Device/kernels/CameraRays.h"
    assert report["deviceMappings"][0]["symbol"] == "CameraRays"


def test_build_device_mapping_report_records_generated_source_include_bridge():
    source = {
        "src/Device/kernels/CameraRays.h": """
GLOBAL_KERNEL_SIGNATURE(void) __launch_bounds__(64)
CameraRays(HIPRTRenderData render_data) {
  render_data.random_number += kCameraGain;
}
""",
        "src/Device/kernels/CameraCommon.h": "#pragma once\nconstexpr int kCameraGain = 1;\n",
    }
    generated = {
        ".synthi/generated/gpu/device.hip": """
#define __KERNELCC__ 1
#include "src/Device/kernels/CameraRays.h"
"""
    }

    report = build_device_mapping_report(
        source_files=source,
        generated_files=generated,
        manifest={"module_files": {"device": ".synthi/generated/gpu/device.hip"}},
    )

    assert report["mappingStatus"] == "mapped"
    assert report["deviceMappings"][0]["sourcePath"] == "src/Device/kernels/CameraRays.h"
    assert report["deviceMappings"][0]["symbol"] == "CameraRays"
    assert (
        report["deviceMappings"][0]["mappingConfidence"]
        == "generated_include_bridge_same_source"
    )
    assert report["deviceMappings"][0]["generatedMappingMode"] == "source_include_bridge"
    assert report["kernelSignatureHashes"]["CameraRays"].startswith("0x")
    assert report["deviceIncludeGraph"]["generatedDeviceIncludes"] == [
        "src/Device/kernels/CameraRays.h"
    ]
    assert "src/Device/kernels/CameraRays.h" in report["deviceIncludeGraph"]["deviceTranslationUnits"]
    assert report["sourceBaselineContents"]["src/Device/kernels/CameraRays.h"].lstrip().startswith(
        "GLOBAL_KERNEL_SIGNATURE"
    )


def test_build_device_mapping_report_maps_macro_kernel_translation_units():
    source = {
        "src/Device/kernels/CameraRays.hip": """
GLOBAL_KERNEL_SIGNATURE(void) CameraRays(HIPRTRenderData render_data) {
  render_data.random_number += 1;
}
""",
    }
    generated = {
        ".synthi/generated/gpu/device.hip": """
extern "C" __global__ void CameraRays(HIPRTRenderData render_data) {
  render_data.random_number += 1;
}
"""
    }

    report = build_device_mapping_report(
        source_files=source,
        generated_files=generated,
        manifest={"module_files": {"device": ".synthi/generated/gpu/device.hip"}},
    )

    assert report["mappingStatus"] == "mapped"
    assert report["deviceMappings"][0]["sourcePath"] == "src/Device/kernels/CameraRays.hip"
    assert report["deviceMappings"][0]["symbol"] == "CameraRays"


def test_build_device_mapping_report_tracks_generic_macro_device_translation_unit():
    source = {
        "src/gpu/helper.hip": """
PROJECT_DEVICE float helper_gain(float value) {
  return value * 2.0f;
}
""",
    }
    generated = {
        ".synthi/generated/gpu/device.hip": "",
    }

    report = build_device_mapping_report(
        source_files=source,
        generated_files=generated,
        manifest={"module_files": {"device": ".synthi/generated/gpu/device.hip"}},
    )

    assert "src/gpu/helper.hip" in report["sourceBaselineContents"]
    assert report["deviceIncludeGraph"]["deviceTranslationUnits"] == ["src/gpu/helper.hip"]
    assert report["deviceMappings"] == []
    assert report["unmappedKernels"] == []


def test_build_device_mapping_report_walks_transitive_generated_include_bridge():
    source = {
        "src/Device/bridge.h": '#include "kernels/CameraRays.h"\n',
        "src/Device/kernels/CameraRays.h": """
GLOBAL_KERNEL_SIGNATURE(void) CameraRays(HIPRTRenderData render_data) {
  render_data.random_number += 1;
}
""",
    }
    generated = {
        ".synthi/generated/gpu/device.hip": """
#define __KERNELCC__ 1
#include "src/Device/bridge.h"
"""
    }

    report = build_device_mapping_report(
        source_files=source,
        generated_files=generated,
        manifest={"module_files": {"device": ".synthi/generated/gpu/device.hip"}},
    )

    assert report["mappingStatus"] == "mapped"
    assert report["deviceMappings"][0]["sourcePath"] == "src/Device/kernels/CameraRays.h"
    assert report["deviceMappings"][0]["generatedMappingMode"] == "source_include_bridge"
    assert report["deviceIncludeGraph"]["generatedDeviceIncludes"] == [
        "src/Device/kernels/CameraRays.h"
    ]


def test_build_device_mapping_report_handles_preprocessor_split_kernel_signature():
    source = {
        "src/Device/kernels/CameraRays.h": """
#ifdef __KERNELCC__
GLOBAL_KERNEL_SIGNATURE(void) __launch_bounds__(64) CameraRays(HIPRTRenderData render_data)
#else
GLOBAL_KERNEL_SIGNATURE(void) inline CameraRays(HIPRTRenderData render_data, int x, int y)
#endif
{
  render_data.random_number += 1;
}
""",
    }
    generated = {
        ".synthi/generated/gpu/device.hip": """
#define __KERNELCC__ 1
#include "src/Device/kernels/CameraRays.h"
"""
    }

    report = build_device_mapping_report(
        source_files=source,
        generated_files=generated,
        manifest={"module_files": {"device": ".synthi/generated/gpu/device.hip"}},
    )

    assert report["mappingStatus"] == "mapped"
    assert report["deviceMappings"][0]["sourcePath"] == "src/Device/kernels/CameraRays.h"
    assert report["deviceMappings"][0]["symbol"] == "CameraRays"
    assert report["deviceMappings"][0]["generatedMappingMode"] == "source_include_bridge"
    assert report["sourceBaselineContents"]["src/Device/kernels/CameraRays.h"].lstrip().startswith(
        "#ifdef"
    )


def test_build_device_mapping_report_ignores_commented_kernel_examples():
    report = build_device_mapping_report(
        source_files={
            "src/Device/includes/FixIntellisense.h": """
            // extern "C" void __global__ my_function(...)
            /* GLOBAL_KERNEL_SIGNATURE(void) FakeKernel(RenderData data) {} */
            """
        },
        generated_files={".synthi/generated/gpu/device.hip": ""},
        manifest={"module_files": {"device": ".synthi/generated/gpu/device.hip"}},
    )

    assert report["deviceMappings"] == []
    assert report["unmappedKernels"] == []
    assert "src/Device/includes/FixIntellisense.h" not in report["sourceBaselineContents"]


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

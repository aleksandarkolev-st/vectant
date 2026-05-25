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


def test_source_device_file_detection_uses_generic_device_macro():
    source_files = {
        "include/device_callbacks.h": (
            "#pragma once\n"
            "PROJECT_DEVICE_API bool filter_value(int value);\n"
            "GENERIC_GPU_DEVICE inline int helper(int value) { return value + 1; }\n"
        ),
        "include/host_only.h": "inline int host_helper(int value) { return value; }\n",
    }

    assert "include/device_callbacks.h" in repair_source_device_files(source_files)
    assert "include/device_callbacks.h" in verifier_source_device_files(source_files)
    assert "include/host_only.h" not in repair_source_device_files(source_files)
    assert "include/host_only.h" not in verifier_source_device_files(source_files)

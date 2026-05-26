import pytest

from gpu_hmr.canonical import (
    GPU_HMR_IDENTITY_POLICY,
    CanonicalizationError,
    canonical_hash,
    canonical_json_bytes,
    canonicalize,
)


def test_canonical_json_sorts_object_keys_without_reordering_ordered_arrays():
    left = {"b": 2, "a": {"z": [3, 2, 1], "m": "x"}}
    right = {"a": {"m": "x", "z": [3, 2, 1]}, "b": 2}

    assert canonical_json_bytes(left) == canonical_json_bytes(right)
    assert canonical_hash(left) == canonical_hash(right)
    assert canonicalize(left)["a"]["z"] == [3, 2, 1]


def test_gpu_identity_policy_normalizes_paths_text_and_unordered_reason_codes():
    first = {
        "sourcePath": ".\\src\\gpu\\..\\gpu\\flow.hip",
        "sourceText": "float caf\u00e9 = 1.0f;\r\n",
        "reasonCodes": ["abi.kernel_signature_unchanged", "edit.kernel_body_only"],
    }
    second = {
        "sourcePath": "src/gpu/flow.hip",
        "sourceText": "float cafe\u0301 = 1.0f;\n",
        "reasonCodes": ["edit.kernel_body_only", "abi.kernel_signature_unchanged"],
    }

    assert canonicalize(first, policy=GPU_HMR_IDENTITY_POLICY)["sourcePath"] == "src/gpu/flow.hip"
    assert canonical_hash(first, policy=GPU_HMR_IDENTITY_POLICY) == canonical_hash(
        second,
        policy=GPU_HMR_IDENTITY_POLICY,
    )


def test_gpu_identity_policy_rejects_paths_outside_workspace():
    with pytest.raises(CanonicalizationError):
        canonical_hash({"path": "../outside.hip"}, policy=GPU_HMR_IDENTITY_POLICY)

    with pytest.raises(CanonicalizationError):
        canonical_hash({"path": "C:\\repo\\src\\gpu\\flow.hip"}, policy=GPU_HMR_IDENTITY_POLICY)


def test_gpu_identity_policy_filters_and_redacts_environment():
    material = {
        "environment": {
            "SYNTHI_GPU_ARCH": "gfx1201",
            "AI_ENGINE_AUTH_TOKEN": "secret",
            "UNRELATED": "ignored",
        }
    }

    canonical = canonicalize(material, policy=GPU_HMR_IDENTITY_POLICY)

    assert canonical["environment"] == {"SYNTHI_GPU_ARCH": "gfx1201"}


def test_source_split_identity_fixture_hash_is_stable():
    material = {
        "schemaVersion": "gpu-hmr-source-split-identity-v1",
        "workspaceRootDigest": "root",
        "gitCommit": "abc",
        "dirtyTreeHash": "clean",
        "targetInputFileHash": "in",
        "buildConfigInputHash": "cfg",
        "generatedHeaderContentHash": "gen",
        "buildSelectionEnvironmentHash": "env",
        "selectedTargetIdentityHash": "target",
        "codeIntelGeneration": "42",
        "splitSchemaVersion": "split-v1",
        "promptSchemaVersion": "prompt-v1",
        "reasonCodes": ["b", "a"],
        "entryFile": ".\\src\\app\\main.cpp",
    }

    assert (
        canonical_hash(material, policy=GPU_HMR_IDENTITY_POLICY)
        == "063c3b15e3d87e95110ff2cdf153c20cfb1f3e90bc66ead7b535c8c512890140"
    )

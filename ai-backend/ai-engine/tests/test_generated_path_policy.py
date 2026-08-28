import json
from pathlib import Path

import pytest

from generated_path_policy import (
    GeneratedPathViolation,
    normalize_generated_path_list,
    normalize_generated_path_mapping,
    normalize_generated_relative_path,
)


_CONFORMANCE_CASES_PATH = (
    Path(__file__).resolve().parents[3]
    / "test-fixtures"
    / "gpu-hmr"
    / "generated-path-policy-v1.json"
)


@pytest.mark.parametrize(
    ("path", "reason_code"),
    [
        ("/absolute/unit", "generated.absolute_path_rejected"),
        (r"C:\workspace\unit", "generated.absolute_path_rejected"),
        (r"\\server\share\unit", "generated.absolute_path_rejected"),
        ("../escape/unit", "generated.path_traversal_rejected"),
        ("nested/../escape", "generated.path_traversal_rejected"),
        ("unit:stream", "generated.invalid_path_rejected"),
        ("unit\x00source", "generated.invalid_path_rejected"),
    ],
)
def test_generated_path_policy_rejects_unscoped_paths(path, reason_code):
    with pytest.raises(GeneratedPathViolation) as caught:
        normalize_generated_relative_path(path)
    assert caught.value.reason_code == reason_code


def test_generated_path_policy_accepts_opaque_relative_paths():
    assert normalize_generated_relative_path("objects/alpha.payload") == "objects/alpha.payload"


def test_generated_path_policy_rejects_case_and_unicode_aliases():
    with pytest.raises(GeneratedPathViolation) as case_collision:
        normalize_generated_path_mapping({"Units/A": "first", "units/a": "second"})
    assert case_collision.value.reason_code == "generated.case_collision_rejected"

    with pytest.raises(GeneratedPathViolation) as unicode_collision:
        normalize_generated_path_mapping({"caf\u00e9/unit": "first", "cafe\u0301/unit": "second"})
    assert unicode_collision.value.reason_code == "generated.case_collision_rejected"


def test_generated_reference_policy_allows_only_exact_duplicate_spelling():
    assert normalize_generated_path_list(
        ["objects/device.hip", "objects/device.hip"],
        allow_exact_duplicates=True,
    ) == ["objects/device.hip", "objects/device.hip"]

    with pytest.raises(GeneratedPathViolation):
        normalize_generated_path_list(
            ["objects/device.hip", "./objects/device.hip"],
            allow_exact_duplicates=True,
        )


def test_generated_path_policy_matches_shared_conformance_corpus():
    corpus = json.loads(_CONFORMANCE_CASES_PATH.read_text(encoding="utf-8"))
    assert corpus["schema"] == "synthi.generated_path_policy.conformance.v1"

    for case in corpus["valid"]:
        assert normalize_generated_relative_path(case["input"]) == case["normalized"]

    for case in corpus["invalid"]:
        with pytest.raises(GeneratedPathViolation):
            normalize_generated_relative_path(case["input"])

    for case in corpus["collisions"]:
        with pytest.raises(GeneratedPathViolation) as collision:
            normalize_generated_path_mapping(dict.fromkeys(case["inputs"], "payload"))
        assert collision.value.reason_code == "generated.case_collision_rejected"

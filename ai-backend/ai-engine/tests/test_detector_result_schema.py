from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shadow.detector_results import detector_results_from_evidence, has_failed_hard_gate


def test_detector_result_schema_marks_failed_tests_as_hard_gate():
    detectors = detector_results_from_evidence(
        "br_1",
        {
            "diagnostics": {
                "lint": "clean",
                "types": "clean",
                "tests": "1/2 passed",
                "runtime": "clean",
            },
            "attacks": {"tested": 0, "survived": 0, "failed": []},
        },
    )

    assert has_failed_hard_gate(detectors)
    unit = next(d for d in detectors if d.detector_kind.value == "unit_tests")
    assert unit.to_dict()["status"] == "failed"


def test_visual_snapshot_detector_preserves_artifact_reference():
    detectors = detector_results_from_evidence(
        "br_1",
        {
            "diagnostics": {"lint": "clean", "types": "clean", "tests": "1/1 passed", "runtime": "clean"},
            "attacks": {"tested": 0, "survived": 0, "failed": []},
            "visual_proof": {
                "screenshot_sha256": "abc123",
                "raw_artifact_ref": "artifacts/shadow/A.png",
                "viewport": "desktop",
            },
        },
    )

    visual = next(d for d in detectors if d.detector_kind.value == "visual_snapshot")
    assert visual.status.value == "passed"
    assert visual.raw_artifact_ref == "artifacts/shadow/A.png"

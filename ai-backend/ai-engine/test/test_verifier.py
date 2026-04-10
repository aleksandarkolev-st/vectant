"""Regression tests for AIOutputVerifier."""

from verifier import AIOutputVerifier, VerificationStatus, ViolationType


def test_verify_flags_placeholder_code():
    verifier = AIOutputVerifier(raise_on_failure=False)

    result = verifier.verify("function demo() {\n  // ...\n}\n", lang="javascript")

    assert result.status == VerificationStatus.FAIL
    assert any(v.type == ViolationType.INCOMPLETE_CODE for v in result.violations)


def test_verify_split_result_does_not_crash_on_placeholder_module():
    verifier = AIOutputVerifier(raise_on_failure=False)

    result = verifier.verify_split_result(
        {
            "moduleA": {
                "filename": "moduleA.js",
                "content": "export function demo() {\n  // ...\n}\n",
            }
        },
        original_code="export function demo() {\n  return 1;\n}\n",
        lang="javascript",
    )

    assert result.status == VerificationStatus.FAIL
    assert any(v.type == ViolationType.INCOMPLETE_CODE for v in result.violations)
import pytest

from code_intel.core.types import compute_body_fingerprint


def test_fingerprint_whitespace_only():
    a = "def foo(x):\n    return x + 1\n"
    b = "def foo( x ):\n\n\treturn  x+1\n"
    assert compute_body_fingerprint(a) == compute_body_fingerprint(b)


def test_fingerprint_comment_only():
    a = "def foo(x):\n    return x + 1\n"
    b = "def foo(x):\n    # comment\n    return x + 1  # trailing\n"
    assert compute_body_fingerprint(a) == compute_body_fingerprint(b)


def test_fingerprint_identifier_rename():
    a = "def foo(x):\n    return x + 1\n"
    b = "def foo(y):\n    return y + 1\n"
    assert compute_body_fingerprint(a) == compute_body_fingerprint(b)


def test_fingerprint_literal_change():
    a = "def foo(x):\n    return x + 1\n"
    b = "def foo(x):\n    return x + 2\n"
    assert compute_body_fingerprint(a) == compute_body_fingerprint(b)


def test_fingerprint_string_literal_change():
    a = "def foo(x):\n    return 'a'\n"
    b = "def foo(x):\n    return 'b'\n"
    assert compute_body_fingerprint(a) == compute_body_fingerprint(b)

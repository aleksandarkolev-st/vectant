import pytest
from parser import safe_int


def test_parses_integer():
    assert safe_int("42") == 42


def test_rejects_expression():
    with pytest.raises(ValueError):
        safe_int("1 + 1")


def test_rejects_function_call():
    with pytest.raises(ValueError):
        safe_int("__import__('os').system('echo p0wned')")


def test_rejects_float():
    with pytest.raises(ValueError):
        safe_int("3.14")

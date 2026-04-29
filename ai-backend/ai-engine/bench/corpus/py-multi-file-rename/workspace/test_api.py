from api import authorize
from auth import is_token_valid


def test_authorize_ok():
    assert authorize("longtoken123") == "ok"


def test_authorize_denied():
    assert authorize("short") == "denied"


def test_is_token_valid():
    assert is_token_valid("longtoken123")
    assert not is_token_valid("short")

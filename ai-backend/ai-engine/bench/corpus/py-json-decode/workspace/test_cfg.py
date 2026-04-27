from cfg import load_config


def test_valid_json():
    assert load_config('{"a": 1}') == {"a": 1}


def test_invalid_returns_empty():
    assert load_config("not-json") == {}


def test_empty_returns_empty():
    assert load_config("") == {}

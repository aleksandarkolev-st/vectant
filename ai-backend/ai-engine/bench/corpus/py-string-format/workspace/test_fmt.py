from fmt import format_user


def test_default_age():
    assert format_user("Alice") == "Alice: unknown"


def test_explicit_age():
    assert format_user("Bob", age=30) == "Bob: 30"

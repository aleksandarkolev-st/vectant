from dedup import first_duplicate


def test_returns_first_repeat():
    assert first_duplicate([1, 2, 3, 2, 4]) == 2


def test_no_duplicates():
    assert first_duplicate([1, 2, 3]) is None


def test_empty():
    assert first_duplicate([]) is None


def test_strings():
    assert first_duplicate(["a", "b", "c", "b", "a"]) == "b"

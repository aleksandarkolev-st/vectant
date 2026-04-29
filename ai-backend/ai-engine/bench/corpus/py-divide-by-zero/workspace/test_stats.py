from stats import average


def test_non_empty():
    assert average([2, 4, 6]) == 4


def test_single():
    assert average([7]) == 7


def test_empty_returns_zero():
    assert average([]) == 0.0


def test_all_zeros():
    assert average([0, 0, 0]) == 0

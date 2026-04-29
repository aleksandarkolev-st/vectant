from sums import sum_to


def test_small():
    assert sum_to(5) == 15


def test_zero():
    assert sum_to(0) == 0


def test_negative():
    assert sum_to(-3) == 0


def test_large_does_not_recurse():
    # Default sys.recursionlimit is 1000.
    assert sum_to(2000) == 2001000

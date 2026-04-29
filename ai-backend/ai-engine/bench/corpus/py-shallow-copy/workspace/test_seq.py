from seq import without_first


def test_returns_tail():
    assert without_first([1, 2, 3]) == [2, 3]


def test_input_unchanged():
    src = [1, 2, 3]
    without_first(src)
    assert src == [1, 2, 3]


def test_single():
    assert without_first([7]) == []

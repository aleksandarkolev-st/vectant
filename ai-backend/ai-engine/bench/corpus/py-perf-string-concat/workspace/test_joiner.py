from joiner import join_lines


def test_basic():
    assert join_lines(["a", "b", "c"]) == "a\nb\nc\n"


def test_empty():
    assert join_lines([]) == ""


def test_single():
    assert join_lines(["only"]) == "only\n"

from cart import add_item


def test_first_call_one_item():
    assert add_item("a") == ["a"]


def test_second_call_does_not_share_state():
    assert add_item("b") == ["b"]


def test_explicit_basket_reused():
    bag = []
    add_item("x", bag)
    add_item("y", bag)
    assert bag == ["x", "y"]

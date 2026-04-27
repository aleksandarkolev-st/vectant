from inventory import total_value


def test_basic():
    rows = [{"quantity": "3", "unit_price": "2.50"}, {"quantity": "4", "unit_price": "1.25"}]
    assert total_value(rows) == 12.5


def test_empty():
    assert total_value([]) == 0.0

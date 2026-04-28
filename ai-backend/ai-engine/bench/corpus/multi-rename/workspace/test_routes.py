from routes import user_route
from users import find_user_by_id


def test_known_user():
    assert user_route(1) == {"status": 200, "user": "alice"}


def test_unknown_user():
    assert user_route(99) == {"status": 404}


def test_module_exposes_new_name():
    assert callable(find_user_by_id)
    assert find_user_by_id(2) == "bob"

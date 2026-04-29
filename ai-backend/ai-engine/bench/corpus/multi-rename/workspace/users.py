_USERS = {1: "alice", 2: "bob", 3: "carol"}


def getUserById(user_id):
    return _USERS.get(user_id)

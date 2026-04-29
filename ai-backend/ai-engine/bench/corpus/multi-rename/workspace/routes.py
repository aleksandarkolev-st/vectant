from users import getUserById


def user_route(user_id):
    user = getUserById(user_id)
    if user is None:
        return {"status": 404}
    return {"status": 200, "user": user}

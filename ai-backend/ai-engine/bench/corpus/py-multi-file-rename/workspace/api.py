from auth import chk_token


def authorize(token: str) -> str:
    return "ok" if chk_token(token) else "denied"

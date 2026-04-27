"""Auth utilities. The team decided to rename `chk_token` to
`is_token_valid` for readability — the only call site is in api.py.
"""


def chk_token(token: str) -> bool:
    return isinstance(token, str) and len(token) >= 8

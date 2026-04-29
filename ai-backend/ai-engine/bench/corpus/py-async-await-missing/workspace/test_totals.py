import asyncio
from totals import fetch_total


def test_fetch_total_returns_int():
    result = asyncio.run(fetch_total())
    assert result == 5


def test_fetch_total_is_not_a_coroutine():
    result = asyncio.run(fetch_total())
    assert isinstance(result, int)

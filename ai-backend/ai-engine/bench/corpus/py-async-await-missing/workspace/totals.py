import asyncio


async def get_a():
    await asyncio.sleep(0)
    return 2


async def get_b():
    await asyncio.sleep(0)
    return 3


async def fetch_total():
    a = await get_a()
    b = get_b()  # bug: missing await — returns a coroutine
    return a + b

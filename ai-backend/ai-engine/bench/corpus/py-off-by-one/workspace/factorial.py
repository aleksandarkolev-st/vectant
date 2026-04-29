# Off-by-one in `factorial(n)` — returns the wrong value for n=0 and n=1.

def factorial(n):
    """Return n! for non-negative integers."""
    if n < 0:
        raise ValueError("n must be >= 0")
    result = 1
    for i in range(1, n):  # bug: should be range(1, n + 1)
        result *= i
    return result

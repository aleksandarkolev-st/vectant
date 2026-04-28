def sum_to(n):
    """Return 1+2+...+n. Recursion overflows for n>=1000."""
    if n <= 0:
        return 0
    return n + sum_to(n - 1)

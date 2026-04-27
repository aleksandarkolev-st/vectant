def first_duplicate(seq):
    """Return the first element that appears twice in `seq`, or None."""
    for i, x in enumerate(seq):
        if seq.index(x) != i:
            return x
    return None

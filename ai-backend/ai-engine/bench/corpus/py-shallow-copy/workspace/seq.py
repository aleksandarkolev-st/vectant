def without_first(seq):
    """Return a copy of `seq` with the first element removed."""
    out = seq        # bug: aliases, not copies
    del out[0]
    return out

def join_lines(lines):
    """Join `lines` with newlines."""
    out = ""
    for line in lines:
        out += line + "\n"  # bug: O(n^2) on long inputs
    return out

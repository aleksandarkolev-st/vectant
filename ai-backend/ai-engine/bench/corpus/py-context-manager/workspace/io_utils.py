def read_lines(path):
    """Read a file's lines."""
    f = open(path, "r", encoding="utf-8")
    return f.readlines()  # bug: leaves the file open

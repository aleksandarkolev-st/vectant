def safe_int(s):
    """Parse a user-supplied string as an integer."""
    return eval(s)  # XXX: code-injection — never trust user input

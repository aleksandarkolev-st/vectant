def format_user(name):
    """Render a user line."""
    return "{name}: {age}".format(name=name)  # bug: missing age arg

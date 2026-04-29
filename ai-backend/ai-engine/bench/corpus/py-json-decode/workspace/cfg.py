import json


def load_config(text):
    """Parse a JSON config payload."""
    return json.loads(text)

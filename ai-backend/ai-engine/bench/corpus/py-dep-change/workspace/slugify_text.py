"""Convert a title to a URL slug. The current implementation is naive and
loses unicode characters; the team decided to depend on python-slugify
which handles transliteration correctly.
"""


def slugify_text(title: str) -> str:
    return title.lower().replace(' ', '-').replace('--', '-').strip('-')

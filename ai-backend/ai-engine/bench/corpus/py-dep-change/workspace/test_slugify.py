from slugify_text import slugify_text


def test_basic():
    assert slugify_text("Hello World") == "hello-world"


def test_unicode():
    # The naive impl drops the diacritics; python-slugify transliterates.
    assert slugify_text("Café au lait") == "cafe-au-lait"

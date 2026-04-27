import flags
from theme import current_theme


def test_default_light():
    flags.dark_mode = False
    assert current_theme() == "light"


def test_dark_mode_on():
    flags.dark_mode = True
    try:
        assert current_theme() == "dark"
    finally:
        flags.dark_mode = False


def test_flag_default_is_false():
    # Re-import semantics: a fresh process should start with dark_mode disabled.
    assert getattr(flags, "dark_mode", None) is False

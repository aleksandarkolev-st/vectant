import gc
import tempfile
import warnings

from io_utils import read_lines


def test_reads_lines(tmp_path):
    p = tmp_path / "x.txt"
    p.write_text("a\nb\n")
    assert read_lines(str(p)) == ["a\n", "b\n"]


def test_does_not_leak_file_handle(tmp_path):
    p = tmp_path / "y.txt"
    p.write_text("hello")
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always", ResourceWarning)
        read_lines(str(p))
        gc.collect()
        leaks = [w for w in caught if issubclass(w.category, ResourceWarning)]
        assert leaks == []
